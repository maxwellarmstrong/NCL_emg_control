"""Write reproducible frequency-response and phase-delay diagnostics for both profiles."""
import json
from pathlib import Path

import numpy as np
from scipy import signal

from emg_research.signal import FilterConfig


def report(rate):
    config = FilterConfig.for_rate(rate)
    frequencies = np.linspace(1, rate / 2 - 1, 20000)
    f, h = signal.sosfreqz(config.sos(), worN=frequencies, fs=rate)
    delay_ms = -np.gradient(np.unwrap(np.angle(h)), 2 * np.pi * f) * 1000
    interior = (f >= 30) & (f <= config.high_hz * .8) & (np.abs(f-config.mains_hz) > 10)
    probes = [2, 20, 40, 60, config.high_hz, rate*.49]
    _, response = signal.sosfreqz(config.sos(), worN=probes, fs=rate)
    return {'sample_rate_hz':rate, 'bandpass_hz':[config.low_hz,config.high_hz],
        'mains_hz':config.mains_hz, 'notch_q':config.notch_q,
        'probe_gain_db':dict(zip(map(str,probes),(20*np.log10(np.maximum(np.abs(response),1e-12))).tolist())),
        'interior_group_delay_ms':{'median':float(np.median(delay_ms[interior])),
            'min':float(np.min(delay_ms[interior])), 'max':float(np.max(delay_ms[interior]))},
        'delay_measurement_band':'30 Hz to 80% of upper cutoff, excluding ±10 Hz around mains',
        'note':'Frequency-dependent filter delay only; excludes camera, radio, windowing, inference, and display delay.'}


if __name__ == '__main__':
    path = Path('artifacts/filter-validation.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    data = {'profiles':[report(250),report(2000)],
        'conclusion':'Numerically validated starting profiles, not an empirical optimum for a participant.'}
    path.write_text(json.dumps(data,indent=2),encoding='utf-8')
    print(json.dumps(data,indent=2))
