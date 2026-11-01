# EMG Arm

**October 31 placement-lab branch:** read [BRANCH_ACCOMPLISHMENTS.md](BRANCH_ACCOMPLISHMENTS.md) for the exact changes, upstream provenance, setup, validation, and next research steps.

Drive a Waveshare RoArm-M2-S desktop arm, simulated and optionally the real one,
with forearm/upper-arm muscle signals from an OpenBCI Cyton. The simulated arm uses
Waveshare's own joint chain and link meshes, so its four joints mean exactly what
the real arm's do: the base turns (left/right), the shoulder leans the upper arm
forward and back, the elbow bends the forearm, and the fourth joint opens and
closes the gripper. Kinematics, rendering (WebGL2) and the EMG signal chain are Rust
compiled to WASM; the page talks to the Cyton dongle directly via Web Serial.

## Local six-channel session (right arm)

Open `http://127.0.0.1:8768/?session=six` for today's configuration:
CH1–6 sensing electrodes plus separate shared REF and BIAS; CH7–8 are
powered down, removed from bias, and excluded from filtering/calibration/decoding.
The calibration includes six gestures for base rotation, coordinated reach and
elbow angle. The gripper remains manual. The original URL keeps eight-channel mode.

The numbered starting layout is in **Today's placement guide**. These are
candidate locations, not validated optimal placements. Keep the forearm supported,
check rest first, then test one gesture at a time before calibration. Rotation
is likely the hardest pair to separate; move one electrode at a time and repeat
the same test. This shared-reference arrangement follows this app's design;
OpenBCI's standard bipolar EMG setup uses different wiring/settings.

Six-channel calibration saves separately to `calibration-six.json`. Changing
sites requires recalibration. Software tests do not establish on-body accuracy.

## Build & run

One-time setup (Windows):

