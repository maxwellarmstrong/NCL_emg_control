import numpy as np
import pytest
from scipy import signal

from emg_research.signal import FilterConfig, StreamingFilter, filter_segments


@pytest.mark.parametrize('rate,high', [(250,100), (2000,450)])
def test_response(rate, high):
    config = FilterConfig.for_rate(rate)
    assert config.high_hz == high
    probes = [2, 40, 60, high * .8, rate * .49]
    _, response = signal.sosfreqz(config.sos(), worN=probes, fs=rate)
    gain = np.abs(response)
    assert gain[0] < .01
    assert gain[1] > .9
    assert gain[2] < .001
    assert gain[3] > .7
    assert gain[4] < .03
    for section in config.sos():
        assert np.all(np.abs(np.roots(section[3:])) < 1)


def test_causal_chunking_equals_single_pass_and_rejects_dc():
    x = np.random.default_rng(4).normal(size=(1000,8)) + 2000
    config = FilterConfig()
    batch = StreamingFilter(config).process(x)
    streaming = StreamingFilter(config)
    chunked = np.vstack([streaming.process(v) for v in np.array_split(x,37)])
    np.testing.assert_allclose(batch, chunked, atol=1e-10)
    assert np.max(np.abs(StreamingFilter(config).process(np.full((100,8),2000)))) < 1e-8


def test_gap_resets_filter_and_masks_warmup():
    indices = np.r_[np.arange(300), np.arange(305,605)]
    _, valid = filter_segments(np.ones((600,8)), indices, FilterConfig())
    assert not valid[:250].any() and valid[250:300].all()
    assert not valid[300:550].any() and valid[550:].all()


def test_nyquist_validation():
    with pytest.raises(ValueError):
        FilterConfig(high_hz=450).sos()
    assert FilterConfig(mains_hz=0).sos().shape[0] == 4


@pytest.mark.parametrize('rate', [250,2000])
def test_browser_sos_matches_scipy(rate):
    import json
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    config = FilterConfig.for_rate(rate)
    x = np.random.default_rng(13).normal(size=(500,8))*50+1200
    script = """import fs from 'node:fs';
import {SOSFilter} from './www/acquire/core.js';
const data=JSON.parse(fs.readFileSync(0,'utf8'));
const filter=new SOSFilter(data.sos);
console.log(JSON.stringify(data.x.map(row=>filter.process(row))));"""
    result = subprocess.run(['node','--input-type=module','-e',script],cwd=root,
        input=json.dumps({'sos':config.sos().tolist(),'x':x.tolist()}),text=True,capture_output=True,check=True)
    np.testing.assert_allclose(json.loads(result.stdout), StreamingFilter(config).process(x),atol=1e-8)
