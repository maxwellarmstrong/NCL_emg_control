"""Download the versioned official MediaPipe hand model; no recordings leave the laptop."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"


def main():
    destination = ROOT / "models/hand_landmarker.task"
    destination.parent.mkdir(exist_ok=True)
    if not destination.exists():
        temporary = destination.with_suffix(".part")
        with urlopen(URL, timeout=60) as response, temporary.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        temporary.replace(destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    manifest = {"url": URL, "sha256": digest, "bytes": destination.stat().st_size,
                "note": "Local download digest, not an independently authenticated vendor checksum."}
    destination.with_suffix(".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