```powershell
winget install Rustlang.Rustup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

Build and serve:

```powershell
wasm-pack build --target web --out-dir www/pkg --no-typescript
python fetch_models.py   # once: Waveshare's arm meshes (MIT) into www/models/
python serve.py          # serves www/ on :8080 with caching disabled
```

Without the meshes the arm is drawn from simple shapes; everything else works the same.

Open <http://localhost:8080> in **Chrome or Edge** (Web Serial needs a Chromium
browser and a secure context; `localhost` counts).

Tests (parser, filters, pipeline, kinematics): `cargo test`

## Using it

- **Manual mode** (whenever EMG isn't connected): hold **+** or **−** under a joint in
  the bottom-left panel to move it that way, or the keys A/D base, W/S shoulder,
  F/R elbow, Q/E gripper (Q opens). Each column shows the joint's angle, and the real arm's
  while it's engaged. Drag the 3D view to orbit, scroll to zoom.
- **Gripper**: hold + to open it (up to 60°), − to close it, in any control mode;
  it stops where you let go, and EMG and drift leave it alone. To pick up the box,
  open it, bring the tool point to the box and close it; opening it again drops the
  box. The arm won't lower the tool point into the desk.
- **CONNECT EMG**: pick the Cyton dongle's COM port. The page resets the board,
  configures all 8 channels for EMG (gain 24, bias on, SRB2 on for the single-row
  cable), starts streaming and hands the arm joints to EMG. Disconnecting goes back
  to manual mode. Below it, two charts show packets/s (dashed line: the expected
  250) and dropped packets over the last 10 s; hover for a point's value.
- **Simulate**: generates a fake Cyton byte stream (DC offsets, 60 Hz hum, noise)
  that goes through the real parser and filters. Under muscle pairs, holding a joint
  key or button performs that axis's gesture (A/D base, W/S reach out/in, F/R elbow,
  E grip), so you can try calibration with no hardware.
- **Gain** (next to the joint buttons, muscle pairs only): how far a gesture
  drives its axis.

### Muscle pairs: gestures

Seven gestures, each tensed as a light *intention* with the arm held still:

| Gesture | Mostly | Drives |
|---|---|---|
| Wrist rotate in / out | pronator teres / supinator | **Base** + / − |
| Tricep extend / bicep curl | triceps / biceps | **Reach** out / in |
| Wrist back / wrist curl | wrist extensors / flexors | **Elbow** + / − (aims) |
| Grip | finger flexors | **Gripper** closes; it opens when you let go |

**Reach** moves the gripper tip in a straight line along the way the gripper
points, by working the shoulder and elbow together (`src/reach.rs`). The line is
taken when a reach starts and again whenever the base or elbow re-aim it, and the
reach stops at a joint limit or when the arm is nearly straight. Under muscle pairs
the shoulder only moves as part of a reach; the joint buttons still drive each
joint directly in manual mode.

Calibration learns each gesture's pattern across all 8 channels, so it doesn't
matter which electrode is on which muscle: put the electrodes on the muscles in
the guide, any channel each.

The wrist curl and wrist back electrodes go on the **lower third** of the forearm
(inner and back), well below the pronator teres and the supinator. Higher up, the
wrist flexors sit right next to the pronator, and in test calibrations wrist curl
was read as rotate in about a fifth of the time.

The 8th electrode, on the **brachioradialis** (thumb side of the forearm, just
below the elbow), has no gesture of its own. Rotate out, tricep extend, bicep curl
and wrist back look alike across the other channels, and rotate out was the most
often mixed up with tricep extend. The brachioradialis works in rotate out and
bicep curl but stays quiet in a tricep extend, so this channel tells them apart.
It used to go on the finger extensors to tell grip from wrist curl, but those two
already decoded cleanly (grip about 99% at faint strength) without it. If the
calibration results show a different pair mixed up, move it next to the muscles
of that pair, then recalibrate.

### First session with electrodes

1. Plug in the dongle (switch on **GPIO6**), turn the Cyton on (**PC** position).
2. Connect, then check that **Packets/s ≈ 250** and the channel bars sit near zero at rest.
3. Click **Calibrate + train** under Calibration (about 6 minutes plus however long
   you take to get into position). It opens on the electrode guide; **Electrodes are
   set up** continues. A guide over the 3D view then walks through each step. Every
   step holds on **Press Space when you're ready** (or the Ready button), counts down
   3-2-1, then records, with a progress bar at the bottom and audio cues:
   - **Rest, three positions** (10 s each, with a profile drawing of each): forearm
     limp on the table, forearm raised with the elbow on the table, arm held up
     unsupported. Each raised position is learned as a pattern of its own, so
     holding the arm up isn't read as a gesture.
   - **Phase 1, round by round** (5 s each, with an animation of the movement):
     every gesture hard, then every gesture about half as hard (this sets the
     ceiling). The pattern is re-learned from both rounds.
   - **Phase 2, training:** one gesture at a time, a small meter over the arm, and
     only that gesture's axis moves. Hold the line at the centre for a second.
     The level starts at its highest; two hits in a row lower it a step, a miss
     raises it, so it settles on the lightest intention you can hold reliably.

   The schedule runs on the board's sample clock, so the cue and the recorded window
   always line up. Recording only counts clean seconds (still at rest, the right
   gesture at the right strength), and **Skip** passes a step that won't work. At
   the end each gesture gets how often its half-strength round was told apart from
   the others, its training hits and its final level; **Redo** on its row recalibrates
   one, **Train only** practises again. The channel cells then show the gesture each
   channel responds to most. Space still stops the real arm during calibration.
4. Tune **Gain**: the axis speed when a gesture is held at its level. Nothing moves
   under EMG until a calibration has trained the gestures, and opposite gestures on
   one axis cancel.

## Finger grid mode

**Control scheme → Finger grid** swaps muscle pairs for 8 electrodes in a 2×4 grid
on the underside of the forearm, which is usually hairless (diagram: `www/finger-grid.svg`,
also under **Electrode guide**).

- **Grid placement:**
  - Upper row (CH1–4): a quarter of the way from the elbow crease to the wrist.
  - Middle row (CH5–8): halfway down.
  - Each row runs from the thumb side to the pinky side, with gel centres about 2 cm apart.
  - The order within a row (or even across rows) doesn't matter. Nothing in the decoder
    is tied to a position: calibration learns each finger's pattern from whatever site
    is on which channel. Recalibrate after moving electrodes.
  - With large pads (e.g. 3M Red Dot), trim or overlap the foam, but the gel spots must
    not touch. Tape over the grid.
- **Wiring:** either option works.
  - Single row (10 pads): REF on the elbow point.
  - Pairs (17 pads): two pads per site along the forearm.
- **Each finger drives one joint.** Defaults (change them in the panel):
  - Thumb → base
  - Index → shoulder
  - Middle → elbow
  - Ring + little → off
  - **Off** takes a finger out of the control: it drives nothing and is skipped in
    training. It's still calibrated, since the fit needs every finger's pattern to tell
    the others apart.
- **Simple bands (the default for now):** power under ¼ of the ceiling holds, ¼ to ½
  drives −, and over ½ drives + with no upper cap. There's a little hysteresis (back to
  rest under 0.2, back to − under 0.45), and real movements are *not* rejected. Turn
  **Simple bands** off in the panel for the adaptive bands below.
- **Adaptive bands:** how firmly you tense the finger picks the direction. Power runs
  from 0 (rest) to 1 (the ceiling, where the finger really starts to move):

  | Power | Joint |
  |---|---|
  | rest, plus a buffer | holds |
  | faint (around the finger's level) | − direction, once the level has settled for 0.15 s, so a rise to + never twitches − |
  | firmer (above the split) | + direction, after 0.1 s above it, so overshooting on the way to faint doesn't flick + |
  | above the ceiling | every joint holds: that's a real hand movement, not a command |

- **The stasis band** sits just above your measured resting noise (its 99th percentile
  plus a small margin, at least 4% of the ceiling).
- **Arm posture:** raising the forearm tenses the flexors under the grid a little, and
  without help that resting tone reads as finger tension.
  - Calibration records rest in three postures: limp on the table, forearm raised with
    the elbow down, and arm held up unsupported. Each raised posture becomes a pattern
    of its own.
  - A slow fit (averaged over 0.5 s, with the finger patterns in it too) works out
    which posture the arm is in. That posture's baseline is taken out before the finger
    powers are measured.
  - Each finger's noise floor blends between the floors measured in each posture.
  - The panel shows the posture the decoder sees (e.g. "forearm raised 89%").
  - Raised postures can be skipped; the limp one can't, since everything is measured
    against it.
- **Decoding:** each finger's power comes from a non-negative fit of all four finger
  patterns across the grid. A finger leaking onto its neighbours' electrodes doesn't
  move their joints, and electrodes that lose contact are left out of the fit.

**Calibrate + train** (about 4–5 min) runs two phases. All meters are averaged over
about 0.25 s so they don't jitter.

1. **Phase 1, round by round** (full-screen guide with a power bar). Each round goes
   through every finger before the next round starts:
   - **Round 1, strong flex** (a real movement): learns what each finger looks like.
   - **Round 2, half strength:** sets each finger's ceiling (the softest part of that
     flex). Every finger's strong pattern is known by now, so if a different finger
     is the one lighting up, the guide names it ("Index is stronger: keep the other
     fingers loose") and doesn't record.
   - **Round 3, faint:** tension only, in a box from just above your resting noise
     up to 30% of the ceiling. The same wrong-finger check applies. The round
     re-learns the finger's pattern only if it still looks more like that finger
     than any other; otherwise the results mark it "mixed" and leave the pattern alone.
2. **Phase 2, per finger** (a small meter over the 3D view, so the arm stays visible):
   - 8 trials alternate faint (−) and firmer (+).
   - The meter's centre line is the target level. The fill grows red to the right
     when you're over it and green to the left when you're under; each end is the
     edge of that band.
   - Bring it to the centre and hold for a second, while only that finger's joint moves.
   - **The targets stay put; the decoder learns you.** It watches where your faint
     and firm attempts really average (raw power over each trial's last second) and
     remaps that finger's power axis, so your typical faint lands mid −-band and
     your typical firm mid +-band.
     - The remap moves halfway toward what it saw the first time, then ⅓, ¼, ⅕ …,
       so it settles on your average rather than chasing you.
     - It carries over between **Train only** sessions until you recalibrate.
   - **Never ambiguous:** the remap keeps your faint and firm at least twice your
     own wobble apart (and at least 60% of the faint level), and it never stretches
     resting noise (1.3× the noise floor) over the rest line.
   - **Wobble filter:** the more fast jitter you have on a finger relative to the
     band width, the more that finger is smoothed. That runs from 60 ms up to at
     most 200 ms of extra lag. Slow drift doesn't count, since smoothing can't remove it.
   - The results show where you held each direction ("you held") and the smoothing
     each finger got.
   - (Adaptive bands) both targets always fit under the ceiling. In a noisy posture
     or on a weak finger they squeeze together, but the + band never disappears.

The results list each finger's faintest level, how often that faint tension read as
the right finger ("isolated"), training hits, and the final faint level.
**Redo** on a finger's row recalibrates just that finger. **Train only** practises
again.

**Drift ON / OFF** (button at the bottom of the panel, on by default): under EMG control, once no
joint has had a command for 1.5 s, the arm eases back to the home pose at up to 6°/s.
A joint you're holding still doesn't drift while you drive another one, and nothing
drifts while the real arm is engaged.

## Real arm (Waveshare RoArm-M2-S)

The simulation can drive a RoArm-M2-S plugged into this computer by USB, with the
same JSON serial commands as
[roarm-haptic-bridge](https://github.com/maxwellarmstrong/roarm-haptic-bridge)
(`www/roarm.js`). Close that repo's dashboard first: only one program can hold the port.

The two share joint angles 1:1.

1. **CONNECT ARM** (under CONNECT EMG), pick the RoArm's COM port (not the Cyton dongle).
   The simulated arm jumps to the real arm's pose and keeps mirroring it: move the
   real arm by hand and the simulation follows. Keys and EMG don't move anything yet.
2. **ENGAGE** to switch over. The simulation starts from the real arm's pose, so
   nothing jumps, and from then on the real arm is sent the simulation's pose
   (manual or EMG). The joint panel shows the real angles under the simulated ones,
   and the 3D view draws the real arm solid with the simulation's pose as a
   translucent ghost ahead of it: where the real arm is being sent.
   **DISENGAGE** goes back to mirroring.

**E STOP** (bottom right of the 3D view while the arm is connected) or **Space**
anywhere on the page stops the arm: every joint is sent its current position, and
nothing more is sent until you press Engage again.

Targets are clamped to the arm's limits (base ±180°, shoulder ±90°, elbow −20…169°,
gripper −10…90°) and move at most 60°/s. Disengaging, disconnecting, or the
arm going silent for 1 s stops the commands, and the arm holds where it is.

## Saved calibration

Both schemes' calibrations and the panel settings (gain, speed, finger → joint,
bands, drift) are saved to `calibration.json` next to `serve.py` whenever a
calibration finishes or a setting changes, and loaded when the page opens. Delete
the file to start over. It's per person and per electrode placement, so
recalibrate after moving electrodes. A file saved by an older build (a different
calibration format) is refused, and the page says so; it's replaced when the next
calibration finishes.

## Electrode placement

![Electrode placement and Cyton wiring](www/electrodes.svg)

The same diagram is in the app under **Calibration → Electrode guide**, and it's the
first page of **Calibrate + train**.

The Cyton's silkscreen labels both header rows N1P…N8P. The **bottom** row is each
channel's negative input, the **top** row its positive input. The app always uses a
single row with a shared REF (standard 10-lead cable): one electrode on each
muscle belly in the guide → **bottom** pin of any channel (8 muscles, all 8
channels; calibration learns which is which); **REF** on the elbow point (olecranon)
→ **bottom SRB** pin; **BIAS** on the wrist bone (ulnar styloid) → **bottom BIAS**
pin. Top row stays empty. The page turns SRB2 on (`x n 060110X`).


## Signal chain (per channel, 250 Hz)

Raw µV → 4th-order Butterworth high-pass 20 Hz → **common-average reference**
(single-row mode: subtract the mean of the channels with contact, cancelling the
hum and noise the shared REF puts on all of them) → wide notches (Q 5, each applied
twice) at mains and its 2nd harmonic → full-wave rectify → 5 Hz low-pass (envelope)
→ the gesture decoder below → per gesture, a speed from its power (0 past the rest
buffer, full at its level) × gain → axis velocity (reach turned into shoulder + elbow).

Channels whose input is railed (electrode off) are shown as **off**, left out of
the common average, and read as zero.

### Decoder: gestures across all channels (`src/emg/gesture.rs`)

- Each channel's envelope is measured against the limp rest (in standard
  deviations), the current arm position's baseline is taken out (a slow fit of
  the raised-position patterns), and what's left is explained as a non-negative
  mix of the calibrated gesture patterns (NNLS). Each gesture's weight is its
  power: 0 at rest, 1 at the ceiling.
- A gesture drives its axis once its power passes a buffer above its noise floor
  for 0.1 s, and keeps driving until it drops back to the floor. Speed grows to
  full at its level, which training tunes.
- **Up to two gestures at once (compound movements).** The strongest gesture always
  counts. The runner-up joins it once its power has stayed more than 2 standard
  deviations above what the strongest one's crosstalk would put on it for 0.1 s,
  and the pair holds until the weaker of the two drops under 1 standard deviation
  (whichever is stronger by then). That coupling, a slope and the scatter around it
  for every pair, is learned from each gesture's hard and half-strength
  recordings, smoothed the way the live decoder smooths, so a gesture that leaks
  onto another's pattern isn't read as both. A third gesture never counts.
  Opposite gestures on one axis cancel. The coupling comes from single gestures,
  so a real compound that looks different from the sum of its parts can still be
  missed.
- Electrodes without contact are left out of the fit.
- The overlay over the 3D view shows the gestures in play, how close each is to
  full speed, and the arm position the decoder thinks you're in.

The finger grid (`src/emg/finger.rs`) is calibrated the same way and is where this
approach came from.

Why: on a single-row setup the 60 Hz hum came in at about 290 µV, identical on
every channel. The board's clock puts it at about 59.9 Hz, where a narrow notch
barely works. The common average plus wide notches brought the resting envelope
from about 42 µV down to 2–4 µV.

## Troubleshooting

- **"No response from the board"**: wrong COM port, or the dongle switch is on RESET.
- **"Dongle answered but the board did not"**: Cyton off or out of range; try
  power-cycling both.
- **Data lags about half a second, or arrives in bursts / choppy**: set the FTDI latency
  timer to 1 ms (Device Manager → COM port → Port Settings → Advanced), then replug the
  dongle. The Windows default of 16 ms never expires on a continuous stream, so the driver
  waits for a full 4 KB transfer, which is about 480 ms of Cyton data. The setting is per
  dongle, so a new dongle needs it again.
- **Bars high at rest**: check skin prep/gel and that BIAS (and REF in single-row
  mode) are attached on bone; recalibrate rest.
- **Board never answers / BOARD_NOT_READY in the OpenBCI GUI, but the dongle reports
  "System is Up"**: the Cyton's main firmware is missing or non-standard. Reflash
  the official Cyton firmware (v3.1.2) through the dongle. To enter the bootloader,
  hold PROG while switching the board OFF → PC; the blue LED blinks.
- **Mains**: the notches are fixed at 60 Hz (and 120 Hz), for North America.

## Layout

```
src/arm.rs            RoArm-M2-S joint chain (Waveshare URDF), limits, velocity integration, desk stop
src/world.rs          desk and box: open/close the gripper on it to pick it up
src/render/           WebGL2 renderer, meshes, orbit camera, arm → parts
src/emg/cyton.rs      33-byte packet parser (resync, drop counting, µV scaling)
src/emg/filter.rs     biquads
src/emg/pipeline.rs   signal chain: high-pass, common average, notches, envelope, contact
src/reach.rs          muscle-pair axes → joints: reach along the gripper via shoulder + elbow
src/emg/gesture.rs    muscle-pair gestures: rest postures, strong → half rounds, training
src/emg/decoder.rs    non-negative least squares shared by the gesture and finger decoders
src/emg/finger.rs     finger grid: per-finger power, rest/faint/firmer bands, phase 1 + 2 coach
src/lib.rs            wasm-bindgen API used by the page
www/                  index.html, main.js (UI), serial.js (Web Serial), wifi.js (WiFi Shield, not in the UI),
                      roarm.js (real arm), simulator.js
