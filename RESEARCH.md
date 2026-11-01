# Continuous finger-motion research workspace

This extends the existing Rust/WASM arm simulator with a local acquisition and
machine-learning workflow based on the supplied research memo. It is an initial
research implementation. Human decoding accuracy, camera-label accuracy, and
end-to-end latency have not yet been measured.

## What is available

| Component | Implementation | Remaining validation |
|---|---|---|
| Acquisition app | Chrome/Edge Web Serial, eight EMG traces, raw recording, camera calibration, landmarks, guided movement cues, session library and ZIP export | Real Cyton stream and electrode quality |
| Camera labels | Local MediaPipe worker; 21 landmarks; five calibrated flexion targets; one frame in flight | Real hand tracking, occlusion, handedness and repeatability |
| Preprocessing | Shared causal SOS coefficients in JavaScript and SciPy; gaps, clipping, timing and startup exclusion | Participant-specific filter comparisons |
| Dataset builder | 200 ms trailing windows, 50 ms scheduled hops, bounded interpolation, complete-session splits | Empirical EMG/camera delay and clock drift |
| CNN | Temporal convolutional features, five continuous outputs, five activation outputs, auxiliary six-class head | Training on real recordings |
| Baselines | Random-forest regression and LDA classification using EMG features | Compare on identical human test sessions |
| RL | Gymnasium environment, bounded residual actions, PPO/SAC entry points and held-out-seed evaluation | Frozen real decoder, hand simulator adapter and closed-loop experiments |

Raw recordings and models remain on this computer and are ignored by Git. No video
frames are saved, uploaded, or sent to an AI service. Landmarks, calibrated labels,
participant codes, and raw EMG are saved locally. Use pseudonymous participant codes.

## Start locally

After the installation steps below, dependencies, CPU PyTorch, and the MediaPipe
model reside in `.venv`, `node_modules`, and `models` respectively. From the
repository root, launch the app with:

```powershell
powershell -File scripts/start-lab.ps1
```

Open <http://localhost:8081>. The server binds to `127.0.0.1`; use the same laptop
for the USB dongle, browser, camera and server. Stop the server with Ctrl+C when
started in a terminal. The original simulator is linked from the app at `/arm/`.
Only one app can own the dongle's serial port at a time.

