"""One causal SOS filter definition for offline training and live inference."""
from dataclasses import asdict, dataclass

import numpy as np
from scipy import signal


@dataclass(frozen=True)
class FilterConfig:
    sample_rate_hz: int = 250
    low_hz: float = 20.0
    high_hz: float = 100.0
    mains_hz: int = 60
    notch_q: float = 30.0
    order: int = 4
    warmup_seconds: float = 1.0

    @classmethod
    def for_rate(cls, rate: int, mains: int = 60):
        return cls(sample_rate_hz=rate, high_hz=min(450.0, rate * 0.4), mains_hz=mains)

    def validate(self):
        if self.sample_rate_hz not in (250, 500, 1000, 2000):
            raise ValueError("Supported rates: 250, 500, 1000, 2000 Hz")
        if not 0 < self.low_hz < self.high_hz < self.sample_rate_hz / 2:
            raise ValueError("Filter edges must satisfy 0 < low < high < Nyquist")
        if self.mains_hz not in (0, 50, 60) or self.notch_q < 5 or not 1 <= self.order <= 8:
            raise ValueError("Invalid mains, notch Q, or filter order")
        if not 0.1 <= self.warmup_seconds <= 10:
            raise ValueError("Warmup must be between 0.1 and 10 seconds")

    def sos(self):
        self.validate()
        sections = signal.butter(self.order, [self.low_hz, self.high_hz], btype="bandpass",
                                 fs=self.sample_rate_hz, output="sos")
        # A single narrow notch by default; no unnecessary notch at 120 Hz on the 250 Hz profile.
        if self.low_hz < self.mains_hz < self.high_hz:
            b, a = signal.iirnotch(self.mains_hz, self.notch_q, fs=self.sample_rate_hz)
            sections = np.vstack([sections, signal.tf2sos(b, a)])
        return sections

    def describe(self):
        sos = self.sos()
        f, h = signal.sosfreqz(sos, worN=1024, fs=self.sample_rate_hz)
        return {**asdict(self), "sos": sos.tolist(), "frequency_hz": f.tolist(),
                "gain_db": (20 * np.log10(np.maximum(np.abs(h), 1e-9))).tolist(),
                "causal": True, "common_average_reference": False,
                "note": "Initial EMG profile; optimal settings require held-out-session evaluation."}


class StreamingFilter:
    def __init__(self, config: FilterConfig, channels=8):
        self.config, self.channels = config, channels
        self.sos = config.sos()
        self.zi = None

    def reset(self):
        self.zi = None

    def process(self, x):
        x = np.asarray(x, dtype=np.float64)
        if x.ndim != 2 or x.shape[1] != self.channels or not np.isfinite(x).all():
            raise ValueError("Expected finite samples × channels")
        if not len(x):
            return x.copy()
        if self.zi is None:
            self.zi = signal.sosfilt_zi(self.sos)[:, :, None] * x[0][None, None, :]
        y, self.zi = signal.sosfilt(self.sos, x, axis=0, zi=self.zi)
        return y


def filter_segments(values, indices, config):
    """Reset at acquisition gaps; exclude the settling interval after every reset."""
    values, indices = np.asarray(values), np.asarray(indices)
    out = np.zeros_like(values, dtype=np.float64)
    valid = np.ones(len(values), dtype=bool)
    boundaries = np.r_[0, np.flatnonzero(np.diff(indices) != 1) + 1, len(indices)]
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        out[start:end] = StreamingFilter(config).process(values[start:end])
        valid[start:min(end, start + round(config.warmup_seconds * config.sample_rate_hz))] = False
    return out, valid
