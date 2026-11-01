import pytest
from fastapi.testclient import TestClient
from emg_research import server


@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(server,'DATA',tmp_path)
    server.active.clear()
    return TestClient(server.app)


def test_hardware_rate_guard(client):
    assert client.post('/api/sessions',json={'source':'cyton','sample_rate_hz':2000}).status_code==422
    assert client.get('/api/filter?rate=250').json()['high_hz']==100


def test_record_retry_finalize_and_export(client):
    sid=client.post('/api/sessions',json={}).json()['id']
    sample={'index':0,'sequence':0,'t_ms':10,'received_ms':11,'uv':[1.]*8}
    batch={'batch_id':0,'emg':[sample]}
    assert client.post(f'/api/sessions/{sid}/batch',json=batch).status_code==200
    duplicate=client.post(f'/api/sessions/{sid}/batch',json=batch).json()
    assert duplicate['duplicate'] and duplicate['counts']['emg']==1
    assert client.post(f'/api/sessions/{sid}/batch',json={'batch_id':1,'emg':[sample]}).status_code==422
    assert client.get(f'/api/sessions/{sid}/export').status_code==409
    assert client.post(f'/api/sessions/{sid}/stop').json()['status']=='complete'
    assert client.get(f'/api/sessions/{sid}/export').content.startswith(b'PK')
    assert client.get('/api/sessions').json()[0]['counts']['emg']==1


def test_missing_visual_flexion_rejected(client):
    sid=client.post('/api/sessions',json={}).json()['id']
    result=client.post(f'/api/sessions/{sid}/batch',json={'batch_id':0,'vision':[{'t_ms':1,'processed_ms':2,'valid':True,'reason':'bad'}]})
    assert result.status_code==422


def test_disk_failure_rolls_back_batch_before_retry(client, monkeypatch):
    sid=client.post('/api/sessions',json={}).json()['id']
    batch={'batch_id':0,'emg':[{'index':0,'sequence':0,'t_ms':10,'received_ms':11,'uv':[1.]*8}]}
    original=server.save_metadata
    def fail(*args):
        raise OSError('simulated disk failure')
    monkeypatch.setattr(server,'save_metadata',fail)
    assert client.post(f'/api/sessions/{sid}/batch',json=batch).status_code==503
    assert (server.DATA/sid/'emg.jsonl').read_bytes()==b''
    assert server.active[sid]['meta']['counts']['emg']==0
    monkeypatch.setattr(server,'save_metadata',original)
    assert client.post(f'/api/sessions/{sid}/batch',json=batch).json()['counts']['emg']==1
    assert len((server.DATA/sid/'emg.jsonl').read_text().splitlines())==1
    assert client.post(f'/api/sessions/{sid}/stop').status_code==200
    assert client.post(f'/api/sessions/{sid}/stop').status_code==200


def test_failed_finalize_remains_retryable(client, monkeypatch):
    sid=client.post('/api/sessions',json={}).json()['id']
    original=server.save_metadata
    def fail(*args):
        raise OSError('simulated disk failure')
    monkeypatch.setattr(server,'save_metadata',fail)
    with pytest.raises(OSError):
        client.post(f'/api/sessions/{sid}/stop')
    assert server.active[sid]['meta']['status']=='recording'
    monkeypatch.setattr(server,'save_metadata',original)
    assert client.post(f'/api/sessions/{sid}/stop').json()['status']=='complete'
