import test from 'node:test';
import assert from 'node:assert/strict';
import {IsolationRun, summarize, ROW, RATE, StreamHealth} from './isolation-core.mjs';
const meta = {channels:6, target:4};
const row = (target=2) => [...Array(8).fill(0), ...Array.from({length:8},(_,i)=>i===4?target:2), ...Array(8).fill(1)];
test('sample-driven protocol covers 3 holds and ignores display-only time',()=>{
 const r=new IsolationRun(meta,[0,0,0]);
 assert.equal(r.remaining,3);
 r.feed(new Float32Array(),100); assert.equal(r.remaining,3);
 while(!r.done){ const s=r.stage; r.feed(Array.from({length:s.seconds*RATE},()=>row(s.kind==='hold'?12:2)).flat(),200); }
 const s=summarize(r);
 assert.equal(s.channels[4].delta,10); assert.equal(s.targetShare,1);
 assert.deepEqual(s.repeatLeaders,[4,4,4]);
 assert.equal(r.stages.filter(s=>s.kind==='hold').length,3);
 assert.equal(r.stages.reduce((n,s)=>n+s.rows.length,0),46*RATE);
});
test('no response does not get an isolation score or leader',()=>{
 const r=new IsolationRun(meta,[0,0,0]);
 while(!r.done) r.feed(Array.from({length:r.stage.seconds*RATE},()=>row()).flat(),0);
 const s=summarize(r); assert.equal(s.strongest,null);assert.equal(s.targetShare,null);assert.equal(s.lowResponse,true);
});
test('large packet loss, stall, disconnect and overflow invalidate recordings',()=>{
 for(const args of [[[4,26,0],10,true,false],[[0,0,0],1001,true,false],[[0,0,0],10,false,false],[[0,0,0],10,true,true]]){
 const r=new IsolationRun(meta,[0,0,0]);r.check(...args);assert.ok(r.error);assert.throws(()=>summarize(r)); }
});
test('saturated active channels fail; disabled channels do not',()=>{
 const r=new IsolationRun(meta,[0,0,0]);r.feed(Array.from({length:750},()=>row()).flat(),0);
 let v=row();v[23]=0;r.feed(v,10);assert.equal(r.error,null);
 v[16]=0;r.feed(v,20);assert.ok(r.error);
});
test('malformed data and nonfinite values fail',()=>{
 for(const data of [[0],Array(ROW).fill(NaN)]){const r=new IsolationRun(meta,[0,0,0]);r.feed(data,0);assert.ok(r.error);}
});

test('readiness requires continuing packet arrival, not an open port or cached counters',()=>{
 const h=new StreamHealth();
 h.update([1000,0,0],0,true);h.update([1000,0,0],2000,true);assert.equal(h.ready,false);
 let n=1000;for(let t=2020;t<=3220;t+=20){n+=5;h.update([n,0,0],t,true);}
 assert.equal(h.ready,true);assert.equal(h.pps,250);
 h.update([n,0,0],3800,true);assert.equal(h.ready,false);
 h.update([n+5,0,0],3820,true);assert.equal(h.ready,false);
 for(let t=3840;t<=4900;t+=20){n+=5;h.update([n+5,0,0],t,true);}
 assert.equal(h.ready,true);
 h.update([n+10,1,0],4920,true);assert.equal(h.ready,false);
 h.update([0,0,0],4940,true);assert.equal(h.ready,false);
 h.update([10,0,0],4960,false);assert.equal(h.ready,false);
});

test('small gap discards current round and batch, keeping baseline and earlier completed rounds',()=>{
 const r=new IsolationRun(meta,[0,0,0]);
 while(r.index<6)r.feed(Array.from({length:r.stage.seconds*RATE},()=>row()).flat(),100);
 r.feed(Array.from({length:100},()=>row(99)).flat(),110);
 const baseline=r.stages[1].rows, firstHold=r.stages[3].rows;
 assert.equal(r.check([100,1,0],120,true),false);
 assert.equal(r.error,null);assert.equal(r.index,5);assert.equal(r.stage.kind,'prepare');
 assert.equal(r.stages[1].rows,baseline);assert.equal(r.stages[3].rows,firstHold);
 assert.equal(r.stages[6].rows.length,0);assert.equal(r.recoveries[0].rep,2);
 assert.equal(r.check([105,1,0],140,true),true);
 while(!r.done)r.feed(Array.from({length:r.stage.seconds*RATE},()=>row(12)).flat(),150);
 assert.equal(r.stages.reduce((n,s)=>n+s.rows.length,0),46*RATE);
 assert.equal(r.recoveries.length,1);assert.equal(r.stages[6].rows.some(v=>v[12]===99),false);
});
test('baseline gap restarts settling, and repeated gaps or counter resets stop safely',()=>{
 const r=new IsolationRun(meta,[0,0,0]);r.feed(Array.from({length:800},()=>row()).flat(),0);
 assert.equal(r.check([800,0,1],10,true),false);assert.equal(r.index,0);assert.equal(r.stages[0].rows.length,0);
 for(let i=2;i<=4;i++)r.check([800+i,0,i],i*10,true);
 assert.match(r.error,/too unstable/);
 const reset=new IsolationRun(meta,[100,1,2]);reset.check([50,1,2],20,true);assert.match(reset.error,/reset/);
});
