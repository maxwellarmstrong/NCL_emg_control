# Storage and integration with existing repository work

Reviewed on November 1, 2026: the three remote branches in
`maxwellarmstrong/NCL_emg_control` and its open research pull request.

## Recording locations

| Workflow | Primary storage | Export |
|---|---|---|
| Research acquisition app | Server filesystem, default `data/sessions/<uuid>/` | ZIP containing raw JSONL/metadata and SHA-256 manifest |
| Existing placement lab | IndexedDB `emg-isolation-v1`, stores `recordings` and `summaries` | Individual-recording JSON or comparison-set JSON |
| Imported placement trials | Same server recording directory, separate typed session folders | Original record content in `placement.json`, provenance metadata, and the same ZIP format |
| CNN datasets/models | `artifacts/` by default | Local NPZ, PyTorch checkpoint and evaluation JSON |

The research app writes directly to disk as batches are acknowledged. **Download
ZIP is an additional copy**, delivered to the browser's download location (often
Downloads). It does not move the originals or upload them to GitHub. The Session
Library shows the actual directory. Clearing browser site data does not erase
these server files, but can erase placement-lab IndexedDB records. Export placement
records before clearing site data or changing browser profiles. IndexedDB is
scoped to the exact origin, including host and port: `localhost:8080` and
`127.0.0.1:8768` have different databases.

The existing arm controller's saved calibration is another format. It is not
interchangeable with camera calibration or a CNN checkpoint.

## A practical storage arrangement

Capture on a reliable local disk. A dedicated recording directory outside code
checkouts is useful when switching branches/worktrees or collecting substantial data:

```powershell
$env:EMG_DATA_DIR = 'D:\EMG\recordings'
powershell -File scripts/start-lab.ps1
```

Choose a directory appropriate for your machine; this path is an example. Server,
dataset CLI, placement importer and archive CLI all honor `EMG_DATA_DIR`. The server
also accepts `--data-dir`, and the launcher accepts `-DataDir`. `--sessions` can
explicitly select dataset input. A variable set in one terminal does not change an
already-running server. Changing configuration does not move existing recordings.

Use immutable, checksum-verified ZIPs for completed sessions. The app has a
**Download completed recordings** link, or run:

```powershell
.\.venv\Scripts\python.exe -m emg_research.storage backup --output artifacts/backups/session-set-01.zip
.\.venv\Scripts\python.exe -m emg_research.storage verify artifacts/backups/session-set-01.zip
.\.venv\Scripts\python.exe -m emg_research.storage restore artifacts/backups/session-set-01.zip --data-dir D:\EMG\restored
```

Backup includes completed session folders, including placement imports, and skips
unfinished sessions. Individual export can preserve an interrupted session for
inspection. Each archived file has a SHA-256 digest and byte count in
`manifest.json`. Verification detects corruption, not ownership/authenticity:
someone able to replace both files and manifest can recompute the hashes.
Restore verifies the whole archive before writing, rejects unsafe member paths,
skips identical sessions, and refuses conflicting existing data. It never
overwrites a recording. Run restore while the recorder is stopped. Older ZIPs
without the new manifest cannot use verified restore; their raw files remain
available for manual inspection. Backup refuses an existing output filename.

Keep a second copy on an independent private backup device or deliberately chosen
private backup service. An archive next to the recordings is portable but does
not protect against losing the disk. No automatic cloud sync or encryption is
implemented. Copy completed archives to a backup destination instead of syncing
live append-only recording files. At larger scale, private object storage and a
shared metadata catalog would be reasonable additions. GitHub should hold code,
schemas and small synthetic fixtures, not human EMG or personal calibration files.

## Existing work that integrates now

Reviewed revisions:

