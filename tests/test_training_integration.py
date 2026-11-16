import numpy as np
from fastapi.testclient import TestClient

from emg_research import server
from emg_research.dataset import build_dataset
from emg_research.synthetic import generate
from emg_research.train import train


def test_train_checkpoint_and_live_prediction_roundtrip(tmp_path, monkeypatch):
    generate(tmp_path/'sessions', seconds=4)
    build_dataset(tmp_path/'sessions',tmp_path/'data.npz',allow_synthetic=True)
    train(tmp_path/'data.npz',tmp_path/'artifacts/model.pt',epochs=1)
    monkeypatch.setattr(server,'ROOT',tmp_path)
    with np.load(tmp_path/'data.npz') as data:
        window=data['x'][0].T.tolist()
    client=TestClient(server.app)
    response=client.post('/api/predict',json={'sample_rate_hz':250,'mains_hz':60,'filtered_uv':window})
    assert response.status_code==200, response.text
    prediction=response.json()
    assert prediction['training_source']=='synthetic'
    assert len(prediction['flexion'])==5 and all(0<=v<=1 for v in prediction['flexion'])
    assert client.post('/api/predict',json={'sample_rate_hz':250,'mains_hz':50,'filtered_uv':window}).status_code==409
    assert client.post('/api/predict',json={'sample_rate_hz':250,'mains_hz':60,'wiring':'common','filtered_uv':window}).status_code==409
