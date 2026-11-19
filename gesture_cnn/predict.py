"""Offline helper for class and angle predictions from one filtered EMG window."""
import json
from pathlib import Path

import numpy as np
import torch

from .labels import MOTION_TARGETS, TARGET_SCALES, target_mask_for_movement
from .model import GestureCNN


def load_checkpoint(path):
    saved = torch.load(Path(path), map_location="cpu", weights_only=True)
    metadata = saved["metadata"]
    model = GestureCNN(len(metadata["class_ids"]), len(MOTION_TARGETS))
    model.load_state_dict(saved["state_dict"])
    model.eval()
    return model, metadata


def predict_window(model, metadata, window):
    """Predict from a [8, window_samples] window already filtered like training."""
    values = np.asarray(window, dtype=np.float32)
    expected = (8, int(metadata["window_samples"]))
    if values.shape != expected or not np.isfinite(values).all():
        raise ValueError(f"Expected a finite filtered EMG window shaped {expected}")
    mean = np.asarray(metadata["channel_mean"], dtype=np.float32)[:, None]
    std = np.asarray(metadata["channel_std"], dtype=np.float32)[:, None]
    tensor = torch.from_numpy(((values - mean) / std)[None, ...])
    with torch.inference_mode():
        output = model(tensor)
        probabilities = output["movement_logits"].softmax(dim=1)[0].numpy()
        motion = output["motion"][0].numpy()
    local_id = int(probabilities.argmax())
    class_id = int(metadata["class_ids"][local_id])
    class_name = metadata["class_names"][local_id]
    supported = target_mask_for_movement(class_name)
    physical = {}
    for index, (name, value, scale) in enumerate(zip(MOTION_TARGETS, motion, TARGET_SCALES)):
        if not supported[index]:
            continue
        estimate = float(value * scale)
        if index < 5:
            estimate *= 100.0  # Express calibrated 0..1 finger flexion as percent.
        physical[name] = estimate
    return {
        "class_id": class_id,
        "movement": class_name,
        "confidence": float(probabilities[local_id]),
        "probabilities": {name: float(probabilities[i]) for i, name in enumerate(metadata["class_names"])},
        "motion": physical,
        "motion_units": {name: "% flexion" if name.endswith("flexion") and name not in ("elbow_flexion_deg",) else "degrees"
                         for name in physical},
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("window", type=Path, help="NumPy .npy file containing one filtered [8, 50] window")
    args = parser.parse_args()
    model, metadata = load_checkpoint(args.checkpoint)
    print(json.dumps(predict_window(model, metadata, np.load(args.window)), indent=2))


if __name__ == "__main__":
    main()