```

### Temporary CH1 input replacement
Use `http://127.0.0.1:8768/?session=six&ch1=7` to test the same CH1 skin electrode/lead on the bottom N7P pin. CH2–6, REF and BIAS remain unchanged. Real acquisition enables physical CH2–7 and disables CH1/8; physical CH7 is routed into the original CH1 processing/control slot. Meters and the guide identify the physical replacement. The normal six-channel URL remains unchanged. Compare readings before drawing conclusions about a failed input versus electrode/lead contact.

### Electrode placement lab

Use **Test electrode isolation** to compare electrode sites independently of the gesture decoder. The dialog pauses simulation movement and disengages physical-arm following. Choose a movement, check the illustrated instructions, enter the placement name and channel locations, and press Ready. One test uses a 3-second settling period, a 10-second resting baseline and three repetitions of 3-second preparation, 3-second gentle hold and 5-second recovery. No chat timing is needed.

Each received Cyton packet contributes raw logical-channel µV, processed envelope µV and saturation flags. Timing follows received samples at 250 Hz. Brief packet gaps repeat the affected block; severe loss, sustained missing data, buffer overflow, a hidden tab or active-channel saturation stop the current test without scoring it. The first 0.5 seconds of each baseline/hold are excluded from summary statistics. Results show baseline and hold medians, baseline-relative changes per repetition and the strongest responding channel. Selected-channel share is descriptive, not classification accuracy or muscle purity; common-average referencing remains on.

