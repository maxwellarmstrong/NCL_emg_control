"""Generate explicitly synthetic sessions to exercise the complete pipeline."""
import argparse
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .signal import FilterConfig


def flexion_at(t):
    t = np.asarray(t)
    targets = np.vstack([np.zeros(5), np.eye(5) * .85,
                         [.65, .65, 0, 0, 0], [0, 0, .65, .65, .65]])
    segment = np.floor(t / 3).astype(int)
    u = np.clip((t % 3) / .4, 0, 1)
    u = u * u * (3 - 2 * u)
    return targets[(segment - 1) % len(targets)] * (1 - u[..., None]) + targets[segment % len(targets)] * u[..., None]


def generate(root, rate=250, seconds=30, seed=7):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    mixing = np.random.default_rng(1).uniform(.05, .6, (5, 8))
    for split, rep in (("train", 0), ("train", 1), ("val", 2), ("test", 3)):
        rng = np.random.default_rng(seed + rep)
        sid = str(uuid.uuid4())
        path = root / sid
        path.mkdir()
        t = np.arange(round(seconds * rate)) / rate
        labels = flexion_at(t)
        amplitude = 3 + (labels @ mixing) * 70 * rng.uniform(.95, 1.05, (1, 8))
        raw = rng.normal(size=(len(t), 8)) * amplitude + 12 * np.sin(2 * np.pi * 60 * t)[:, None] + rng.uniform(-2000, 2000, (1, 8))
        with (path / "emg.jsonl").open("w", encoding="utf-8") as stream:
            for i in range(len(t)):
                stream.write(json.dumps({"index": i, "sequence": i % 256, "t_ms": float(t[i] * 1000),
                                         "received_ms": float(t[i] * 1000 + 10), "uv": raw[i].tolist(), "clipped": False}) + "\n")
        vt = np.arange(0, seconds, 1 / 30)
        with (path / "vision.jsonl").open("w", encoding="utf-8") as stream:
            for time_s, y in zip(vt, flexion_at(vt)):
                valid = not 10.0 < time_s < 10.3
                stream.write(json.dumps({"t_ms": float(time_s * 1000), "processed_ms": float(time_s * 1000 + 8),
                                         "valid": valid, "reason": "synthetic" if valid else "synthetic occlusion",
                                         "flexion": y.tolist() if valid else None}) + "\n")
        config = {"source": "synthetic", "sample_rate_hz": rate, "participant": "SYNTHETIC",
                  "split": split, "wiring": "bipolar", "mains_hz": 60, "hand": "Right",
                  "label_delay_ms": 0, "client_time_origin_ms": 0, "notes": "Synthetic pipeline test; not human data"}
        meta = {"schema_version": 1, "id": sid, "created_utc": datetime.now(timezone.utc).isoformat(),
                "status": "complete", "config": config, "filter": FilterConfig.for_rate(rate).describe(),
                "video_saved": False, "counts": {"emg": len(t), "vision": len(vt), "events": 0}}
        (path / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print(f"{split}: {path}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, default=Path("data/demo"))
    p.add_argument("--rate", type=int, choices=[250, 2000], default=250)
    p.add_argument("--seconds", type=float, default=30)
    a = p.parse_args()
    generate(a.output, a.rate, a.seconds)


if __name__ == "__main__":
    main()
