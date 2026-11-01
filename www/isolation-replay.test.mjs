import test from 'node:test';
import assert from 'node:assert/strict';
import {IsolationRun,RATE} from './isolation-core.mjs';
import {compareRecord,validateRecord,baselineReport,patternDistance,REPLAY_VERSION} from './isolation-replay.mjs';
function recording(){
 const metadata={channels:6,target:2,source:'cyton',sampleRate:250,labels:['1','2','3','4','5','6'],layout:'A',sites:['a'],processing:{highpassHz:20,envelopeLowpassHz:5,mainsHz:60},startedAt:'2026-10-31',movement:'triceps'};
 const r=new IsolationRun(metadata,[0,0,0]);
 while(!r.done){const n=r.stage.kind==='hold'?20:2;r.feed(Array.from({length:r.stage.seconds*RATE},()=>[...Array(8).fill(n),...Array(8).fill(999),...Array(8).fill(1)]).flat(),0);}
 return {id:'a',schema:2,metadata,stages:r.stages};
}
const fake=(raw,ch,car)=>Float32Array.from(Array.from({length:raw.length/8},(_,i)=>[...Array(8).fill(raw[i*8]*(car?0.5:1)),...Array.from({length:8},(_,j)=>j<ch?1:0)]).flat());
test('replay uses same raw input for both modes, not live envelopes; preserves originals',()=>{
 const r=recording(), before=JSON.stringify(r);let calls=[];
 const c=compareRecord(r,(raw,ch,car,mains)=>{calls.push({raw:Array.from(raw),ch,car,mains});return fake(raw,ch,car);});
 assert.equal(calls.length,8);for(let i=0;i<4;i++)assert.deepEqual(calls[i].raw,calls[i+4].raw); assert.deepEqual(calls.map(c=>c.car),[true,true,true,true,false,false,false,false]);
 assert.deepEqual(calls.slice(0,4).map(c=>c.raw.length/8),[3250,2750,2750,2750]);
 assert.equal(c.on.channels[0].delta,9);assert.equal(c.off.channels[0].delta,18);
 assert.equal(JSON.stringify(r),before);
});
test('rejects incomplete, invalid, railed or unsupported records',()=>{
 for(const mutate of [r=>r.stages.pop(),r=>r.stages[1].rows[0][16]=0,r=>r.stages[0].rows[0][0]=NaN,r=>r.metadata.sampleRate=125,r=>r.metadata.processing.highpassHz=10]){
  const r=recording();mutate(r);assert.throws(()=>validateRecord(r));
 }
 assert.throws(()=>compareRecord(recording(),()=>[]));
});
test('baseline comparisons never mix layouts, sites, source or mappings; newest matching trial wins',()=>{
 const r=recording();r.comparison=compareRecord(r,fake);
 const changed=structuredClone(r);changed.metadata.sites=['different'];changed.metadata.movement='pronation';
 const demo=structuredClone(r);demo.metadata.source='synthetic-demo';demo.metadata.movement='rest';
 const later=structuredClone(r);later.id='later';later.metadata.startedAt='2026-11-01';
 const report=baselineReport([r,changed,demo,later],r.metadata);
 assert.equal(report.selected.triceps.id,'later'); assert.deepEqual(report.missing,['rest','pronation','supination']);
 assert.equal(report.on[0].value,null);
});
test('shape comparison is scale independent, with low-response and missing guards',()=>{
 const s=v=>({channels:v.map(delta=>({delta})),lowResponse:false});
 assert.equal(patternDistance(s([1,0]),s([9,0])),0);
 assert.equal(patternDistance(s([1,0]),s([0,9])),1);
 assert.equal(patternDistance({...s([1,0]),lowResponse:true},s([1,0])),null);
 assert.equal(patternDistance(s([0,0]),s([1,0])),null);
});

test('complete baseline reports distances while separating comparison sets',()=>{
 const base=recording();const records=['rest','pronation','supination','triceps'].map((movement,i)=>{
  const summary={lowResponse:false,channels:Array.from({length:6},(_,j)=>({delta:j===i?10:0}))};
  return {...base,id:movement,metadata:{...base.metadata,comparisonSet:'first',movement},comparison:{version:REPLAY_VERSION,on:summary,off:summary}};
 });
 const report=baselineReport(records,records[0].metadata);
 assert.deepEqual(report.missing,[]); assert.equal(report.on[0].value,1);
 assert.equal(baselineReport(records,{...records[0].metadata,comparisonSet:'second'}).missing.length,4);
});
