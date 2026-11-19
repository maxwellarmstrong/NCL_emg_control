"""Train the isolated multi-task gesture CNN from a prepared NPZ dataset."""
import argparse
import copy
import json
import random
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from .labels import ID_TO_CLASS, MOTION_TARGETS, TARGET_SCALES
from .model import GestureCNN


def session_splits(session_ids, split_names):
    grouped = {name: set(session_ids[split_names == name]) for name in ("train", "val", "test")}
    if any(not values for values in grouped.values()):
        raise ValueError("Need complete recording sessions assigned to train, val, and test")
    if grouped["train"] & grouped["val"] or grouped["train"] & grouped["test"] or grouped["val"] & grouped["test"]:
        raise ValueError("A recording session appears in more than one split")
    return {name: np.flatnonzero(split_names == name) for name in grouped}, grouped


def masked_smooth_l1(predicted, target, mask):
    elementwise = nn.functional.smooth_l1_loss(predicted, target, reduction="none")
    mask = mask.to(elementwise.dtype)
    return (elementwise * mask).sum() / mask.sum().clamp_min(1.0)


def evaluate(model, arrays, indices, class_ids, class_names, motion_weight):
    x, class_index, motion, motion_mask = arrays
    model.eval()
    with torch.inference_mode():
        output = model(x[indices])
        class_loss = nn.functional.cross_entropy(output["movement_logits"], class_index[indices])
        motion_loss = masked_smooth_l1(output["motion"], motion[indices], motion_mask[indices])
        total_loss = class_loss + motion_weight * motion_loss
    predicted = output["movement_logits"].argmax(dim=1).cpu().numpy()
    actual = class_index[indices].cpu().numpy()
    report = {
        "loss": float(total_loss),
        "class_loss": float(class_loss),
        "motion_loss": float(motion_loss),
        "accuracy": float(accuracy_score(actual, predicted)),
        "macro_f1": float(f1_score(actual, predicted, average="macro", zero_division=0)),
        "confusion_matrix": confusion_matrix(actual, predicted, labels=list(range(len(class_ids)))).tolist(),
        "confusion_matrix_class_order": class_names,
    }
    truth = motion[indices].cpu().numpy()
    estimates = output["motion"].cpu().numpy()
    valid = motion_mask[indices].cpu().numpy().astype(bool)
    motion_mae = {}
    for column, target_name in enumerate(MOTION_TARGETS):
        if valid[:, column].any():
            scale = TARGET_SCALES[column] * (100.0 if column < 5 else 1.0)
            unit = "% flexion" if column < 5 else "degrees"
            motion_mae[target_name] = {"mae": float(np.abs(estimates[:, column] - truth[:, column])[valid[:, column]].mean() * scale),
                                       "unit": unit, "windows": int(valid[:, column].sum())}
        else:
            motion_mae[target_name] = {"mae": None, "unit": "% flexion" if column < 5 else "degrees", "windows": 0}
    report["motion_mae"] = motion_mae
    return report


