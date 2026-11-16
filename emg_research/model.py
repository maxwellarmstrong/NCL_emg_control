"""Temporal feature extractor with regression, multilabel, and six-class heads."""
from functools import lru_cache
from pathlib import Path

import torch
from torch import nn


class FingerCNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv1d(8, 32, 7, padding=3), nn.GroupNorm(4, 32), nn.GELU(),
            nn.Conv1d(32, 64, 5, stride=2, padding=2), nn.GroupNorm(8, 64), nn.GELU(),
            nn.Conv1d(64, 96, 3, padding=2, dilation=2), nn.GroupNorm(8, 96), nn.GELU(),
            nn.AdaptiveAvgPool1d(1), nn.Flatten(), nn.Dropout(.15))
        self.flexion = nn.Linear(96, 5)
        self.active = nn.Linear(96, 5)
        self.gesture = nn.Linear(96, 6)

    def forward(self, x):
        z = self.features(x)
        return {"features": z, "flexion": self.flexion(z).sigmoid(),
                "active_logits": self.active(z), "class_logits": self.gesture(z)}


@lru_cache(maxsize=2)
def _load_cached(path, mtime_ns):
    # Only our locally trained tensor/primitives checkpoint; don't unpickle arbitrary models.
    saved = torch.load(path, map_location="cpu", weights_only=True)
    model = FingerCNN()
    model.load_state_dict(saved["state_dict"])
    model.eval()
    torch.set_num_threads(1)
    return model, saved["metadata"]


def load_model(path):
    path = Path(path)
    return _load_cached(str(path.resolve()), path.stat().st_mtime_ns)
