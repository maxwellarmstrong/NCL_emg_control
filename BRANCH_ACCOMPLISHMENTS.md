# Branch accomplishments: six-channel EMG placement lab

Branch: `feature/emg-placement-lab-2026-10-31`

Session date: October 31, 2026

Repository: [maxwellarmstrong/NCL_emg_control](https://github.com/maxwellarmstrong/NCL_emg_control)

## Purpose and provenance

This branch turns informal electrode-placement experiments into a repeatable,
recorded workflow for the RoArm simulator. The immediate research problem is weak
or inconsistent forearm-rotation signals and unwanted rotation activation during
upper-arm activity. The aim is to compare electrode sites and processing before
choosing a new gesture decoder.

The starting point is Isaac's [digitaryarmcontrol](https://github.com/Issssac/digitaryarmcontrol)
commit `07d9993` ("Ghost arm, triangle home pose, simpler gesture calibration").
The existing simulator, mesh renderer, arm kinematics, template-based decoder and
ordinary calibration coach are inherited work, not newly created by this branch.
Compared with Maxwell's older `main`, this branch also contains that newer upstream
history. To review the October 31 implementation alone, compare this branch with
`07d9993`; do not attribute the entire difference from the older `main` to this session.

## Implemented in this branch

### 1. Six sensing channels and three controlled axes

Use `?session=six` to enable six sensing channels with a shared REF and BIAS.
CH7/8 are powered down and excluded from active signal processing. Gesture
calibration covers six actions for base rotation, coordinated reach, and elbow
angle; the gripper remains manual. The original eight-channel mode remains
available without this query parameter.

The Rust pipeline now has an explicit enabled-channel mask. Disabled inputs do
not enter the common average or reappear after a filter reset. Restored grip
templates cannot activate the gripper in the three-axis session. Six-channel
controller calibration uses a separate server file, `calibration-six.json`.

A numbered right-arm guide documents starting sites. These are candidates, not
validated optimal electrode placements. Optional `?session=six&ch1=7` supports
physical CH7 replacing logical CH1 for lead/input troubleshooting. Normal
operation uses `?session=six`; the CH7 substitution is not enabled by default.

### 2. Guided electrode-placement lab

**Test electrode isolation** opens a dedicated procedure with movement
illustrations, setup instructions, rest/hold cues, and live channel envelopes.
Opening it pauses simulated motion, disengages physical-arm following, and stops
an ordinary calibration run. The placement lab and controller calibration are
separate workflows.

One movement records:

- 3 seconds settling;
- 10 seconds resting baseline;
- three repetitions of 3 seconds preparation, 3 seconds gentle hold, and
  5 seconds recovery.

Total: 46 seconds of retained samples. Rest-control repetitions are observation
periods: the participant remains relaxed throughout. Timing follows samples
received at 250 Hz rather than assuming elapsed UI time is recorded data.

Summaries show resting variation, baseline-relative changes, consistency across
three repetitions, recovery and the strongest responding channel. Selected-channel
share is a descriptive envelope metric, not classification accuracy or muscle purity.

### 3. Single-start standard procedure

**Start standard procedure · 6:22** automatically runs:

1. Relaxed-rest control
2. Palm-down rotation
3. Palm-up rotation
4. Triceps comparison
5. Biceps comparison
6. Wrist extension
7. Wrist flexion

Seven 46-second movements plus six 10-second position changes total **382 seconds**.
Packet retries, saving and stream-readiness waits can add time. Instructions
update for each next movement. Every completed movement is saved before the
sequence advances. Stopping during recording, saving or transitions prevents
further automatic starts. Earlier saved movements remain available.

**Ready — start this movement** still runs only the individually selected
movement. This is useful for retries; it does not launch the seven-step sequence.

### 4. Raw recording, history and export

Each captured sample row contains eight logical-channel ADC-derived voltages in
µV, eight live envelopes, and eight validity flags. The flags reflect input
saturation/availability checks, not measured electrode impedance.

Completed records retain movement cues, placement notes, physical/logical mapping,
processing settings, packet statistics, retry history, and replay summaries.
Sequence records additionally carry sequence ID, order and step index.

Records save to browser IndexedDB `emg-isolation-v1`, stores `recordings` and
`summaries`. Data are scoped to the browser profile and exact origin. Changing
between `localhost` and `127.0.0.1`, changing port, or using another browser can
make a different database appear. Clearing site data can erase it.

- **Export this recording (JSON)** saves one completed recording.
- **Export this comparison set (JSON)** saves all completed records matching the
  current comparison-set name, placement, source, mapping and processing settings.
  Repeated trials are retained. A current completed-but-unsaved record is included.
- **Export interrupted recording (unscored)** preserves an unfinished attempt
  while it remains in memory. Interrupted attempts are not automatically stored
  as successful trials.

Synthetic demonstrations and human Cyton recordings are explicitly labeled and
separated. There is no automatic cloud backup. Raw human recordings and personal
controller calibration files are deliberately not included in this branch.

### 5. Same-recording CAR ON/OFF replay

The captured raw samples can be replayed through the production Rust signal
pipeline with common-average referencing (CAR) ON and OFF. All other replay
settings stay fixed. This does not alter live filters or controller templates.

Replay resets filters independently for the baseline block and each repetition,
using each block's 3-second settling/preparation period as warm-up. This avoids
carrying filter state from discarded attempts into scored blocks. The record
validator rejects incomplete, malformed or unsupported recordings.

The comparison report examines channel changes and positive response-pattern
distances for rest, rotation and triceps trials. Weak responses are not assigned
meaningful pattern-separation scores. CAR can both cancel shared interference and
spread localized activity into other processed channels; the branch enables
measurement rather than assuming either ON or OFF is universally better.

### 6. Stream readiness and bounded packet-gap recovery

An open serial port is no longer treated as sufficient proof of live samples.
Starting requires a fresh, approximately 250 Hz stream observed for a full second.
The lab hides stale channel values when samples stop arriving. Reconnection can
reuse a unique previously authorized FT231X dongle; ambiguous/no matches still
use the browser chooser.

Brief packet gaps discard the uncertain incoming batch and repeat the affected
baseline or prepare/hold/recovery block, keeping earlier complete blocks. Samples
are never interpolated and reported as real observations. Limits are three
retries per block and eight per movement. More than 25 missing packets or three
parser resyncs in a batch, counter resets, prolonged stalls, disconnection,
overflow, invalid active channels, or hiding the tab can stop the recording.

These changes reduce unnecessary loss of completed work; they do not establish
that the underlying radio/USB interruptions have been solved.

## Code map

| File | Responsibility |
| --- | --- |
| `src/emg/cyton.rs` | Cyton packet parsing and optional CH7-to-CH1 mapping |
| `src/emg/pipeline.rs` | Enabled-channel mask and production signal processing |
| `src/emg/gesture.rs` | Six-gesture/three-axis session limits and restoration behavior |
| `src/emg/isolation.rs` | Bounded raw capture and independent production-filter replay |
| `src/lib.rs` | WASM interfaces, acquisition-to-capture integration |
| `www/isolation-core.mjs` | Stream health, sample-driven protocol, retries, summaries |
| `www/isolation-replay.mjs` | Record validation, CAR comparison, grouping and pattern metrics |
| `www/isolation-sequence.mjs` | Seven-step ordering, transition gates and terminal cancellation |
| `www/isolation.js` | Lab UI, movement instructions, local persistence, history and exports |
| `www/main.js` | Session setup, lab integration and simulated-control pause |
| `www/serial.js` | Active-channel board configuration and authorized-port reuse |
| `www/electrodes-six*.svg` | Six-channel placement and optional replacement guides |
| `serve.py` | Local serving and separate six-channel controller-calibration storage |

The existing controller still uses normalized envelopes, learned templates,
nonnegative least-squares fitting, thresholds, coupling rules and smoothing.
This branch does not replace it with a neural network or a new classifier.

## Run from a clean checkout

Prerequisites: Rust/Cargo, `wasm-pack`, Python 3, and a browser supporting Web Serial
(Chrome/Edge for hardware use). Node.js is needed for the JavaScript tests.

```sh
git clone --branch feature/emg-placement-lab-2026-10-31 https://github.com/maxwellarmstrong/NCL_emg_control.git
cd NCL_emg_control
rustup target add wasm32-unknown-unknown
cargo install wasm-pack  # only if not already installed
wasm-pack build --target web --out-dir www/pkg --no-typescript
python3 fetch_models.py  # optional detailed arm meshes; simple shapes work without them
python3 -u serve.py 8768
```

Open `http://127.0.0.1:8768/?session=six`.

For a software demonstration, click **Simulate**, then **Test electrode isolation**.
For actual acquisition, use **CONNECT EMG** and select the Cyton dongle if prompted.
Only one process/tab should own the serial device. Do not run a simultaneous
Python serial reader. Keep the recording tab visible.

Use the standard-procedure button for the full sequence, then export the
comparison set. Use **Calibrate + train** only for the separate controller
workflow. Existing templates should not be reused blindly after changing
placement or preprocessing.

Generated WASM and mesh downloads are ignored by Git and must be built/downloaded
locally. No physical arm is required for the placement lab. Physical robot
operation was not validated during this session.

## Validation and evidence limits

Automated checks:

```sh
node --test www/isolation-*.test.mjs  # 15 tests
cargo test                          # 65 tests
wasm-pack build --target web --out-dir www/pkg --no-typescript
node --check www/main.js
node --check www/isolation.js
node --check www/serial.js
git diff --check
```

Coverage includes disabled-channel behavior, fragmented mapping, production
replay equivalence, capture bounds, stream freshness, preserved completed blocks,
retry limits, malformed/invalid data rejection, comparison grouping, sequence
order/timing, readiness gating and terminal cancellation.

Browser synthetic checks exercised capture, actual WASM replay, local save/history,
automatic first-to-second movement progression, stop behavior and combined JSON
export. Synthetic checks are not evidence of improved human control accuracy.

A small human pilot produced four completed recordings: two rest controls and the
two rotation directions. The standard run stopped before the triceps comparison.
Rotation recordings were flagged weak/inconsistent by the current summaries;
there is not yet a complete dataset demonstrating optimal placement, reliable
rotation discrimination, or cross-session generalization. Participant recordings
remain in the local session backup, outside Git.

## Research direction and next work

Research notes from this session:

- [Signal filtering and referencing](docs/research/emg-filtering-research.md)
- [Gesture decoder options and evaluation](docs/research/emg-gesture-decoder-research.md)
- [Placement and generalization](docs/research/emg-placement-generalization-research.md)

These notes describe proposed experiments and literature, not implemented model
improvements. Their earlier-stage statements about missing human trials should
be read alongside the limited pilot status above.

Recommended next steps:

1. Complete the current-layout triceps/biceps/wrist comparisons and repeat the
   inconsistent rotation trials; document actual sites and posture.
2. Investigate sample interruptions separately from electrode pickup and
   biological coactivation. Compare the same raw recordings under CAR ON/OFF.
3. Test one placement or processing change at a time. A forearm-only layout is a
   candidate experiment, not an established improvement. Bipolar rewiring is deferred.
4. Benchmark the existing decoder against compact amplitude-feature baselines,
   with explicit uncertain/unknown-to-neutral behavior. Preserve proportional
   muscle control as a goal, not only discrete gesture labels.
5. Use whole-trial and later whole-session splits. Randomize cue order for model
   evaluation; never randomly split overlapping windows across train/test sets.
6. Consider a webcam as an optional calibration label/check source, with synchronized
   timestamps and confidence. Keep requested cue, observed motion and EMG prediction
   separate. Vision does not measure effort or all isometric contractions. No camera
   integration was implemented here; stereo is deferred.
7. Test a frozen model after electrode removal/reapplication on a later day before
   claiming no-recalibration or zero-shot performance.

The accomplished result is a usable, instrumented placement-comparison workflow
and software validation—not a proven optimal montage, noise-removal algorithm,
new trained network, or zero-shot controller.
