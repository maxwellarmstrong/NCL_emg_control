"""Turn one recorded motion source into time-stamped simulator targets."""
import csv
import json
import math


def write_motion(folder, source, output):
    camera = source == "vision"
    path = folder / ("vision.jsonl" if camera else "events.jsonl")
    writer = csv.writer(output)
    writer.writerow(["time_ms", "segment", "thumb", "index", "middle", "ring", "little"])
    start = last = previous_segment = None
    segment = count = 0
    interrupted = False
    if not path.exists():
        return 0
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            frame = json.loads(line)
            if not camera:
                if frame.get("type") != "decoder_motion":
                    continue
                frame = frame["data"]
            if camera and not frame.get("valid"):
                interrupted = True
                continue
            t, values = frame.get("t_ms"), frame.get("flexion")
            if not isinstance(t, (int, float)) or not math.isfinite(t):
                continue
            if (not isinstance(values, list) or len(values) != 5 or
                    not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in values)):
                interrupted = True
                continue
            if last is not None and t <= last:
                continue
            if last is not None and (interrupted or t-last > 250 or previous_segment != frame.get("segment")):
                segment += 1
            if start is None:
                start = t
            writer.writerow([t-start, segment, *values])
            previous_segment, last, interrupted = frame.get("segment"), t, False
            count += 1
    return count