def train(data_path, output_path, epochs=40, batch_size=64, seed=42, patience=8, motion_weight=1.0):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(2)
    with np.load(data_path, allow_pickle=False) as data:
        raw = data["x"].astype(np.float32)
        class_ids_all = data["class_id"].astype(np.int64)
        motion_all = data["motion"].astype(np.float32)
        mask_all = data["motion_mask"].astype(bool)
        sessions = data["session"].astype(str)
        splits = data["split"].astype(str)
        dataset_meta = json.loads(str(data["metadata"]))
    if raw.ndim != 3 or raw.shape[1] != 8 or raw.shape[2] != int(dataset_meta["window_samples"]):
        raise ValueError("Expected dataset inputs shaped [windows, 8, window_samples]")
    if motion_all.shape != (len(raw), len(MOTION_TARGETS)) or mask_all.shape != motion_all.shape:
        raise ValueError("Motion values and masks must contain seven camera targets per window")
    indices, split_sessions = session_splits(sessions, splits)
    class_ids = sorted(int(value) for value in np.unique(class_ids_all[indices["train"]]))
    if len(class_ids) < 2:
        raise ValueError("Training needs at least two movement classes; record both sides of a pair plus rest")
    unseen = sorted(set(np.unique(class_ids_all).tolist()) - set(class_ids))
    if unseen:
        raise ValueError(f"Movement classes {unseen} occur outside the training split; record each class in train")
    if not mask_all[indices["train"]].any():
        raise ValueError("No valid camera-angle targets in training windows; record visible hand or arm movement")
    class_names = [ID_TO_CLASS[class_id] for class_id in class_ids]
    class_to_position = {class_id: index for index, class_id in enumerate(class_ids)}
    class_index = np.asarray([class_to_position[int(class_id)] for class_id in class_ids_all], dtype=np.int64)

    channel_mean = raw[indices["train"]].mean(axis=(0, 2))
    channel_std = np.maximum(raw[indices["train"]].std(axis=(0, 2)), 1e-3)
    normalized = ((raw - channel_mean[None, :, None]) / channel_std[None, :, None]).astype(np.float32)
    tensors = [torch.from_numpy(array) for array in (normalized, class_index, motion_all, mask_all)]
    train_loader = DataLoader(TensorDataset(*(tensor[indices["train"]] for tensor in tensors)),
                              batch_size=batch_size, shuffle=True)
    train_counts = np.bincount(class_index[indices["train"]], minlength=len(class_ids)).astype(np.float32)
    weights = np.sqrt(train_counts.sum() / np.maximum(train_counts, 1))
    weights /= weights.mean()
    class_weights = torch.tensor(weights, dtype=torch.float32)

    model = GestureCNN(len(class_ids), len(MOTION_TARGETS))
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    arrays = tensors
    best_state, best_loss, best_epoch, stale, history = None, float("inf"), 0, 0, []
    for epoch in range(epochs):
        model.train()
        total, cls_total, motion_total = 0.0, 0.0, 0.0
        for batch_x, batch_class, batch_motion, batch_mask in train_loader:
            prediction = model(batch_x)
            cls_loss = nn.functional.cross_entropy(prediction["movement_logits"], batch_class, weight=class_weights)
            motion_loss = masked_smooth_l1(prediction["motion"], batch_motion, batch_mask)
            loss = cls_loss + motion_weight * motion_loss
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total += float(loss.detach()) * len(batch_x)
            cls_total += float(cls_loss.detach()) * len(batch_x)
            motion_total += float(motion_loss.detach()) * len(batch_x)
        validation = evaluate(model, arrays, indices["val"], class_ids, class_names, motion_weight)
        entry = {"epoch": epoch + 1, "train_loss": total / len(indices["train"]),
                 "train_class_loss": cls_total / len(indices["train"]),
                 "train_motion_loss": motion_total / len(indices["train"]),
                 "val_loss": validation["loss"], "val_macro_f1": validation["macro_f1"]}
        history.append(entry)
        print(json.dumps(entry), flush=True)
        if validation["loss"] < best_loss:
            best_loss, best_epoch, stale = validation["loss"], epoch + 1, 0
            best_state = copy.deepcopy(model.state_dict())
        else:
            stale += 1
            if stale >= patience:
                break
    if best_state is None:
        raise ValueError("No best checkpoint was selected")
    model.load_state_dict(best_state)
    test_metrics = evaluate(model, arrays, indices["test"], class_ids, class_names, motion_weight)
    model_meta = {
        "schema_version": 1,
        "model": "GestureCNN-multitask-v1",
        "class_ids": class_ids,
        "class_names": class_names,
        "motion_targets": list(MOTION_TARGETS),
        "target_scales": list(TARGET_SCALES),
        "channel_mean": channel_mean.tolist(),
        "channel_std": channel_std.tolist(),
        "channels": 8,
        "sample_rate_hz": dataset_meta["sample_rate_hz"],
        "window_ms": dataset_meta["window_ms"],
        "window_samples": dataset_meta["window_samples"],
        "hop_ms": dataset_meta["hop_ms"],
        "label_delay_ms": dataset_meta["label_delay_ms"],
        "filter": dataset_meta["filter"],
        "wiring": dataset_meta["wiring"],
        "best_epoch": best_epoch,
        "seed": seed,
        "motion_loss_weight": motion_weight,
        "split_sessions": {name: sorted(str(value) for value in values) for name, values in split_sessions.items()},
        "normalization": "Channel mean/std computed from training sessions only",
        "metrics": test_metrics,
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "metadata": model_meta}, output_path)
    report = {"metadata": model_meta, "history": history,
              "note": "Classification and camera-angle prediction are learned from EMG windows. Camera-only forearm/wrist angles are not available; those classes have no regression targets."}
    output_path.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(test_metrics, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("artifacts/gesture_cnn/dataset.npz"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/gesture_cnn/model.pt"))
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--motion-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train(args.data, args.output, args.epochs, args.batch_size, args.seed, args.patience, args.motion_weight)


if __name__ == "__main__":
    main()
