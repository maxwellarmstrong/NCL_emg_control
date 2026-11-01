import hashlib
import json
import uuid
import zipfile

import pytest

from emg_research.storage import create_archive, verify_archive, restore_archive, completed_sessions, data_directory


def session(root, status='complete'):
    folder = root / str(uuid.uuid4())
    folder.mkdir(parents=True)
    (folder/'metadata.json').write_text(json.dumps({'id':folder.name, 'status':status}))
    (folder/'emg.jsonl').write_text('{"uv":[1,2,3,4,5,6,7,8]}\n')
    return folder


def test_verified_backup_restore_and_duplicate(tmp_path):
    folder = session(tmp_path/'source')
    session(tmp_path/'source',status='recording')
    archive = tmp_path/'backup.zip'
    manifest = create_archive(completed_sessions(tmp_path/'source'), archive)
    assert len(manifest['files'])==2
    assert verify_archive(archive)==manifest
    assert restore_archive(archive,tmp_path/'restored')=={'restored':1,'already_present':0}
    assert (tmp_path/'restored'/folder.name/'emg.jsonl').read_bytes()==(folder/'emg.jsonl').read_bytes()
    assert restore_archive(archive,tmp_path/'restored')=={'restored':0,'already_present':1}
    with pytest.raises(FileExistsError):
        create_archive([folder],archive)


def test_checksum_failure_does_not_restore(tmp_path):
    folder = session(tmp_path/'source')
    create_archive([folder], tmp_path/'good.zip')
    with zipfile.ZipFile(tmp_path/'good.zip') as original, zipfile.ZipFile(tmp_path/'bad.zip','w') as bad:
        for name in original.namelist():
            bad.writestr(name, b'changed' if name.endswith('emg.jsonl') else original.read(name))
    with pytest.raises(ValueError,match='Checksum'):
        restore_archive(tmp_path/'bad.zip',tmp_path/'restored')
    assert not (tmp_path/'restored').exists()


def test_restore_rejects_conflicts_and_path_traversal(tmp_path):
    folder = session(tmp_path/'source')
    create_archive([folder], tmp_path/'good.zip')
    (folder/'emg.jsonl').write_text('a local edit')
    with pytest.raises(ValueError,match='differs'):
        restore_archive(tmp_path/'good.zip',tmp_path/'source')
    assert (folder/'emg.jsonl').read_text()=='a local edit'
    data=b'escape'
    with zipfile.ZipFile(tmp_path/'evil.zip','w') as archive:
        archive.writestr('../outside',data)
        archive.writestr('manifest.json',json.dumps({'schema_version':1,'files':{'../outside':{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}}}))
    with pytest.raises(ValueError,match='Unexpected'):
        restore_archive(tmp_path/'evil.zip',tmp_path/'restored')
    assert not (tmp_path/'outside').exists()


def test_environment_and_override_share_directory(tmp_path,monkeypatch):
    monkeypatch.setenv('EMG_DATA_DIR',str(tmp_path/'configured'))
    assert data_directory()==(tmp_path/'configured').resolve()
    assert data_directory(tmp_path/'explicit')==(tmp_path/'explicit').resolve()
