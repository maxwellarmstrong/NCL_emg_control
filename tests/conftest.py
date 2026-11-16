import pytest


@pytest.fixture
def placement_record():
    # Upstream placement export schema 3: logical raw CH1–8, envelopes, flags.
    protocol = [('settle', 3, 0), ('rest', 10, 0),
                ('prepare', 3, 1), ('hold', 3, 1), ('recover', 5, 1),
                ('prepare', 3, 2), ('hold', 3, 2), ('recover', 5, 2),
                ('prepare', 3, 3), ('hold', 3, 3), ('recover', 5, 3)]
    return {'schema': 3, 'id': 'upstream-fixture',
            'metadata': {'channels': 6, 'sampleRate': 250, 'source': 'synthetic-demo',
                         'labels': ['CH1','CH2','CH3','CH4','CH5','CH6'],
                         'physicalChannels': [7,2,3,4,5,6], 'acquisition': {'gain':24,'srb2':True,'srb1':False},
                         'layout': 'Synthetic fixture', 'comparisonSet': 'compatibility-check',
                         'movement': 'pronation', 'startedAt': '2026-11-01T00:00:00Z',
                         'processing': {'highpassHz':20,'envelopeLowpassHz':5,'mainsHz':60,'commonAverage':True}},
            'recoveries': [{'blockStart':2,'rep':1,'dropped':2,'discardedRows':50}],
            'stages': [{'kind':kind,'seconds':seconds,'rep':rep,
                        'rows': [[11.,22.,33.,44.,55.,66.,0.,0.] + [2.]*8 + [1.]*6+[0.,0.] for _ in range(seconds*250)]}
                       for kind,seconds,rep in protocol]}
