"""Session-held-out CNN and conventional baselines. Test set is evaluated once."""
import argparse
import copy
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import accuracy_score, confusion_matrix, r2_score
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from .model import FingerCNN


def handcrafted(x):
    return np.concatenate([np.mean(np.abs(x), axis=2), np.sqrt(np.mean(x * x, axis=2)),
                           np.mean(np.abs(np.diff(x, axis=2)), axis=2),
                           np.mean(np.diff(np.signbit(x), axis=2), axis=2)], axis=1)


def regression_metrics(y, predicted):
    delta = y - predicted
    return {"mae_per_finger": np.mean(np.abs(delta), axis=0).tolist(),
            "rmse_per_finger": np.sqrt(np.mean(delta * delta, axis=0)).tolist(),
            "r2_per_finger": r2_score(y, predicted, multioutput="raw_values").tolist()}


def split_indices(session, split):
    groups = {name: set(session[split == name]) for name in ("train", "val", "test")}
    if any(not g for g in groups.values()):
        raise ValueError("Need separate train, val, and test recording sessions")
    if groups["train"] & groups["val"] or groups["train"] & groups["test"] or groups["val"] & groups["test"]:
        raise ValueError("A recording session appears in multiple splits")
    return {name: np.flatnonzero(split == name) for name in groups}


def train(data_path, output, epochs=30, batch_size=64, seed=42):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(2)
    with np.load(data_path, allow_pickle=False) as data:
        raw, y, cls = data["x"], data["y"], data["class_id"].astype(np.int64)
        sessions, splits = data["session"], data["split"]
        meta = json.loads(str(data["metadata"]))
    ix = split_indices(sessions, splits)
    mean = raw[ix["train"]].mean(axis=(0, 2))
    std = np.maximum(raw[ix["train"]].std(axis=(0, 2)), 1e-3)
    x = ((raw - mean[None, :, None]) / std[None, :, None]).astype(np.float32)
    arrays = [torch.tensor(a) for a in (x, y, cls)]
    loader = DataLoader(TensorDataset(*(a[ix["train"]] for a in arrays)), batch_size=batch_size, shuffle=True)
    model = FingerCNN()
    optim = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    best, best_loss, history = None, float("inf"), []
    for epoch in range(epochs):
        model.train()
        total = 0.
        for bx, by, bc in loader:
            out = model(bx)
            loss = nn.functional.mse_loss(out["flexion"], by)
            certain = (by <= .15) | (by >= .4)
            binary = nn.functional.binary_cross_entropy_with_logits(out["active_logits"], (by >= .4).float(), reduction="none")
            loss += .2 * (binary * certain).sum() / certain.sum().clamp_min(1)
            if (bc >= 0).any():
                loss += .2 * nn.functional.cross_entropy(out["class_logits"], bc, ignore_index=-100)
            optim.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.)
            optim.step()
            total += float(loss.detach()) * len(bx)
        model.eval()
        with torch.inference_mode():
            val = model(arrays[0][ix["val"]])["flexion"]
            val_loss = float(nn.functional.mse_loss(val, arrays[1][ix["val"]]))
        history.append({"epoch": epoch + 1, "train_loss": total / len(ix["train"]), "val_mse": val_loss})
        print(json.dumps(history[-1]), flush=True)
        if val_loss < best_loss:
            best_loss, best = val_loss, copy.deepcopy(model.state_dict())
    if best is None:
        raise ValueError("Training requires at least one epoch")
    model.load_state_dict(best)
    model.eval()
    test = ix["test"]
    with torch.inference_mode():
        pred = model(arrays[0][test])
        for _ in range(5):
            model(arrays[0][:1])
        durations = []
        for _ in range(50):
            start = time.perf_counter()
            model(arrays[0][:1])
            durations.append((time.perf_counter() - start) * 1000)
    metrics = regression_metrics(y[test], pred["flexion"].numpy())
    certain = np.all((y[test] <= .15) | (y[test] >= .4), axis=1)
    metrics["multilabel_exact_match"] = float(np.mean(np.all((pred["active_logits"].numpy()[certain] >= 0) == (y[test][certain] >= .4), axis=1))) if certain.any() else None
    known = cls[test] >= 0
    metrics["six_class_accuracy"] = float(accuracy_score(cls[test][known], pred["class_logits"].argmax(1).numpy()[known])) if known.any() else None
    metrics["six_class_confusion"] = confusion_matrix(cls[test][known], pred["class_logits"].argmax(1).numpy()[known], labels=list(range(6))).tolist() if known.any() else None
    metrics["cnn_compute_ms_median"] = float(np.median(durations))
    metrics["cnn_compute_ms_p95"] = float(np.percentile(durations, 95))
    features = handcrafted(x)
    forest = RandomForestRegressor(n_estimators=100, min_samples_leaf=3, random_state=seed, n_jobs=2)
    forest.fit(features[ix["train"]], y[ix["train"]])
    metrics["random_forest"] = regression_metrics(y[test], forest.predict(features[test]))
    train_class = ix["train"][cls[ix["train"]] >= 0]
    if len(np.unique(cls[train_class])) >= 2 and len(train_class) > len(np.unique(cls[train_class])) and known.any():
        lda = LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")
        lda.fit(features[train_class], cls[train_class])
        metrics["lda_six_class_accuracy"] = float(accuracy_score(cls[test][known], lda.predict(features[test][known])))
    meta.update(mean=mean.tolist(), std=std.tolist(), seed=seed,
                split_sessions={k: sorted(str(s) for s in set(sessions[v])) for k, v in ix.items()},
                model="FingerCNN-v1", normalization="train recordings only", metrics=metrics)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "metadata": meta}, output)
    report = {"metadata": meta, "history": history, "note": "Synthetic scores validate plumbing only. Compute timing excludes acquisition, window accumulation, filtering, HTTP and actuation."}
    output.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", type=Path, default=Path("artifacts/dataset.npz"))
    p.add_argument("--output", type=Path, default=Path("artifacts/model.pt"))
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--seed", type=int, default=42)
    a = p.parse_args()
    train(a.data, a.output, a.epochs, a.batch_size, a.seed)


if __name__ == "__main__":
    main()