To reproduce the tested Windows/Python 3.12 CPU environment on a fresh checkout:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
npm ci
.\.venv\Scripts\python.exe scripts/download_models.py
```

`pyproject.toml` defines the supported dependency ranges; `requirements-lock.txt`
captures the tested versions. `package-lock.json` pins MediaPipe JS 1.2.0. The
download script retrieves the version-1 hand-landmarker model from Google's official
storage and records its SHA-256 locally; that hash is a provenance record, not an
independently verified vendor checksum. No OpenAI API key or GPU is required.

## Equipment and sampling constraints

For the first pilot, use the existing Cyton, its USB radio dongle, battery power,
a compatible set of electrode leads and surface electrodes, and a webcam with a
clear view of the complete hand. Eight bipolar channels require eight differential
electrode pairs plus the board's bias connection. Wiring must match the app's
**Bipolar pairs** or **Shared reference** selection; those montages are different
experiments. Follow the manufacturer's wiring instructions. Keep the body-connected
board battery powered and isolated from mains-powered connections.

**Cyton through the standard USB radio streams at 250 samples/second, not 2,000.**
The app rejects a 2 kHz Cyton session. It provides 2 kHz synthetic data to develop
the full-bandwidth pipeline while a higher-rate acquisition path is selected.
Do not upsample 250 Hz and present it as native 2 kHz EMG. A future real 2 kHz
adapter needs eight simultaneously sampled differential channels, suitable input
isolation, documented gain/scaling, timestamps or counters, and a transport that
sustains the data rate. That hardware adapter is not implemented here.

At 250 Hz the 200 ms CNN window contains 50 samples; at 2 kHz it contains 400.
The 50 ms hop alternates between 12 and 13 samples at 250 Hz, avoiding the drift
from always rounding it to 12 samples. Higher rates require separately trained
models and cannot be mixed in one dataset.

## Acquisition workflow

1. Start with **Synthetic demo**, then **Start synthetic stream**. Preview the
   signals, start a recording, finish it, and download its ZIP from the library.
   Synthetic labels are explicitly marked and excluded from human datasets by default.
2. For real data, choose **OpenBCI Cyton · USB**, the correct electrode wiring,
   and mains frequency (60 Hz is the default for this location). Connect and
   select the dongle in the browser's port chooser. Check the sample rate and gaps.
3. Enable the camera, select the correct hand, and hold the full hand in view.
   Capture an open pose and a closed pose, each held steady for a second. The
   calibration requires enough angular range for every finger. Keep fingertips
   visible; the camera estimate can still fail during a tightly occluded fist.
4. Assign a participant code and **Training**, **Validation**, or **Held-out test**
   to the entire recording. Set the label delay only if you have estimated it
   from training recordings. Start recording after calibration.
5. Include relaxed rest, slow individual flexion/extension, multiple amplitudes,
   and combinations. Guided cues are stored as events, not substituted for labels.
   Finish and save before changing source, calibration, or session settings.
6. Collect separate validation and test recordings, ideally after electrode
   reattachment and on later days. Select settings using training/validation data;
   reserve the test recordings for the final comparison.

The app can record raw EMG without camera labels, but those recordings cannot
train the supervised decoder. It freezes calibration and camera controls during
recording. A failed save pauses recording and retains the queued batch; keep the
tab open and use **Retry save & finish**. Successfully acknowledged batches are
stored on disk. Batch IDs prevent duplicate appends after a lost response.
Recoverable write failures roll back appends before retrying. This is not a
power-loss-proof database: a browser/server crash can lose unacknowledged data,
and an interrupted server session is excluded from training and cannot be resumed.

## Data and synchronization

For configurable storage, verified backup/restore and importing existing
placement-lab exports, see [storage and repository integration](docs/INTEGRATION.md).
The acquisition UI shows its actual save path. Placement imports remain cue-labelled
trials and are excluded from the camera-supervised dataset builder.

Each recording is stored in `data/sessions/<uuid>/`:

| File | Content |
|---|---|
| `metadata.json` | Source, participant, split, sample rate, wiring, hand, filter coefficients, counts, time origin and status |
| `emg.jsonl` | Raw microvolts, ADC counts where available, sequence/index, reconstructed sample time, host receipt time, clipping/timing flags and auxiliary bytes |
| `vision.jsonl` | Frame callback/processing times, raw normalized/world landmarks, joint bends, calibrated flexion, handedness score, validity and rejection reason |
| `events.jsonl` | Calibration values, recording events, movement cues and page-visibility changes |

EMG and camera share the browser's monotonic clock. EMG time is reconstructed
from sample counts; camera time is the browser video-frame callback time. Neither
is a measured hardware acquisition timestamp. The stored receipt times allow
inspection of radio batching and drift. An 8-bit Cyton counter cannot distinguish
losses of whole 256-packet cycles. Suspicious receipt gaps or discrepancies over
250 ms are flagged and excluded rather than silently treated as synchronized.

Positive `label_delay_ms` maps a trailing EMG window ending at time `t` to the
visual target at `t + delay`. Estimate the offset using training recordings only,
inspect its variability, and hold it fixed for validation/test. A future hardware
synchronization experiment should measure the complete acquisition-to-display
latency. A 200 ms context window is not itself a measured 200 ms system latency.

The builder rejects gap-crossing windows, startup transients, saturation and
suspicious timing. Labels must cover the entire window without invalid frames
or gaps exceeding 100 ms. It never extrapolates beyond recorded labels. Flexion
is the mean joint bend for each finger, normalized between the two calibration
poses; it is not five anatomically validated joint angles. MediaPipe's world
coordinates are used for angles. Its handedness score is **not** a per-landmark
confidence score; edge, geometry, jump and missing-hand rules are heuristics,
and monocular occlusion can remain undetected.

## Biosignal filtering

| Native sample rate | Initial band-pass | Optional mains notch | CNN input |
|---|---|---|---|
| 250 Hz | 20–100 Hz | One narrow 50 or 60 Hz notch, Q=30 | 8 × 50 waveform samples |
| 2,000 Hz | 20–450 Hz | One narrow 50 or 60 Hz notch, Q=30 | 8 × 400 waveform samples |

The Butterworth prototype order is four (the band-pass transfer function is
eighth order), implemented as second-order sections for numerical stability.
The same coefficients and causal filter state are used live and in training.
Offline `filtfilt` is deliberately not used because its future-sample access and
phase response would differ from deployment. State persists across chunks and
resets at packet gaps. One second after startup/gaps and after clipped or timing-
uncertain samples is excluded. No common-average subtraction is applied by default,
particularly for bipolar channels. The CNN sees the band-passed waveform, not the
original simulator's rectified low-pass control envelope.

These are numerically validated starting profiles, **not a demonstrated optimum**.
The 250 Hz hardware has a 125 Hz Nyquist limit, so a 450 Hz digital cutoff is invalid.
Digital filtering cannot undo aliasing or recover bandwidth the acquisition lost.
The ADC's own response is narrower than Nyquist: at nominal 250 SPS the ADS1299
has approximately 65 Hz −3 dB bandwidth. Thus the 20–100 Hz software profile is
not a flat 20–100 Hz hardware passband. The filter report now includes nominal
ADC-plus-software gains. [TI ADS1299 datasheet](https://www.ti.com/lit/ds/symlink/ads1299.pdf)
The notch also removes some real EMG energy; disable it when measurements justify
that choice. Broad or unnecessary harmonic notches are not enabled.

Run `python scripts/filter_report.py` through `.venv` to write frequency-response
and frequency-dependent group-delay diagnostics to `artifacts/filter-validation.json`.
Tests verify attenuation, stability, persistent state, reset behavior, and numeric
agreement between the browser implementation and SciPy at both sample rates.
To optimize empirically, compare low edges 10/20/30 Hz, justified upper edges,
notch on/off, and filter orders on training/validation sessions. Evaluate decoding
error, rest noise, movement artifacts, mains contamination and end-to-end delay.
Rebuild datasets and retrain for each profile; lock the choice before testing.

## Train the CNN and baselines

After collecting complete, calibrated real sessions in all three splits:

```powershell
.\.venv\Scripts\python.exe -m emg_research.dataset --sessions data/sessions --output artifacts/dataset.npz
.\.venv\Scripts\python.exe -m emg_research.train --data artifacts/dataset.npz --output artifacts/model.pt --epochs 30
```

The temporal CNN produces a 96-dimensional learned feature vector. Separate heads
predict five continuous flexion values, five simultaneous activation probabilities,
and six isolated classes (rest plus each finger). The six-class loss ignores
combinations, transitions and ambiguous windows. Continuous and multilabel heads
support simultaneous finger motions. Normalization is fitted on training data
only. Whole sessions cannot appear in more than one split.

The training report includes per-finger MAE/RMSE/R², multilabel exact-match,
six-class accuracy/confusion, RF/LDA baselines, and compute-only inference timing.
The best checkpoint is selected on validation loss and evaluated once on test.
Do not repeatedly tune against test results. RF/LDA use mean absolute value, RMS,
waveform length and zero crossings as initial features.

The app discovers `artifacts/model.pt` on reload and enables **Compare a trained
CNN**. It validates the full filter profile and window shape before inference.
It also checks electrode wiring; datasets with mixed shared-reference/bipolar
wiring are rejected. Rebuild older datasets and retrain checkpoints that lack
wiring metadata. This does not replace controlling electrode position and channel order.
Live requests are throttled to 10 Hz; the offline training windows use 50 ms hops.
CNN comparison is currently a display, not an actuator command.

For an entirely synthetic pipeline check, keep output names separate:

```powershell
.\.venv\Scripts\python.exe -m emg_research.synthetic --output data/demo --seconds 30
.\.venv\Scripts\python.exe -m emg_research.dataset --sessions data/demo --output artifacts/demo-dataset.npz --allow-synthetic
.\.venv\Scripts\python.exe -m emg_research.train --data artifacts/demo-dataset.npz --output artifacts/demo-model.pt --epochs 4
```

A four-epoch run has completed on generated sessions. Its metrics only check the
pipeline and are not evidence of human decoding performance. `demo-model.pt` is
not automatically activated in the app. Re-running generation creates additional
sessions; use a new output directory when you want an independent dataset.

NinaPro integration is a subsequent task. DB8 has 16 native channels at about
1,111 Hz, later resampled to 2 kHz, and its intended target configuration combines
ring/little control. DB2 has 12 EMG channels at 2 kHz. Neither can be treated as
an already compatible eight-channel, five-independent-finger dataset without
documented channel/label mappings and a cross-device validation experiment.

## Reinforcement-learning direction

The cited TBME work uses **AWAC for offline discrete classifier adaptation**.
It does not directly establish a continuous PPO/SAC residual controller. There
are two distinct experiments worth comparing:

1. Reproduce classifier adaptation with a frozen feature extractor and offline
   action/reward data, after a well-validated supervised baseline exists.
2. Test continuous residual control: a frozen EMG decoder supplies the base
   flexion command and a policy adds a small bounded correction.

`emg_research/rl.py` starts the second route. Observations contain base decoder
output, simulated position/velocity and previous residual. The desired visual
target is used only in reward, not exposed as an observation. Actions are clamped
to ±0.15 normalized flexion; joint limits and speed limits are enforced. Reward
penalizes tracking error, residual changes and correction magnitude. The current
base output is a noisy synthetic surrogate, not a trained EMG decoder.

```powershell
.\.venv\Scripts\python.exe -m emg_research.rl --algorithm ppo --steps 2048 --output artifacts/rl-ppo
.\.venv\Scripts\python.exe -m emg_research.rl --algorithm sac --steps 2048 --output artifacts/rl-sac
```

A short PPO infrastructure run has completed and compares the learned policy
against zero residual on separate seeds. It makes no claim of human improvement.
Next: replay held-out EMG through the frozen CNN, build a five-finger simulation
adapter (the existing arm's joints are not five finger DOFs), vary delay/gain/noise,
then compare supervised fine-tuning, zero-residual control, PPO/SAC and offline
adaptation. Evaluate unseen sessions and report stability, tracking error, effort,
latency and failure rate across seeds. Keep physical actuation out of initial RL
experiments; a physical controller and its independent limits are not implemented.

## Repository map and checks

- `www/acquire/`: acquisition UI, serial parser, JavaScript filters, hand-tracker worker.
- `emg_research/server.py`: local session API and optional CNN inference.
- `emg_research/signal.py`: authoritative filter profiles and causal preprocessing.
- `emg_research/dataset.py`: quality checks, alignment and window generation.
- `emg_research/model.py`, `train.py`: CNN, normalization, baselines and evaluation.
- `emg_research/rl.py`: residual-control simulation and PPO/SAC training.
- `scripts/`: launch, model download, and filter diagnostics.
- `tests/`: Python and Node checks. The original Rust simulator remains in `src/`.

```powershell
.\.venv\Scripts\python.exe -m pytest -q
npm test
```

The browser worker self-test at <http://localhost:8081/assets/vision-smoke.html>
loads the local model and processes a generated blank frame without camera access.
This verifies worker/WASM integration, not tracking accuracy. Real camera and
hardware trials remain required.

## Validation completed

Validation on November 1, 2026: 20 Python tests and four Node tests passed across
the test runs, including a complete training/checkpoint/API prediction round trip.
The local browser worker processed a blank frame successfully. Browser recording,
retry/finalization and export were exercised with synthetic data at 250 Hz and
2 kHz; the 2 kHz export contained 109,829 unique, ordered samples matching its
metadata count. Four-epoch CNN training and short PPO and SAC runs completed on
synthetic data. Real Cyton and webcam acquisition were not exercised in this run.

## Primary references

- [OpenBCI Cyton SDK: sample rate and transport limit](https://docs.openbci.com/Cyton/CytonSDK/#sample-rate)
- [OpenBCI EMG setup](https://docs.openbci.com/GettingStarted/Biosensing-Setups/EMGSetup/)
- [MediaPipe Hand Landmarker for web](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- [SciPy Butterworth design](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.butter.html) and [SOS filtering](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.sosfilt.html)
- [TBME paper record](https://pubmed.ncbi.nlm.nih.gov/40498601/) and [AWAC preprint](https://arxiv.org/html/2411.13327v1)
- [NinaPro DB8](https://ninapro.hevs.ch/instructions/DB8.html) and [DB2](https://ninapro.hevs.ch/instructions/DB2.html)
- [Stable-Baselines3 custom environments](https://stable-baselines3.readthedocs.io/en/master/guide/custom_env.html), [PPO](https://stable-baselines3.readthedocs.io/en/master/modules/ppo.html), and [SAC](https://stable-baselines3.readthedocs.io/en/master/modules/sac.html)
