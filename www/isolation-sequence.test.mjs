import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GuidedSequence,STANDARD_MOVES,STANDARD_SECONDS} from './isolation-sequence.mjs';
test('seven-step sequence lasts 6:22 excluding save delays/retries and advances only after saves',()=>{
 assert.equal(STANDARD_SECONDS,382);const s=new GuidedSequence('test');let now=0;
 STANDARD_MOVES.forEach((move,i)=>{assert.equal(s.movement,move);assert.equal(s.metadata().index,i);now+=46000;s.saved(`record-${i}`,now);
 if(i<6){assert.equal(s.state,'transition');assert.equal(s.begin(now+9999,true),false);assert.equal(s.begin(now+10000,false),false);now+=10000;assert.equal(s.begin(now,true),true);}
 });assert.equal(s.state,'complete');assert.equal(now,382000);assert.equal(s.recordIds.length,7);assert.throws(()=>s.saved('extra',now));
});
test('stop during recording or transition prevents automatic restart and keeps completed IDs',()=>{
 for(const transition of [false,true]){const s=new GuidedSequence('test');if(transition)s.saved('retained',0);s.cancel();assert.equal(s.begin(20000,true),false);assert.throws(()=>s.saved('bad',20000));assert.deepEqual(s.recordIds,transition?['retained']:[]);}
});