Completed recordings and placement notes are saved locally in this browser's IndexedDB and can be exported as JSON. Synthetic demonstrations are labeled and shown separately from real recordings. Test records do not retrain or replace calibration. Use the same movement/posture/effort and change one electrode at a time. Raw values follow the optional CH7→logical CH1 mapping; metadata includes the displayed channel labels.

Validation: `node --test www/isolation-core.test.mjs`, `cargo test`, then the usual WASM build. A synthetic test automatically generates the selected channel's contraction during the Hold cue; it validates the workflow, not human performance.

### Same-recording CAR replay

The placement lab now includes a four-step rotation baseline: relaxed-rest control,
palm-down rotation, palm-up rotation, and triceps comparison. Individual steps are human-ready gated and record three observation/hold periods. The standard procedure described below can run them automatically. No wiring change is
needed. Keep comparison-set name, sites, posture and effort consistent within a set.

Every completed recording is independently replayed twice by the **production Rust
EmgPipeline** with CAR on/off. Both modes reset their filters separately for the baseline and each repetition,
using the 3-second settle/prepare period as warm-up. They do not reconstruct
previous live filter history or concatenate across discarded attempts. Live filters, templates and control settings are unchanged.

Results show baseline and per-repeat envelope changes for every channel. The
baseline report compares positive response patterns using cosine distance (0 same
shape, 1 no overlap), guarded against weak responses. It also shows rest levels and
CH1/CH2 responses during triceps activity. These are descriptive signal metrics,
not held-out accuracy, muscle independence, or false-command rates. The existing
gesture decoder is deliberately not applied across differently processed signals
using its old calibration.

