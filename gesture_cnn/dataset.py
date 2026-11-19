"""Build labeled EMG windows from paired-trial events and camera measurements."""
import argparse
import json
from dataclasses import fields
from pathlib import Path

import numpy as np

from emg_research.signal import FilterConfig, filter_segments
from emg_research.storage import data_directory

from .labels import CLASS_TO_ID, MOTION_TARGETS, TARGET_SCALES, target_mask_for_movement

WINDOW_MS = 200
HOP_MS = 50
MAX_CAMERA_GAP_MS = 100
REST_EDGE_MS = 200


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def event_rows(events):
    rows = []
    for row in events:
        if isinstance(row, dict) and isinstance(row.get("data"), dict):
            try:
                rows.append((float(row["t_ms"]), row["type"], row["data"]))
            except (KeyError, TypeError, ValueError):
                continue
    return sorted(rows, key=lambda row: row[0])


def labeled_intervals(events, report):
    """Return accepted movement intervals and explicitly bounded rest intervals."""
    trials, prompts, reviews, protocol_ends = {}, [], [], []
    for t_ms, kind, data in event_rows(events):
        if kind == "gesture_trial_prompt":
            prompts.append(t_ms)
            trial_id = data.get("trial_id")
            if trial_id:
                trials.setdefault(trial_id, {}).update(prompt=data, prompt_t=t_ms)
        elif kind in ("gesture_trial_start", "gesture_trial_end", "gesture_trial_review"):
            trial_id = data.get("trial_id")
            if not trial_id:
                continue
            item = trials.setdefault(trial_id, {})
            if kind == "gesture_trial_start":
                item["start_t"] = t_ms
                item["start"] = data
            elif kind == "gesture_trial_end":
                item["end_t"] = t_ms
                item["end"] = data
            else:
                item["review_t"] = t_ms
                item["review"] = data
                reviews.append((t_ms, trial_id))
        elif kind in ("gesture_protocol_completed", "gesture_protocol_stopped"):
            protocol_ends.append(t_ms)

    intervals = []
    for trial_id, item in trials.items():
        prompt = item.get("prompt", {})
        name = prompt.get("class_name") or item.get("start", {}).get("class_name")
        if name not in CLASS_TO_ID:
            report["unrecognized_classes"] += 1
            continue
        supplied_id = prompt.get("class_id")
        if supplied_id is not None and int(supplied_id) != CLASS_TO_ID[name]:
            raise ValueError(f"Movement ID mismatch for {name!r}: app={supplied_id}, package={CLASS_TO_ID[name]}")
        start_t, end_t = item.get("start_t"), item.get("end_t")
        review = item.get("review", {})
        usable = review.get("outcome") in ("accepted", "camera_unclear") and review.get("performed_as_prompted", False)
        early = bool(item.get("end", {}).get("early", False))
        if usable and start_t is not None and end_t is not None and end_t > start_t and not early:
            intervals.append((start_t, end_t, CLASS_TO_ID[name], name, trial_id))
        elif item.get("prompt"):
            report["excluded_trials"] += 1

    # The UI's review -> next-prompt time is the instructed rest phase. A short
    # margin on both ends avoids labeling button presses and prompt transitions.
    for index, (review_t, _trial_id) in enumerate(reviews):
        next_prompt = next((value for value in prompts if value > review_t), None)
        next_protocol_end = next((value for value in protocol_ends if value > review_t), None)
        right_edges = [value for value in (next_prompt, next_protocol_end) if value is not None]
        right_edge = min(right_edges) if right_edges else None
        if right_edge is None:
            continue
        left, right = review_t + REST_EDGE_MS, right_edge - REST_EDGE_MS
        if right > left:
            intervals.append((left, right, CLASS_TO_ID["rest"], "rest", f"rest_{index}"))
    intervals.sort(key=lambda item: item[0])
    report["accepted_trials"] = sum(item[2] != CLASS_TO_ID["rest"] for item in intervals)
    report["rest_intervals"] = sum(item[2] == CLASS_TO_ID["rest"] for item in intervals)
    return intervals


