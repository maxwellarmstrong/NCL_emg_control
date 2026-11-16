import test from 'node:test';
import assert from 'node:assert/strict';
import {MovementTracker} from '../www/acquire/movement.js';

test('camera labels simultaneous hand and arm motion and preserves independent visibility',()=>{
  const tracker=new MovementTracker();
  function observe(t,hand,elbow,shoulder) {
    return tracker.classify({t_ms:t,valid:hand!==null,flexion:hand,
      arm:{valid:elbow!==null,elbow_flexion_deg:elbow,upper_arm_to_torso_deg:shoulder}});
  }
  for(let i=0;i<=5;i++) {
    const label=observe(i*50,Array(5).fill(i/5),20+i*12,10+i*8);
    if(i===5) assert.deepEqual(label,{hand:'closing',elbow:'curling',upper_arm:'raising'});
  }
  for(let i=6;i<=14;i++) var held=observe(i*50,Array(5).fill(1),80,50);
  assert.deepEqual(held,{hand:'closed',elbow:'steady',upper_arm:'steady'});
  for(let i=1;i<=6;i++) var reverse=observe(700+i*50,Array(5).fill(1-i/6),80-i*10,50-i*6);
  assert.deepEqual(reverse,{hand:'opening',elbow:'extending',upper_arm:'lowering'});
  assert.equal(observe(1050,null,18,12).hand,null);
  assert.equal(observe(1100,[0,0,0,0,0],null,null).hand,'open');
  assert.deepEqual(observe(2000,[0,1,0,0,0],25,10),{hand:'partial',elbow:null,upper_arm:null});
});