Comparison grouping requires matching set name, layout, site notes, labels,
physical mapping, acquisition, source and processing settings. Latest matching
trial per action is displayed; all trials remain in history. Synthetic records
are separate. JSON exports include raw samples and both replay summaries. Old
complete v1 recordings can be replayed via View → Replay both modes. Unsupported,
incomplete or invalid records are rejected. Camera and model retraining are not
part of this feature.

Tests: `node --test www/isolation-*.test.mjs`, `cargo test`, and
`wasm-pack build --target web --out-dir www/pkg --no-typescript`.

The placement lab now verifies a fresh, roughly 250 Hz packet stream for a full
second before enabling Ready. An open serial port alone is insufficient. If
packets stop, the badge changes to waiting/stalled and stale meters are hidden;
the existing recording interruption checks remain strict. Reconnect reuses a
unique previously authorized FT231X dongle, with a chooser fallback when none or
multiple are available.

Packet-gap recovery: a small drop/resync discards the entire uncertain input
batch and rewinds the affected baseline or prepare/hold/recover block. Earlier
complete blocks are retained. Up to 3 retries/block and 8/run are allowed; more
than 25 missing packets or 3 parser resyncs in one batch, stream resets, long
stalls, disconnects and overflow still abort. These conservative retry limits
are engineering defaults. No samples are interpolated. Schema3 exports recovery
events and contiguous blocks; interrupted runs have an unscored partial export.
Replay version car-replay-v2-blocks reprocesses old compatible recordings before
including them in comparisons.


