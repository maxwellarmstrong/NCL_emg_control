"""A bounded residual-control research harness, not a physical-hand controller."""
import argparse
import json
from pathlib import Path

import gymnasium as gym
import numpy as np
from gymnasium import spaces


class ResidualFingerEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, episode_steps=200, residual_limit=.15):
        super().__init__()
        self.episode_steps = episode_steps
        self.residual_limit = residual_limit
        self.action_space = spaces.Box(-1., 1., (5,), dtype=np.float32)
        self.observation_space = spaces.Box(-2., 2., (20,), dtype=np.float32)
        self.dt = .05

    def _target(self):
        return .5 + .4 * np.sin(self.phase + self.steps * self.dt * self.frequency)

    def _observation(self):
        # Target/visual labels are deliberately excluded. Replace this noisy surrogate
        # with a frozen EMG decoder and independent hand dynamics in the next experiment.
        self.base = np.clip(self._target() + self.bias + self.np_random.normal(0, .025, 5), 0, 1)
        return np.concatenate([self.base, self.position, self.velocity, self.previous]).astype(np.float32)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.steps = 0
        self.phase = self.np_random.uniform(0, 2 * np.pi, 5)
        self.frequency = self.np_random.uniform(.3, 1.2, 5)
        self.bias = self.np_random.uniform(-.12, .12, 5)
        self.position = np.full(5, .5)
        self.velocity = np.zeros(5)
        self.previous = np.zeros(5)
        return self._observation(), {"synthetic": True}

    def step(self, action):
        action = np.asarray(action, dtype=np.float64)
        if action.shape != (5,) or not np.isfinite(action).all():
            raise ValueError("Expected five finite residual actions")
        residual = np.clip(action, -1, 1) * self.residual_limit
        desired = np.clip(self.base + residual, 0, 1)
        move = np.clip(desired - self.position, -1.5 * self.dt, 1.5 * self.dt)
        self.position = np.clip(self.position + move, 0, 1)
        self.velocity = move / self.dt
        tracking = float(np.mean((self.position - self._target()) ** 2))
        smoothness = float(np.mean((residual - self.previous) ** 2))
        reward = -tracking - .05 * smoothness - .01 * float(np.mean(residual ** 2))
        self.previous = residual
        self.steps += 1
        return self._observation(), reward, False, self.steps >= self.episode_steps, {"tracking_mse": tracking, "synthetic": True}


def evaluate(policy=None):
    scores = []
    for seed in range(1000, 1005):
        env = ResidualFingerEnv()
        obs, _ = env.reset(seed=seed)
        errors = []
        done = False
        while not done:
            action = np.zeros(5) if policy is None else policy.predict(obs, deterministic=True)[0]
            obs, _, terminated, truncated, info = env.step(action)
            errors.append(info["tracking_mse"])
            done = terminated or truncated
        scores.append(float(np.mean(errors)))
    return {"tracking_mse_mean": float(np.mean(scores)), "episodes": scores}


def main():
    from stable_baselines3 import PPO, SAC
    from stable_baselines3.common.env_checker import check_env
    import torch
    torch.set_num_threads(1)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--algorithm", choices=["ppo", "sac"], default="ppo")
    p.add_argument("--steps", type=int, default=2048)
    p.add_argument("--output", type=Path, default=Path("artifacts/rl-smoke"))
    a = p.parse_args()
    env = ResidualFingerEnv()
    check_env(env)
    cls = PPO if a.algorithm == "ppo" else SAC
    options = {"n_steps": 128, "batch_size": 64} if a.algorithm == "ppo" else {"learning_starts": 256, "buffer_size": 10000, "batch_size": 64}
    policy = cls("MlpPolicy", env, seed=42, device="cpu", verbose=0, **options)
    policy.learn(total_timesteps=a.steps)
    a.output.mkdir(parents=True, exist_ok=True)
    policy.save(a.output / a.algorithm)
    report = {"algorithm": a.algorithm, "steps": a.steps, "zero_residual": evaluate(),
              "residual_policy": evaluate(policy), "synthetic_only": True,
              "note": "Infrastructure test only. No human EMG or physical actuator integration, and no claim of improvement."}
    (a.output / "evaluation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
