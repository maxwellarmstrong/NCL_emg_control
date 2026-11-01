# EMG signal-conditioning research — 31 October 2026

Research only. No hardware, live session, or application code changed. Scope: six shared-reference Cyton sensing electrodes, REF and BIAS, 250 samples/s. Actual dominant contamination is not yet established from labeled raw trials.

**Recommendation:** compare referencing strategies on the same raw recordings before adding stronger temporal filters. Preserve bandwidth, distinguish failed acquisition from ambiguous gestures, and judge filtering by held-out control performance rather than quieter-looking traces.

## Confirmed implementation findings

Implementation findings were checked against `src/emg/pipeline.rs`; local session notes are not included in this repository.

- Fourth-order 20 Hz high-pass, common-average referencing (CAR) enabled, two cascaded Q=5 notches at each of 60 and 120 Hz, absolute-value rectification, second-order 5 Hz envelope low-pass.
- CAR averages enabled, non-railed channels when at least three are available. It subtracts that mean before rectification. With six channels, a waveform A present only in CH3 produces 5A/6 there and −A/6 in every other channel. Rectification turns that redistributed waveform into positive activity. This is mathematically certain; its practical contribution to the user's errors is unmeasured.
- CAR also cancels perfectly shared contamination. It is not universally wrong, and removing it could expose significant reference or mains interference.
- “Contact” means a saturation test: over 95% ADC range causes a two-second holdoff, with a 90% recovery threshold. This does not establish good electrode impedance, detect every broken/intermittent cable, or prove low-noise acquisition. A changing CAR channel set also changes the spatial transform.

## Hardware and filtering evidence

