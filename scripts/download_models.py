"""Download versioned official MediaPipe hand and pose models locally."""
import hashlib
import argparse
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "pose_landmarker_lite.task": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
}


def download(name, url, expected_sha256=None):
    destination = ROOT / "models" / name
    destination.parent.mkdir(exist_ok=True)
    if not destination.exists():
        temporary = destination.with_suffix(".part")
        with urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        if expected_sha256 and hashlib.sha256(temporary.read_bytes()).hexdigest() != expected_sha256:
            raise ValueError(f'Checksum mismatch for {name}')
        temporary.replace(destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise ValueError(f'Checksum mismatch for existing {name}')
    manifest = {"url": url, "sha256": digest, "bytes": destination.stat().st_size,
                "note": "Verified against upstream MediaPipe test manifest." if expected_sha256 else
                        "Local download digest, not an independently authenticated vendor checksum."}
    destination.with_suffix(".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-fixtures', action='store_true', help='Also download the official pose test photo for browser QA')
    args = parser.parse_args()
    for name, url in MODELS.items():
        download(name, url)
    if args.test_fixtures:
        # Source: google-ai-edge/mediapipe third_party/external_files.bzl.
        download('pose-test.jpg', 'https://storage.googleapis.com/mediapipe-assets/tasks/testdata/vision/pose.jpg?generation=1782185208547605',
                 'c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b')


if __name__ == "__main__":
    main()
