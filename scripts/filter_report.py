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
    probes = [2, 20, 40, 60, 65, config.high_hz, rate*.49]
    _, response = signal.sosfreqz(config.sos(), worN=probes, fs=rate)
    result = {'sample_rate_hz':rate, 'bandpass_hz':[config.low_hz,config.high_hz],
        'mains_hz':config.mains_hz, 'notch_q':config.notch_q,
        'probe_gain_db':dict(zip(map(str,probes),(20*np.log10(np.maximum(np.abs(response),1e-12))).tolist())),
        'interior_group_delay_ms':{'median':float(np.median(delay_ms[interior])),
            'min':float(np.min(delay_ms[interior])), 'max':float(np.max(delay_ms[interior]))},
        'delay_measurement_band':'30 Hz to 80% of upper cutoff, excluding ±10 Hz around mains',
        'note':'Frequency-dependent filter delay only; excludes camera, radio, windowing, inference, and display delay.'}
    if rate == 250:
        # TI ADS1299 Rev C Eq. 7: sinc^3 decimator, nominal fMOD=1.024 MHz,
        # R=4096 at 250 SPS. This is a calculated hardware model, not a measurement.
        adc = (np.sinc(np.asarray(probes)/250) / np.sinc(np.asarray(probes)/1024000))**3
        result['nominal_cyton_adc'] = {
            'adc_gain_db': dict(zip(map(str,probes),(20*np.log10(np.abs(adc))).tolist())),
            'adc_plus_software_gain_db': dict(zip(map(str,probes),(20*np.log10(np.maximum(np.abs(adc*response),1e-12))).tolist())),
            'datasheet_bandwidth_3db_hz': 65,
            'source': 'https://www.ti.com/lit/ds/symlink/ads1299.pdf',
            'note': 'Nominal ADS1299 at 250 SPS; no live register read or hardware measurement. The 20–100 Hz software passband is not a flat ADC passband.'}
    return result


if __name__ == '__main__':
    path = Path('artifacts/filter-validation.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    data = {'profiles':[report(250),report(2000)],
        'conclusion':'Numerically validated starting profiles, not an empirical optimum for a participant.'}
    path.write_text(json.dumps(data,indent=2),encoding='utf-8')
    print(json.dumps(data,indent=2))