### One-start standard placement procedure

**Start standard procedure · 6:22** runs rest, pronation, supination, triceps,
biceps, wrist extension and wrist flexion, in that order. Seven 46-second
recordings plus six 10-second position changes total 382 seconds before save
latency, stream-readiness waits and packet retries. Instructions update before
each position-change countdown. Rest control cues refer to observations, never
contractions. The first start is user-gated; later movements start automatically.

Each movement is replayed and saved before progressing. Stop, close, hidden tab,
recording errors or a failed local save prevent further automatic progression.
Completed movements stay available; unfinished movements can be retried
individually. Every standard-procedure recording includes sequence ID, order
and index, without pooling samples between movements.

Storage: IndexedDB `emg-isolation-v1`, stores `recordings` and `summaries`, under
the exact browser origin (currently http://127.0.0.1:8768). Raw samples, movement
cues, placement/mapping metadata, retry logs and analysis are local to that browser.
Clearing site data, changing browser/profile or changing origin can remove or
hide access. **Export this comparison set (JSON)** downloads all completed
recordings matching the current set, source, layout, sites and processing;
repeat trials are retained. A completed but unsaved current record is also
included. Interrupted attempts have a separate unscored export. No cloud backup
is performed. Controller calibration is separate: the local server stores
`calibration-six.json` for this six-channel session (`calibration.json` otherwise).
The placement procedure does not train or overwrite the controller.

Sequence tests: `node --test www/isolation-*.test.mjs`.
