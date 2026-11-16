import numpy as np
import torch
from stable_baselines3.common.env_checker import check_env
from emg_research.model import FingerCNN
from emg_research.rl import ResidualFingerEnv


def test_model_supports_both_window_lengths_and_gradients():
    model=FingerCNN()
    for n in [50,400]:
        out=model(torch.randn(3,8,n))
        assert out['flexion'].shape==(3,5) and out['class_logits'].shape==(3,6)
        assert torch.all((out['flexion']>=0)&(out['flexion']<=1))
        out['flexion'].sum().backward()
    assert model.features[0].weight.grad is not None


def test_rl_contract_and_actuator_limits():
    env=ResidualFingerEnv(episode_steps=5)
    check_env(env)
    obs,_=env.reset(seed=1)
    assert obs.shape==(20,)
    previous=env.position.copy()
    for _ in range(5):
        obs,reward,terminated,truncated,info=env.step(np.ones(5,dtype=np.float32))
        assert np.max(np.abs(env.position-previous))<=.07500001
        assert np.all((env.position>=0)&(env.position<=1))
        assert np.isfinite(reward)
        previous=env.position.copy()
    assert truncated and not terminated
