"""Small shared 1D CNN with movement-class and camera-motion heads."""
import torch
from torch import nn


class GestureCNN(nn.Module):
    def __init__(self, num_classes, num_motion_targets=7):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv1d(8, 32, kernel_size=7, padding=3),
            nn.GroupNorm(4, 32),
            nn.GELU(),
            nn.Conv1d(32, 64, kernel_size=5, stride=2, padding=2),
            nn.GroupNorm(8, 64),
            nn.GELU(),
            nn.Conv1d(64, 64, kernel_size=3, padding=2, dilation=2),
            nn.GroupNorm(8, 64),
            nn.GELU(),
            nn.AdaptiveAvgPool1d(1),
            nn.Flatten(),
            nn.Dropout(0.15),
        )
        self.movement = nn.Linear(64, num_classes)
        self.motion = nn.Linear(64, num_motion_targets)

    def forward(self, x):
        features = self.features(x)
        return {
            "movement_logits": self.movement(features),
            "motion": self.motion(features).sigmoid(),
        }