- `main`: `9b4bf707c8aa1e2e33a91864952aad4fc9586539`.
- Initial research commit: `48789420a0a191f91c68239b78af69d030ee72c1`.
- [Placement-lab branch](https://github.com/maxwellarmstrong/NCL_emg_control/tree/feature/emg-placement-lab-2026-10-31):
  `42c4926e2d7ef7bf8905f208ea6c499dc5b954e3`.

The placement branch contains inherited work from Isaac's controller through
`07d9993`, as well as the October 31 placement lab. Its six-channel procedure,
raw capture, CAR ON/OFF replay, stream-readiness checks and bounded retry handling
complement the research app. The research app already reuses the repository's
Web Serial driver.

The implemented bridge accepts the placement lab's schema 1/2/3 completed trials
and schema 1 `emg-placement-comparison-set` exports. In the original placement
lab, choose **Export this recording (JSON)** or **Export this comparison set (JSON)**.
Then choose **Import placement-lab JSON** in the research Session Library, or run:

```powershell
.\.venv\Scripts\python.exe -m emg_research.placement path\to\placement-export.json --participant p01
```

Import validates the whole input before saving and deduplicates canonical record
content. `placement.json` preserves the original record object, including raw
logical-channel voltages, envelopes, flags, stages, summaries, placement notes,
channel mappings, processing settings, original IDs, packet stats and retries.
Metadata records the original export digest and upstream schema contract revision.
That revision identifies the schema reviewed by the importer, not proof of the
application version that generated an export. The limit is 64 MiB / 100 completed
trials; export smaller sets when needed. Incomplete/unscored attempts are rejected
and remain available in their original JSON. Import does not read or modify
IndexedDB directly. The UI uses the participant code entered in acquisition settings.

**Placement cues are not five-finger visual supervision.** These trials can use six
shared-reference channels across the upper arm/forearm, instructions such as
pronation/triceps, and retained blocks separated by discarded retries. Imports:

- Are marked `recording_kind=placement`, `label_kind=instruction_cue_only`, and
  `split=unassigned`; the finger dataset builder explicitly excludes them.
- Preserve blocks without inventing a continuous time axis or camera labels.
  CH7-to-logical-CH1 mappings are retained, not applied a second time.
- Keep synthetic demonstrations distinguishable from human recordings.
- Appear in the same session library and use the same exports and backups as
  research recordings, ready for later placement/gesture analyses.

The dataset builder now rejects mixed shared-reference/bipolar wiring, and live
prediction checks the model's recorded wiring. Rebuild datasets/retrain old
checkpoints missing that metadata. Matching wiring does not prove identical
electrode positions: anatomy, placement, channel order and protocols still need
experimental control.

## Work requiring a separate controller integration

| Existing work | Reuse path | Remaining compatibility issue |
|---|---|---|
| Six-channel configuration and CH7 substitution | Explicit acquisition profiles and channel-mask-aware models | Current research CNN expects eight channels; zero-padding is not validated transfer |
| StreamHealth and block retries | Compare readiness/stall handling with real-stream tests | Placement trials repeat blocks; continuous recordings retain gaps and reject affected windows |
| CAR ON/OFF Rust replay | Benchmark preprocessing on the same raw trials | Envelopes, CAR and waveform inputs differ; templates/models need refitting |
| Newer controller, ghost arm, calibration coach, physical RoArm control | Separate simulator/controller integration | Different joints, calibration formats and physical actuation behavior |
| Wi-Fi relay and calibration persistence | Deliberate backend route integration | Newer `serve.py` exposes `/shield/*`, `/calibration` and `/calibration-six`, absent from the research server's static `/arm/` mount |

A read-only merge preview of the initial research commit against the placement
branch reported README and `.gitignore` conflicts. Resolving those textual
conflicts alone would not validate the new controller/backend behavior. This work
does not rewrite that branch's history or activate physical robot interfaces.

## Filter finding carried forward

The placement branch distinguishes ADC response from Nyquist. At nominal 250 SPS,
TI lists about **65 Hz at −3 dB** for the ADS1299 sinc-cubed decimator (Table 4).
This is gradual roll-off, not a hard cutoff. The research **20–100 Hz software
band-pass is not a flat 20–100 Hz hardware response**. No software restores lost
bandwidth. `scripts/filter_report.py` now reports nominal ADC-only and combined
gains for the Cyton profile, assuming nominal clock/decimation settings. These are
calculations, not new measurements or register readbacks.
[TI ADS1299 datasheet, Table 4 and Equation 7](https://www.ti.com/lit/ds/symlink/ads1299.pdf)

Placement trials support comparisons of CAR, mains rejection, pickup geometry and
quality. Camera labels support a different experiment: continuous finger decoding.
Both workflows are useful without treating their labels as interchangeable.

## Validation

33 Python and four JavaScript tests passed after this integration. Coverage adds
checksum verification, safe restore/conflict rejection, placement validation and
deduplication, API imports/library exports, and wiring compatibility. A synthetic
six-channel record with CH7 substitution was generated and accepted by the actual
upstream JavaScript validator at the pinned revision, then accepted by the Python
importer. Existing completed synthetic sessions were backed up, verified and
restored to a separate test directory. Human placement records were not migrated
or uploaded by these checks.

The browser displayed the imported synthetic trial and downloaded an archive
successfully. Import was exercised through the local HTTP API and CLI; the
automation extension's file-URL restriction prevented completing the automated
file-picker upload check. Manual browser file selection does not require that
automation permission.
