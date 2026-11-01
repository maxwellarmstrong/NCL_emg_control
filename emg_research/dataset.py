"""Build trailing windows without mixing recordings or interpolating across invalid tracking."""
import argparse
import json
from dataclasses import fields
from pathlib import Path

import numpy as np

from .signal import FilterConfig, filter_segments
from .storage import data_directory


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def aligned_label(frames, times, t_ms, max_gap_ms=100):
    right = int(np.searchsorted(times, t_ms, side="left"))
    if right < len(times) and abs(times[right] - t_ms) < 1e-6:
        frame = frames[right]
        return np.asarray(frame["flexion"], dtype=np.float32) if frame["valid"] and frame["flexion"] is not None else None
    if right == 0 or right == len(times):
        return None
    a, b = frames[right - 1], frames[right]
    if not (a["valid"] and b["valid"]) or a["flexion"] is None or b["flexion"] is None:
        return None
    dt = times[right] - times[right - 1]
    if not 0 < dt <= max_gap_ms:
        return None
    w = (t_ms - times[right - 1]) / dt
    return np.asarray(a["flexion"]) * (1 - w) + np.asarray(b["flexion"]) * w


def build_dataset(session_root, output, label_delay_ms=None, allow_synthetic=False):
    result = {k: [] for k in ("x", "y", "class_id", "session", "split", "end_ms")}
    reports, configs, sources, delays, wirings = [], [], set(), set(), set()
    for folder in sorted(Path(session_root).iterdir()):
        if not (folder / "metadata.json").exists():
            continue
        meta = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
        c = meta["config"]
        report = {"session": meta["id"], "accepted": 0, "rejected": 0}
        reports.append(report)
        if meta.get('recording_kind', 'finger_motion') != 'finger_motion':
            report['skip'] = 'Placement cues are not camera-measured finger labels'
            continue
        if meta["status"] != "complete":
            report["skip"] = "Recording is incomplete"
            continue
        if c["source"] == "synthetic" and not allow_synthetic:
            report["skip"] = "Synthetic data excluded; use --allow-synthetic only for smoke tests"
            continue
        samples, frames = read_jsonl(folder / "emg.jsonl"), read_jsonl(folder / "vision.jsonl")
        if not samples or not frames:
            report["skip"] = "Missing EMG or visual labels"
            continue
        wirings.add(c.get('wiring', 'unspecified'))
        if len(wirings) > 1 or 'unspecified' in wirings:
            raise ValueError('Do not mix electrode wiring or unknown montages in one dataset')
        config = FilterConfig(**{f.name: meta["filter"][f.name] for f in fields(FilterConfig)})
        signature = (config.sample_rate_hz, config.low_hz, config.high_hz, config.mains_hz, config.notch_q, config.order, config.warmup_seconds)
        if configs and signature != configs[0][0]:
            raise ValueError("Do not mix sample rates or filter profiles in one dataset")
        configs.append((signature, meta["filter"]))
        sources.add(c["source"])
        delay = float(c["label_delay_ms"] if label_delay_ms is None else label_delay_ms)
        delays.add(delay)
        if len(delays) > 1:
            raise ValueError("Choose one label delay for this model using --label-delay-ms")
        indices = np.asarray([s["index"] for s in samples], dtype=np.int64)
        times = np.asarray([s["t_ms"] for s in samples])
        ft = np.asarray([f["t_ms"] for f in frames])
        if np.any(np.diff(times) <= 0) or np.any(np.diff(indices) <= 0) or np.any(np.diff(ft) <= 0):
            raise ValueError(f"Non-monotonic timestamps in {folder.name}")
        raw = np.asarray([s["uv"] for s in samples], dtype=np.float64)
        if raw.shape[1:] != (8,) or not np.isfinite(raw).all():
            raise ValueError("Invalid EMG values")
        filtered, clean = filter_segments(raw, indices, config)
        # Match the live predictor's one-second rejection after saturation, including
        # post-clipping filter ringing, while preserving the raw samples on disk.
        for clipped in np.flatnonzero([s.get("clipped", False) or s.get("timing_uncertain", False) for s in samples]):
            clean[clipped:np.searchsorted(times, times[clipped] + 1000 * config.warmup_seconds)] = False
        count = round(config.sample_rate_hz * .2)
        # Time-scheduled hops alternate 12/13 samples at 250 Hz; no silent 48 ms hop.
        for target in np.arange(times[0] + 200, times[-1] + 1e-6, 50):
            end = int(np.searchsorted(times, target, side="right"))
            start = end - count
            if start < 0:
                continue
            label_t = times[end - 1] + delay
            y = aligned_label(frames, ft, label_t)
            contiguous = np.all(np.diff(indices[start:end]) == 1) and np.all(np.diff(times[start:end]) < 1500 / config.sample_rate_hz)
            if y is None or not contiguous or not clean[start:end].all() or not np.isfinite(y).all():
                report["rejected"] += 1
                continue
            y0 = aligned_label(frames, ft, times[start] + delay)
            left, right = np.searchsorted(ft, [times[start] + delay, label_t])
            interior = frames[left:right]
            label_times = np.r_[times[start] + delay, ft[left:right], label_t]
            if y0 is None or any(not f['valid'] or f['flexion'] is None for f in interior) or np.any(np.diff(label_times) > 100):
                report["rejected"] += 1
                continue
            label_values = np.asarray([y0, *[f['flexion'] for f in interior], y])
            stable = np.max(np.ptp(label_values, axis=0)) < .15
            active = y >= .4
            cls = -100
            if stable and np.all(y <= .15):
                cls = 0
            elif stable and active.sum() == 1 and np.all(y[~active] <= .15):
                cls = int(np.argmax(y)) + 1
            result["x"].append(filtered[start:end].T.astype(np.float32))
            result["y"].append(y.astype(np.float32))
            result["class_id"].append(cls)
            result["session"].append(meta["id"])
            result["split"].append(c["split"])
            result["end_ms"].append(times[end - 1])
            report["accepted"] += 1
    if not result["x"]:
        raise ValueError(f"No valid windows. Session report: {reports}")
    if len(sources) > 1:
        raise ValueError("Keep synthetic and human recordings in separate datasets")
    metadata = {"schema_version": 1, "sample_rate_hz": configs[0][0][0], "window_ms": 200,
                "hop_ms": 50, "window_samples": result["x"][0].shape[1], "filter": configs[0][1],
                "label_delay_ms": next(iter(delays)), "training_source": next(iter(sources)), "wiring": next(iter(wirings)),
                "classification": "0=rest;1=thumb;2=index;3=middle;4=ring;5=little;-100=transition/combination/ambiguous",
                "reports": reports}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, **{k: np.asarray(v) for k, v in result.items()}, metadata=json.dumps(metadata))
    output.with_suffix(".json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sessions", type=Path, default=data_directory())
    p.add_argument("--output", type=Path, default=Path("artifacts/dataset.npz"))
    p.add_argument("--label-delay-ms", type=float)
    p.add_argument("--allow-synthetic", action="store_true")
    args = p.parse_args()
    metadata = build_dataset(args.sessions, args.output, args.label_delay_ms, args.allow_synthetic)
    print(json.dumps({"output": str(args.output), **{k:v for k,v in metadata.items() if k != "filter"}}, indent=2))


if __name__ == "__main__":
    main()
