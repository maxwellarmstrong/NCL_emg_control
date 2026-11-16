import json

import pytest
from fastapi.testclient import TestClient

from emg_research import server
from emg_research.placement import import_document
from emg_research.dataset import build_dataset
from emg_research.storage import create_archive, verify_archive


def test_upstream_import_preserves_blocks_mapping_and_deduplicates(tmp_path, placement_record):
    body=json.dumps({'schema':1,'type':'emg-placement-comparison-set','recordings':[placement_record,placement_record]}).encode()
    result=import_document(body,tmp_path/'sessions','fixture')
    assert result['imported']==1
    folder=tmp_path/'sessions'/result['session_ids'][0]
    meta=json.loads((folder/'metadata.json').read_text())
    assert meta['counts']['emg']==11500 and meta['counts']['vision']==0
    assert meta['config']['physical_channels']==[7,2,3,4,5,6]
    assert not meta['training_eligible'] and meta['config']['split']=='unassigned'
    assert json.loads((folder/'placement.json').read_text())==placement_record
    assert not (folder/'vision.jsonl').exists() and not (folder/'emg.jsonl').exists()
    assert import_document(json.dumps(placement_record).encode(),tmp_path/'sessions','fixture')['already_present']==1
    with pytest.raises(ValueError,match='Placement cues'):
        build_dataset(tmp_path/'sessions',tmp_path/'dataset.npz',allow_synthetic=True)
    create_archive([folder],tmp_path/'backup.zip')
    assert f'{folder.name}/placement.json' in verify_archive(tmp_path/'backup.zip')['files']


@pytest.mark.parametrize('problem',['interrupted','missing_rows','bad_flag','bad_mapping','nan'])
def test_invalid_placement_rejected_without_writes(tmp_path, placement_record,problem):
    if problem=='interrupted':placement_record['status']='incomplete-unscored'
    if problem=='missing_rows':placement_record['stages'][1]['rows'].pop()
    if problem=='bad_flag':placement_record['stages'][1]['rows'][0][16]=0
    if problem=='bad_mapping':placement_record['metadata']['physicalChannels']=[1]*6
    if problem=='nan':placement_record['metadata']['notes']=float('nan')
    with pytest.raises(ValueError):
        import_document(json.dumps(placement_record).encode(),tmp_path/'sessions')
    assert not (tmp_path/'sessions').exists()


def test_local_import_api_library_and_archive(tmp_path,monkeypatch,placement_record):
    monkeypatch.setattr(server,'DATA',tmp_path/'sessions')
    server.active.clear()
    client=TestClient(server.app)
    assert client.get('/api/export').status_code==404
    response=client.post('/api/import/placement?participant=fixture',json=placement_record)
    assert response.status_code==200, response.text
    rows=client.get('/api/sessions').json()
    assert rows[0]['recording_kind']=='placement'
    assert rows[0]['placement']['movement']=='pronation'
    archive=client.get('/api/export')
    assert archive.status_code==200
    (tmp_path/'backup.zip').write_bytes(archive.content)
    assert len(verify_archive(tmp_path/'backup.zip')['files'])==2
    client.post('/api/sessions',json={})
    assert client.post('/api/import/placement',json=placement_record).status_code==409
    server.active.clear()
