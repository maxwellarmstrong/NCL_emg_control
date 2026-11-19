# Gesture CNN experiment

This folder is a standalone first version of the paired-movement CNN pipeline.
It does not change or replace `emg_research`'s existing finger-flexion trainer,
and it does not yet connect the new checkpoint to the live simulator.

## What the model learns

One small 1D CNN reads an eight-channel EMG window and has two output heads:

1. **Movement classification:** one of the paired prompt directions, plus rest
   (for example `bicep_curl` or `elbow_extend`). The prompt directions remain
   separate classes even though the UI collects them as a balanced pair.
2. **Camera motion regression:** five calibrated finger-flexion values, elbow
   flexion angle, and upper-arm-to-torso angle. The dataset includes a mask for
   every output so the regression loss uses only valid camera measurements
   relevant to the prompted movement.

The hand values are calibrated 0..1 bend estimates, not anatomical joint degrees.
Arm values are monocular camera estimates in degrees, not motion-capture ground
truth. The current camera does not measure wrist direction or forearm rotation;
those movements train the classifier only.

At inference, use the class probabilities to decide the intended direction and
the regression outputs for motion amount. Smooth and rate-limit any simulator
command separately. The `predict_window` helper expects the same filtered EMG
window, channel order, and normalization used during training.

## How labels are built

The dataset builder reads each local session's `emg.jsonl`, `vision.jsonl`,
`events.jsonl`, and `metadata.json`:

- Accepted and camera-unclear trials that the participant confirms were performed
  as prompted supply movement-class intervals. Incorrect or unfinished trials
  are excluded from class training.
- The explicit rest period between review and the next prompt (or protocol end)
  supplies the `rest` class, with short edges trimmed to avoid transitions.
- Camera measurements are aligned to the end of each EMG window using timestamps
  and the session's label delay. Each target is interpolated only across short,
  valid frame gaps. Missing camera measurements are masked instead of fabricated.
- Preparation, movement transitions, invalid/clipped EMG, filter warmup, packet
  gaps, and windows that cross trial boundaries are left out.

Inputs are 200 ms windows shaped `[8 channels, 50 samples]` at 250 Hz, advanced
every 50 ms. This uses the existing acquisition filter implementation so offline
training follows the same filter parameters as the live recorder.

For meaningful motion-amount prediction, recordings need to cover a range of
comfortable motion amplitudes, not only one repeated end pose. Record complete,
balanced pairs in each train/validation/test split, and keep entire sessions in
one split. The final held-out session must contain the classes you want to
evaluate.

## Prepare and train

Run commands from the repository root, using the existing environment with the
optional `train` dependencies (PyTorch and scikit-learn) installed:

```bash
python -m gesture_cnn.dataset \
  --sessions data/sessions \
  --output artifacts/gesture_cnn/dataset.npz

python -m gesture_cnn.train \
  --data artifacts/gesture_cnn/dataset.npz \
  --output artifacts/gesture_cnn/model.pt
```

On Windows, use `.venv\\Scripts\\python.exe` in place of `python`; on macOS or
Linux, use `.venv/bin/python`.

The dataset command reports skipped sessions, accepted/excluded trials, and
windows per class. Synthetic recordings are ignored unless `--allow-synthetic`
is passed; synthetic scores only check the data plumbing and are not evidence of
human gesture accuracy.

Training computes per-channel normalization from training sessions only, selects
the checkpoint using validation loss, and evaluates the held-out test sessions
once. It reports class accuracy, macro F1, a confusion matrix, and MAE for each
camera target (finger bend in percentage points; arm angles in degrees). The
checkpoint and JSON report are written under `artifacts/`, which should remain
local and out of Git.

## Use a saved model offline

```python
import numpy as np
from gesture_cnn.predict import load_checkpoint, predict_window

model, metadata = load_checkpoint("artifacts/gesture_cnn/model.pt")
filtered_window = np.zeros((8, metadata["window_samples"]), dtype=np.float32)
result = predict_window(model, metadata, filtered_window)
print(result["movement"], result["confidence"], result["motion"])
```

The example zeros are only to show the interface; use a real filtered EMG window
for predictions. Classifier output is provided for every trained movement. Motion
targets are marked as supported only for movements that the current camera can
measure. A future simulator integration should add a confidence/rejection gate,
trajectory smoothing, and joint velocity limits before actuating the virtual arm.