def camera_target_arrays(frames):
    times = np.asarray([float(frame["t_ms"]) for frame in frames], dtype=np.float64)
    values = np.zeros((len(frames), len(MOTION_TARGETS)), dtype=np.float32)
    valid = np.zeros_like(values, dtype=bool)
    for index, frame in enumerate(frames):
        flexion = frame.get("flexion")
        if frame.get("valid") and isinstance(flexion, list) and len(flexion) == 5:
            candidate = np.asarray(flexion, dtype=np.float32)
            good = np.isfinite(candidate) & (candidate >= 0) & (candidate <= 1)
            values[index, :5] = np.where(good, candidate, 0)
            valid[index, :5] = good
        arm = frame.get("arm") or {}
        if arm.get("valid"):
            elbow = arm.get("elbow_flexion_deg")
            if isinstance(elbow, (int, float)) and np.isfinite(elbow) and 0 <= elbow <= 180:
                values[index, 5] = elbow / 180.0
                valid[index, 5] = True
            upper = arm.get("upper_arm_to_torso_deg")
            if isinstance(upper, (int, float)) and np.isfinite(upper) and 0 <= upper <= 180:
                values[index, 6] = upper / 180.0
                valid[index, 6] = True
    return times, values, valid


def interpolate_targets(times, values, valid, target_t, max_gap_ms=MAX_CAMERA_GAP_MS):
    """Interpolate each camera target independently; never bridge bad/large gaps."""
    result = np.zeros(values.shape[1], dtype=np.float32)
    mask = np.zeros(values.shape[1], dtype=bool)
    for column in range(values.shape[1]):
        known = np.flatnonzero(valid[:, column])
        if not len(known):
            continue
        known_times = times[known]
        pos = int(np.searchsorted(known_times, target_t, side="left"))
        if pos < len(known) and abs(known_times[pos] - target_t) < 1e-6:
            result[column] = values[known[pos], column]
            mask[column] = True
        elif 0 < pos < len(known):
            lo, hi = known[pos - 1], known[pos]
            gap = times[hi] - times[lo]
            if 0 < gap <= max_gap_ms:
                fraction = (target_t - times[lo]) / gap
                result[column] = values[lo, column] * (1 - fraction) + values[hi, column] * fraction
                mask[column] = True
    return result, mask


def interval_label(intervals, window_start, window_end):
    for start, end, class_id, name, _trial_id in intervals:
        if window_start >= start and window_end <= end:
            return class_id, name
    return None