**Bandwidth is more restricted than Nyquist alone suggests.** At 250 SPS, the ADS1299 datasheet lists a −3 dB bandwidth of approximately 65 Hz. Nyquist is 125 Hz, but response already attenuates well below it. The present 20 Hz high-pass and repeated 60 Hz notch therefore operate inside a limited useful band. This does not make gesture control impossible; it limits transferable spectral assumptions. Software cannot reconstruct missing high-frequency information. [TI ADS1299 datasheet, noise tables and digital filter sections](https://www.ti.com/lit/ds/symlink/ads1299.pdf)

The current USB-dongle radio path cannot stream above 250 Hz according to the manufacturer. Do not merely change the ADC rate and keep using the current parser/filter assumptions. A higher-bandwidth acquisition path is a separate hardware/firmware project, not a necessary first step. [OpenBCI Cyton SDK](https://docs.openbci.com/Cyton/CytonSDK/)

**20 Hz high-pass is a reasonable baseline, not a cure for all motion artifacts.** De Luca et al. experimentally evaluated baseline and motion contamination and recommended 20 Hz as a general compromise for their conditions. More aggressive filtering trades interference rejection for signal attenuation. Their full-band recordings differ from our already bandwidth-limited device, so their recommendation does not establish our optimum. Secure electrode/cable mechanics before increasing cutoff. [De Luca et al., 2010](https://doi.org/10.1016/j.jbiomech.2010.01.027)

**Notches remove physiological signal at the same frequencies as interference.** Mewett et al. compared notch filtering with spectrum interpolation on clean EMG contaminated with added line noise. Interpolation could perform better under their recording assumptions, but sub-Hz resolution involves long observation windows; it is not automatically suitable for a low-latency causal controller. First measure the actual line peak/drift, then compare a narrower/single notch against the existing repeated broad notch. Use the 120 Hz notch only when evidence shows benefit. [Mewett et al., 2004](https://pubmed.ncbi.nlm.nih.gov/15320462/)

## Spatial alternatives within eight leads

**Software bipolar derivations are an inexpensive offline experiment.** For shared-reference raw signals x1=v1−r and x2=v2−r, x1−x2=v1−v2. Subtract synchronized raw voltages before rectification/envelope extraction. Six sensing sites can provide three disjoint pairs, or several overlapping differences with only five independent spatial dimensions. Differences of envelopes are not equivalent. No wiring change is needed to test this, but current widely separated upper-arm/forearm sites are not local muscle pairs; a later paired layout would test a different pickup geometry. Subtraction cannot undo saturation or eliminate independent acquisition noise. This recommendation follows algebra, not a claim of validated gesture improvement.

**Hardware bipolar is a later controlled comparison.** OpenBCI's documented EMG arrangement uses two sensing electrodes per channel, BIAS, and SRB2 disabled for those channels. Eight leads can support three bipolar channels plus BIAS and a spare lead; six independent bipolar channels require thirteen leads including BIAS. This changes both montage and number of independent features, so compare task performance, not raw amplitude alone. Keep the current shared-reference wiring until deliberately redesigning the configuration. [OpenBCI EMG setup](https://docs.openbci.com/GettingStarted/Biosensing-Setups/EMGSetup/)

Do not assume a bipolar sensor isolates a single muscle. Spatial filtering reduces detection volume but anatomy and electrode geometry matter. A simulation study explicitly found spatial-filter performance depended on conditions. [Mesin et al., spatial-filter comparison](https://pubmed.ncbi.nlm.nih.gov/18585945/)

**Advanced crosstalk filtering is promising but lower priority.** Mesin's 2024 nonlinear spatiotemporal filter was calibrated using paired bipolar target/crosstalk recordings. Experiments involved pronator teres and flexor carpi radialis in eight healthy participants; reported crosstalk RMS reduction was approximately 20%, not complete separation. It requires calibration and a suitable montage, and is not evidence of improved zero-shot gesture accuracy on our system. Consider only after simpler baselines. [Mesin, 2024](https://pubmed.ncbi.nlm.nih.gov/38277703/)

## Prioritized experiments

These are proposed tests, not completed results. The new in-app placement lab can supply raw labeled trials; no real human isolation trial was analyzed for this report.

| Priority | Comparison | Main risk / interpretation |
|---|---|---|
| 1 | Same raw trial: existing CAR versus no CAR, all other settings fixed | CAR-off may improve spatial separation but worsen shared interference. Compare pre-rectification and envelope signals. |
| 2 | Existing notches versus one narrower 60 Hz notch; separately ablate 120 Hz | Narrow notches can miss drift; quiet traces can simply reflect lost EMG. Choose using held-out trials and measured peak widths. |
| 3 | Raw six-site features versus selected raw pair differences | Shared-reference cancellation can help, but differences may cancel useful coactivation. Current geometry is not a local bipolar layout. |
| 4 | Current high-pass/envelope versus a small predefined range of causal settings | Lower high-pass may recover useful signal or artifact; slower envelopes trade responsiveness for stability. Avoid a large search on little data. |
| 5 | Robust median referencing or calibrated spatial projection | Experimental here: potentially less sensitive to one focal source than mean CAR, but changes spatial patterns and can remove useful shared muscle activity. No direct validation identified for this exact montage. |
| 6 | Three hardware bipolar sites versus distributed six-site forearm montage | Requires explicit rewiring/configuration and loses sensor coverage. Only pursue if raw quality indicates a montage limitation. |

For each candidate, refit the decoder using only its training trials. Testing a changed filter with templates learned under the old filter confounds preprocessing with distribution mismatch. Split whole repetitions and later whole sessions; do not randomly split neighboring overlapping windows.

## Metrics and decisions

- Acquisition: packet continuity, raw clipping fraction, flatline/intermittency, channel mask changes, low-frequency transient energy, 60 Hz peak relative to neighboring spectrum. “Signal-to-noise ratio” cannot be known exactly without clean ground truth; report operational signal/rest ratios instead.
- Isolation: per-channel baseline median and variability, contraction-minus-rest response, repeat-to-repeat stability, off-target response during triceps-only and rotation-only movements. Correlation alone cannot distinguish common interference from real coactivation.
- Control: held-out per-class recall/confusion, false activations per minute during rest, false rotation during triceps-only trials, rejection rate, onset/stop latency, and live completion. Report accuracy together with rejected coverage so rejection cannot manufacture success.
- Invalid acquisition should suspend/reject output, not be smoothed into a plausible gesture. Consider calibration-preserving quality gates for clipping, gaps/stalls, flatlines and large transients. Thresholds must be validated; current rail flags are insufficient evidence of overall quality.

No temporal filter can reliably label overlapping physiological sources merely because one is unwanted for the current gesture. Real coactivation is primarily a representation/calibration problem. Keep rejection and robust gesture training alongside filtering; do not promise zero noise or identify a universally optimal algorithm before comparing real held-out data.

## Register verification and calculated filter response

Historical local register readbacks (not included in this repository) both contained CONFIG1=0x96. Its DR[2:0] bits are 110. TI Rev. C **page 46, Table 13** maps this to 250 SPS with the nominal clock; **page 17, Table 4** gives the 65 Hz bandwidth at gain 24. **Page 25, section 9.3.2.1, Equation 7** specifies the third-order sinc response. This is stronger evidence than inferring ADC configuration solely from packet rate, but is not a new live register read. [Manufacturer datasheet](https://www.ti.com/lit/ds/symlink/ads1299.pdf)

Calculated response using the exact RBJ coefficients in `src/emg/filter.rs`, current pipeline settings, and nominal ADS1299 fMOD=1.024 MHz, decimation4096:

| Input frequency | ADC sinc response | Software HP + four notches | Combined |
|---|---:|---:|---:|
| 30 Hz | −0.62 dB | −0.22 dB | −0.85 dB |
| 40 Hz | −1.11 dB | −0.28 dB | −1.39 dB |
| 50 Hz | −1.74 dB | −1.21 dB | −2.94 dB |
| 60 Hz | −2.52 dB | Ideal zero | Ideal zero |
| 70 Hz | −3.45 dB | −1.24 dB | −4.69 dB |

These are numerical transfer-function calculations, not measured hardware performance. They exclude CAR, which mixes channels, and rectification/envelope extraction, which is nonlinear. A 65 Hz corner is gradual attenuation, not a brick-wall cutoff. Lab-exported “raw” samples already passed through the ADC's hardware decimation filter; replay can change subsequent software filtering but cannot restore information absent from the acquired signal.
