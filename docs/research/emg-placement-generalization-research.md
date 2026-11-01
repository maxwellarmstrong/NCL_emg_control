# EMG placement and session generalization: research recommendations

Research date: October 31, 2026. Scope: Maxwell’s right arm, six Cyton sensing inputs sharing SRB2, REF and BIAS, approximately 250 samples/s. This is a research report; no live settings, electrodes, decoder, or hardware were changed. Current implementation details below come from the task context, not a new empirical recording.

**Recommendation:** optimize distinguishable, repeatable gesture patterns rather than trying to find six perfectly independent muscles. Compare preprocessing first, then selected forearm placements, then entire new recording sessions. No paper establishes an optimal algorithm or electrode layout for this exact hardware and user.

## What can and cannot be filtered away

| Source of apparent interference | Evidence and implication |
|---|---|
| Genuine coactivation | Biceps and triceps can cooperate during tasks requiring supination torque and endpoint force. A study of eight healthy adults specifically investigated this coordination. Upper-arm activity during rotation is not necessarily electrical leakage. It should be represented in training or avoided through a better gesture vocabulary. [Borzelli et al., 2024](https://doi.org/10.1152/jn.00199.2023) |
| Neighboring-muscle pickup | Ultrasound and EMG showed neighboring muscles even within a conservative 15 mm pickup radius at forearm sites. Complete surface separation of individual forearm muscles was unlikely. The desired output is a distinct multichannel pattern, not proof of one isolated muscle. [Yung & Wells, 2013](https://pubmed.ncbi.nlm.nih.gov/23369877/) |
| Software mixing | The current pipeline subtracts the active-channel average before rectification. A lone channel waveform of amplitude A gives −A/6 on each other channel in a six-channel array. Rectification makes that activity visible. This is a confirmed arithmetic effect, not proof that it causes the reported failure. Compare CAR on/off using the same raw recording. |
| Shared-reference contamination | All present inputs measure relative to the same reference. Reference electrode activity or movement can therefore appear in many channels. CAR and hardware reference are different operations; disabling CAR does not remove the need for a reference. |
| Contact, cable movement, clipping, line interference | These require signal-quality checks and acquisition fixes before interpreting muscle independence. A saturation flag alone is not an electrode-impedance or contact-quality measurement. Clipped information cannot be recovered by a classifier. |

A frequency filter cannot generally separate two muscles producing overlapping EMG spectra. Regressing out triceps also risks removing valid rotation information if the muscles activate together. Evaluate that kind of subtraction against held-out gestures, rather than assuming all correlated activity is noise.

## What placement evidence actually supports

**Individual site selection is worth testing.** In 13 participants, a study surveyed 256 forearm channels, eight gestures, three wrist positions, and two force levels. Eight individually selected channels gave median online task completion of 71.4%, versus 57.1% for circumferential placement, although offline accuracy was similar. Sites were highly subject-specific. This supports the new placement lab and online validation, not a universal anatomy diagram or a guarantee from adding electrodes. [Pelaez Murciego et al., 2022](https://link.springer.com/article/10.1186/s12984-022-01056-w)

**Forearm-only is a candidate layout, not an established optimum.** A 2024 study found wrist and middle-forearm placement generally outperformed elbow placement for its tested gestures; varied-position training improved robustness. Its task set and sensors differ from our rotation and reach controls, so the ranking cannot be transferred directly. [Wang et al., 2024](https://link.springer.com/article/10.1186/s12984-024-01466-y)

**Six sensing pads are not six standard bipolar EMG channels.** OpenBCI’s EMG guide uses two electrodes per channel, local positive/negative measurement, SRB2 disabled, plus BIAS. Our six shared-reference inputs use a different spatial measurement. A later comparison of three local bipolar channels against six shared-reference inputs could fit the available lead budget, but would require a deliberate wiring/configuration experiment and retraining. It is not an instruction to rewire now. [OpenBCI EMG setup](https://docs.openbci.com/GettingStarted/Biosensing-Setups/EMGSetup/)

For a forearm-only experiment, distribute sensing sites around the forearm rather than crowding one patch. Record longitudinal distance from a defined elbow landmark, angular position, electrode type, and channel identity. Screen wrist flexion/extension, hand opening/comfortable closure, and pronation/supination. Treat these as candidate classes; retain fewer if some are indistinguishable. Removing upper-arm pads also removes the direct biceps/triceps measurements used by existing reach mappings.

## Make the new 46-second placement test scientifically useful

The existing raw-plus-envelope capture and three holds are a good **screening** tool. Three holds of one movement do not establish classification accuracy or session robustness. Proposed upgrades for the experiment design:

Direct inspection of `www/isolation-core.mjs` confirms the 46-second schedule: 3 seconds settling, 10 seconds initial rest, then three cycles of 3 seconds prepare, 3 seconds hold, and 5 seconds recover. Analysis discards the first 0.5 seconds of rest and each hold; all three hold deltas use the same initial baseline. Recovery summaries use the last second of each recovery. Therefore:

- Match the initial relaxed arm/wrist posture to the movement being tested. Changing the supported posture while beginning a contraction confounds posture with gesture.
- Show recovery-versus-initial-baseline drift and flag incomplete return to rest. Later add a stable relaxed baseline before each repetition, with global and local-baseline results shown together. Do not use the anticipatory prepare phase as if it were confirmed rest.
- Three 2.5-second scored holds are limited independent evidence, even though they contain many samples. Counterbalance gesture order across runs and repeat later to expose fatigue/learning; add multiple postures as separate labeled blocks after the basic screen.
- Label selected-channel share as **processed response concentration**, not muscle independence. In the ideal six-channel CAR example, one isolated source produces rectified amplitude 5A/6 on its own channel and A/6 on each other channel: its share is only 50%, despite perfect isolation before referencing. This arithmetic example assumes zero baseline and identical linear downstream filtering; it is not a prediction of Maxwell’s measured percentages.

1. **Use every gesture against every channel.** A channel that responds strongly to wrist extension is not useful if it responds identically to every other movement. Summarize the gesture-by-channel response matrix and across-repeat variation, alongside rest quality.
2. **Preserve a baseline layout.** First compare CAR variants on identical captured samples. Then change one site at a time. Repeat the original condition occasionally (A–B–A) to expose fatigue, contact drift, and learning effects.
3. **Record metadata sufficient for replay.** Session/layout/run/repetition IDs; physical channel mapping; sample counter and gaps; gain/reference/CAR/filter settings and application version; cue transitions; intended movement; posture/effort notes; unsuccessful or aborted trials. Preserve original raw data.
4. **Separate cue time from verified motion.** Instructions are labels of intended action, not measured ground truth. Mark failed attempts and analyze stable hold interiors separately from onset/offset. Retain transitions for later real-time testing rather than silently deleting all difficult samples.
5. **Add whole new runs.** Repeated comfortable effort levels and ordinary arm positions matter more than thousands of overlapping windows from one hold. Include rest and distracting movements, including triceps-only trials in Layout A, to measure false rotation.
6. **Score actual behavior.** Report class-wise recall/confusion, wrong-command events per minute during rest/distractors, onset-to-command latency, false sustained commands, and rejected-command coverage. A high-accuracy model that rarely accepts a gesture is not a good controller.

Split by complete repetitions/runs for initial evaluation; later split by complete sessions and re-donnings. Select sites, thresholds, normalization settings, and models using training/validation data only. Never scatter overlapping windows from the same contraction across train and test. Confidence intervals should use trials or sessions as the resampling unit, not highly correlated windows. These are proposed evaluation safeguards, not published results from this system.

## A realistic route to less calibration

| Priority | Approach | Evidence and limits |
|---|---|---|
| First | Repeatable mounting plus training from several sessions | A cross-session study found more training sessions more beneficial than more trials from existing sessions. Its own participant sample was small and supplemented by NinaPro data, but the result directly motivates collecting re-donnings rather than one exhaustive calibration. [Yao et al., 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC10857392/) |
| First | A simple frozen decoder baseline on pooled sessions | Compare the existing template model with a regularized classifier; keep the comparison small and interpretable. Improvements must survive a later session, not only shuffled within-session data. This is our proposed baseline, not a claimed best classifier. |
| Second | Causal normalization ablation | Sliding-window normalization reduced electrode-shift degradation from 7.6 to 1.0 percentage points in one study. It tested only rest/elbow flexion/extension and offline outcomes, not our six gesture classes. Normalization may erase useful amplitude cues or amplify rest noise; preserve absolute-energy features and test rest false positives separately. [Tanaka et al., 2025](https://pubmed.ncbi.nlm.nih.gov/40648374/) |
| Second | Explicit position verification or brief recalibration as fallback | Armband position verification restored online control after a 1.5 cm rotation with about 15.5 seconds of interactive adjustment on average. This supports repeatable donning, but it is not zero intervention and does not transfer directly to loose individual pads. [He et al., 2020](https://pubmed.ncbi.nlm.nih.gov/32244236/) |
| Later | Supervised transfer learning | CNN adaptation with a few seconds per class helped after roughly 2.5 cm electrode shifts in 13 subjects. It is reduced calibration, not calibration-free recognition, and needs more data than we have now. [Ameri et al., 2020](https://pubmed.ncbi.nlm.nih.gov/31880557/) |

Define success initially as **same user, new day/re-donning, frozen model, no labeled calibration from that evaluation session**. If unlabeled adaptation is used, report it explicitly and make it causal: only earlier samples may influence a current prediction. Retain a no-adaptation baseline; do not permit confident-but-wrong predictions to silently retrain the model without validation.

NinaPro DB6 is useful for checking evaluation code because it contains ten participants, seven grasps, twelve repetitions, twice daily for five days. However, it uses 14 double-differential sensors at 2 kHz, so benchmark scores do not establish performance on our six shared-reference 250 Hz inputs. [Official dataset protocol](https://ninapro.hevs.ch/instructions/DB6.html)

Cross-person calibration-free performance has been demonstrated with a 16-channel bipolar 2 kHz wristband and models trained on thousands of participants. That is evidence the long-term goal is possible, not a drop-in solution or a suitable first model for our small dataset. [Kaifosh, Reardon & CTRL-labs, 2025](https://www.nature.com/articles/s41586-025-09255-w)

**Immediate research decision:** preserve the live setup, collect labeled placement-lab runs, and compare preprocessing and class separation offline before replacing the decoder. Hardware, placement, gesture vocabulary, and decision rules all need measurement; a filter alone cannot guarantee reliable control.