def build_dataset(session_root, output, label_delay_ms=None, allow_synthetic=False):
    session_root = Path(session_root)
    rows = {key: [] for key in ("x", "class_id", "motion", "motion_mask", "session", "split", "end_ms")}
    reports, filter_signatures, wirings, sources, delays = [], set(), set(), set(), set()

    for folder in sorted(session_root.iterdir()):
        metadata_path = folder / "metadata.json"
        if not metadata_path.exists():
            continue
        meta = json.loads(metadata_path.read_text(encoding="utf-8"))
        report = {"session": meta.get("id", folder.name), "windows": 0, "excluded_trials": 0,
                  "unrecognized_classes": 0, "class_counts": {name: 0 for name in CLASS_TO_ID}}
        reports.append(report)
        if meta.get("status") != "complete":
            report["skip"] = "Recording is incomplete"
            continue
        if meta.get("recording_kind", "finger_motion") != "finger_motion":
            report["skip"] = "This package reads paired gesture trials, not placement recordings"
            continue
        config_meta = meta["config"]
        if config_meta.get("source") == "synthetic" and not allow_synthetic:
            report["skip"] = "Synthetic recording excluded; pass --allow-synthetic for pipeline practice"
            continue
        emg, vision, events = (read_jsonl(folder / f"{name}.jsonl") for name in ("emg", "vision", "events"))
        if not emg or not vision or not events:
            report["skip"] = "Missing EMG, camera frames, or trial events"
            continue
        intervals = labeled_intervals(events, report)
        if not intervals:
            report["skip"] = "No accepted paired movement intervals or usable rest intervals"
            continue

        wiring = config_meta.get("wiring", "unspecified")
        wirings.add(wiring)
        if len(wirings) > 1 or "unspecified" in wirings:
            raise ValueError("Do not mix electrode wiring or unknown montages in one dataset")
        source = config_meta.get("source", "unknown")
        sources.add(source)
        if len(sources) > 1:
            raise ValueError("Keep synthetic and human recordings in separate datasets")
        delay = float(config_meta.get("label_delay_ms", 0) if label_delay_ms is None else label_delay_ms)
        delays.add(delay)
        if len(delays) > 1:
            raise ValueError("Choose one label delay for the dataset or pass --label-delay-ms")

        filter_meta = meta["filter"]
        filter_config = FilterConfig(**{field.name: filter_meta[field.name] for field in fields(FilterConfig)})
        signature = tuple(getattr(filter_config, field.name) for field in fields(FilterConfig))
        filter_signatures.add(signature)
        if len(filter_signatures) > 1:
            raise ValueError("Do not mix sample rates or filter profiles in one dataset")

        indices = np.asarray([int(sample["index"]) for sample in emg], dtype=np.int64)
        sample_times = np.asarray([float(sample["t_ms"]) for sample in emg], dtype=np.float64)
        if np.any(np.diff(indices) <= 0) or np.any(np.diff(sample_times) <= 0):
            raise ValueError(f"Non-monotonic EMG timestamps in {folder.name}")
        raw = np.asarray([sample["uv"] for sample in emg], dtype=np.float64)
        if raw.shape != (len(emg), 8) or not np.isfinite(raw).all():
            raise ValueError(f"Expected finite eight-channel EMG in {folder.name}")
        bad = np.asarray([sample.get("clipped", False) or sample.get("timing_uncertain", False) for sample in emg], dtype=bool)
        filtered, clean = filter_segments(raw, indices, filter_config, sample_times, bad)
        vision_times, target_values, target_valid = camera_target_arrays(vision)
        if np.any(np.diff(vision_times) <= 0):
            raise ValueError(f"Non-monotonic camera timestamps in {folder.name}")

        count = round(filter_config.sample_rate_hz * WINDOW_MS / 1000)
        next_end = sample_times[0] + WINDOW_MS
        while next_end <= sample_times[-1] + 1e-6:
            end = int(np.searchsorted(sample_times, next_end, side="right"))
            start = end - count
            if start < 0 or end <= start:
                next_end += HOP_MS
                continue
            window_start, window_end = sample_times[start], sample_times[end - 1]
            labeled = interval_label(intervals, window_start, window_end)
            contiguous = (np.all(np.diff(indices[start:end]) == 1) and
                          np.all(np.diff(sample_times[start:end]) <= 1500 / filter_config.sample_rate_hz))
            if labeled and contiguous and clean[start:end].all():
                class_id, class_name = labeled
                motion, motion_mask = interpolate_targets(
                    vision_times, target_values, target_valid, window_end + delay)
                allowed = np.asarray(target_mask_for_movement(class_name), dtype=bool)
                motion_mask &= allowed
                motion[~motion_mask] = 0
                rows["x"].append(filtered[start:end].T.astype(np.float32))
                rows["class_id"].append(class_id)
                rows["motion"].append(motion)
                rows["motion_mask"].append(motion_mask)
                rows["session"].append(str(meta["id"]))
                rows["split"].append(config_meta["split"])
                rows["end_ms"].append(window_end)
                report["windows"] += 1
                report["class_counts"][class_name] += 1
            next_end += HOP_MS

    if not rows["x"]:
        raise ValueError(f"No labeled, clean windows found. Session report: {reports}")
    metadata = {
        "schema_version": 1,
        "sample_rate_hz": filter_config.sample_rate_hz,
        "window_ms": WINDOW_MS,
        "hop_ms": HOP_MS,
        "window_samples": count,
        "channels": 8,
        "class_to_id": CLASS_TO_ID,
        "motion_targets": list(MOTION_TARGETS),
        "target_scales": list(TARGET_SCALES),
        "label_delay_ms": next(iter(delays)),
        "filter": filter_meta,
        "wiring": next(iter(wirings)),
        "source": next(iter(sources)),
        "label_policy": "Accepted or camera-unclear participant-confirmed prompt holds; rest from review-to-next-prompt intervals; camera targets independently masked.",
        "reports": reports,
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, **{key: np.asarray(value) for key, value in rows.items()},
                        metadata=json.dumps(metadata))
    output.with_suffix(".json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions", type=Path, default=data_directory())
    parser.add_argument("--output", type=Path, default=Path("artifacts/gesture_cnn/dataset.npz"))
    parser.add_argument("--label-delay-ms", type=float)
    parser.add_argument("--allow-synthetic", action="store_true")
    args = parser.parse_args()
    metadata = build_dataset(args.sessions, args.output, args.label_delay_ms, args.allow_synthetic)
    print(json.dumps({"output": str(args.output), **{key: value for key, value in metadata.items() if key != "filter"}}, indent=2))


if __name__ == "__main__":
    main()
