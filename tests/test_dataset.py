import json
import numpy as np
import pytest

from emg_research.dataset import aligned_label, build_dataset
from emg_research.synthetic import generate
from emg_research.train import split_indices


def test_labels_do_not_bridge_occlusion_or_extrapolate():
    frames = [{'valid':True,'flexion':[0]*5}, {'valid':False,'flexion':None}, {'valid':True,'flexion':[1]*5}]
    t = np.array([0,30,60])
    assert aligned_label(frames,t,15) is None
    assert aligned_label(frames,t,45) is None
    assert aligned_label(frames,t,65) is None
    assert aligned_label([frames[0],frames[2]],np.array([0,200]),100) is None
    np.testing.assert_allclose(aligned_label([frames[0],frames[2]],np.array([0,60]),30), .5)


def test_session_splits_cannot_leak():
    with pytest.raises(ValueError, match='multiple'):
        split_indices(np.array(['a','a','b']),np.array(['train','val','test']))


def test_windows_and_fractional_hops(tmp_path):
    generate(tmp_path/'sessions',seconds=4)
    build_dataset(tmp_path/'sessions',tmp_path/'d.npz',allow_synthetic=True)
    with np.load(tmp_path/'d.npz') as data:
        assert data['x'].shape[1:] == (8,50)
        first = data['session'][0]
        hops = np.diff(data['end_ms'][data['session']==first])
        assert set(hops) == {48.,52.}
        assert set(data['split']) == {'train','val','test'}
        assert np.isfinite(data['x']).all()
        meta = json.loads(str(data['metadata']))
        assert meta['training_source']=='synthetic'


def test_synthetic_excluded_by_default(tmp_path):
    generate(tmp_path/'sessions',seconds=2)
    with pytest.raises(ValueError,match='No valid'):
        build_dataset(tmp_path/'sessions',tmp_path/'d.npz')


def test_mixed_wiring_is_rejected(tmp_path):
    generate(tmp_path/'sessions',seconds=2)
    path=next((tmp_path/'sessions').glob('*/metadata.json'))
    meta=json.loads(path.read_text())
    meta['config']['wiring']='common'
    path.write_text(json.dumps(meta))
    with pytest.raises(ValueError,match='wiring'):
        build_dataset(tmp_path/'sessions',tmp_path/'d.npz',allow_synthetic=True)


def test_window_rejects_interior_occlusion_and_post_clipping(tmp_path):
    generate(tmp_path/'sessions',seconds=4)
    folder = sorted((tmp_path/'sessions').iterdir())[0]
    meta = json.loads((folder/'metadata.json').read_text())
    frames = [json.loads(line) for line in (folder/'vision.jsonl').read_text().splitlines()]
    frame = min(frames, key=lambda f:abs(f['t_ms']-1600))
    occlusion_t = frame['t_ms']
    frame.update(valid=False, flexion=None)
    (folder/'vision.jsonl').write_text('\n'.join(map(json.dumps,frames)))
    samples = [json.loads(line) for line in (folder/'emg.jsonl').read_text().splitlines()]
    sample = min(samples, key=lambda s:abs(s['t_ms']-2400))
    clip_t = sample['t_ms']
    sample['clipped'] = True
    (folder/'emg.jsonl').write_text('\n'.join(map(json.dumps,samples)))
    build_dataset(tmp_path/'sessions',tmp_path/'d.npz',allow_synthetic=True)
    with np.load(tmp_path/'d.npz') as data:
        ends = data['end_ms'][data['session']==meta['id']]
        assert len(ends)>0
        assert not ((ends>=occlusion_t)&(ends<occlusion_t+196)).any()
        assert not ((ends>=clip_t)&(ends<clip_t+1196)).any()
