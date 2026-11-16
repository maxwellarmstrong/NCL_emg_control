import test from 'node:test';
import assert from 'node:assert/strict';
import {CytonParser, SOSFilter, SignalProcessor, channelScales, waveformBins, armMeasurement, UV_PER_COUNT, calibratedFlexion} from '../www/acquire/core.js';
function packet(sequence,counts=Array(8).fill(0)) {
  const p=new Uint8Array(33);p[0]=0xa0;p[1]=sequence;p[32]=0xc0;
  counts.forEach((n,ch)=>{const i=2+ch*3;p[i]=n>>16;p[i+1]=n>>8;p[i+2]=n;});return p;
}
test('parser handles chunks, signed counts, wraps, duplicate packets and gaps',()=>{
  const parser=new CytonParser(),p=packet(254,[-1,8388607,-8388608,0,0,0,0,0]);
  assert.equal(parser.push(p.slice(0,12),100).length,0);
  const rows=parser.push(new Uint8Array([...p.slice(12),...packet(255),...packet(1)]),100);
  assert.equal(rows.length,3);assert.equal(rows[0].counts[0],-1);assert.equal(rows[0].uv[0],-UV_PER_COUNT);
  assert.deepEqual(rows.map(r=>r.index),[0,1,3]);assert.equal(parser.dropped,1);
  assert.deepEqual(rows.map(r=>r.t_ms),[88,92,100]);
  assert.equal(parser.push(packet(1),105).length,0);
});
test('SOS filter rejects DC and maintains state',()=>{
  const f=new SOSFilter([[.5,-.5,0,1,0,0]],1);
  assert.deepEqual(f.process([100]),[0]);assert.deepEqual(f.process([102]),[1]);assert.deepEqual(f.process([104]),[1]);
});
test('counter ambiguity after a long receipt gap is flagged for exclusion',()=>{
  const parser=new CytonParser();
  assert.equal(parser.push(packet(0),100)[0].timing_uncertain,false);
  const row=parser.push(packet(1),1128)[0];
  assert.equal(row.index,1);assert.equal(row.timing_uncertain,true);
});
test('pose normalization refuses missing or degenerate calibration',()=>{
  assert.equal(calibratedFlexion([30,30,30,30,30],{}),null);
  assert.equal(calibratedFlexion([30,30,30,30,30],{open:[0,0,0,0,0],closed:[1,1,1,1,1]}),null);
  assert.deepEqual(calibratedFlexion([30,30,30,30,30],{open:[0,0,0,0,0],closed:[60,60,60,60,60]}),[.5,.5,.5,.5,.5]);
});

test('axis scales include every peak and shared mode preserves channel comparison',()=>{
  const rows=Array.from({length:8},(_,i)=>({values:[i===3?350:5,10,20,5,5,5,5,5],bad:false}));
  assert.deepEqual(channelScales(rows),Array(8).fill(500));
  assert.equal(channelScales(rows,'channel')[1],50);
  assert.deepEqual(channelScales(rows,'fixed',100),Array(8).fill(100));
  const bins=waveformBins(rows.map((p,i)=>({...p,t:i,segment:0,valid:true})),0,0,10,1);
  assert.equal(bins.length,1);assert.equal(bins[0].max,350);
});

test('plot never joins acquisition segments or rejected intervals',()=>{
  const row=(t,segment=0,bad=false)=>({t,segment,bad,valid:true,values:Array(8).fill(1)});
  const bins=waveformBins([row(0),row(1),row(2,1),row(3,1,true),row(4,1)],0,0,5,50);
  assert.deepEqual(bins.map(b=>b.join),[false,true,false,false]);
});

test('signal recovery excludes artifacts and a full clean settling period',()=>{
  const p=new SignalProcessor({sos:[[1,0,0,1,0,0]],sample_rate_hz:250,warmup_seconds:1});
  let row;
  for(let index=0;index<800;index++) {
    row=p.process({index,t_ms:index*4,uv:Array(8).fill(index),clipped:index===300});
    if(index===249||index===300||index===550)assert.equal(row.valid,false);
    if(index===250||index===551)assert.equal(row.valid,true);
  }
  row=p.process({index:800,t_ms:5000,uv:Array(8).fill(0)});
  assert.equal(row.gap,true);assert.equal(row.valid,false);
});

function poseFixture(side='Right',straight=false) {
  const points=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:.99}));
  const world=points.map(p=>({...p}));
  const [s,e,w,h]=side==='Left'?[11,13,15,23]:[12,14,16,24];
  world[s]={x:0,y:0,z:0};world[e]={x:0,y:1,z:0};world[w]={x:straight?0:1,y:straight?2:1,z:0};world[h]={x:0,y:2,z:0};
  return {points,world,s,e,w,h};
}

test('arm angles use selected-side pose geometry; hand calibration is independent',()=>{
  for(const side of ['Left','Right']) {
    const f=poseFixture(side);
    const arm=armMeasurement([f.points],[f.world],side);
    assert.equal(arm.valid,true);assert.equal(arm.elbow_flexion_deg,90);assert.equal(arm.upper_arm_to_torso_deg,0);
    const straight=poseFixture(side,true);
    assert.equal(armMeasurement([straight.points],[straight.world],side).elbow_flexion_deg,0);
    f.points[f.h].visibility=.1;
    assert.equal(armMeasurement([f.points],[f.world],side).upper_arm_to_torso_deg,null);
    f.points[f.e].visibility=.2;
    assert.equal(armMeasurement([f.points],[f.world],side).valid,false);
  }
});

test('arm tracking rejects ambiguous people, clipped joints and degenerate geometry',()=>{
  const f=poseFixture();
  assert.equal(armMeasurement([],[],'Right').valid,false);
  assert.equal(armMeasurement([f.points,f.points],[f.world,f.world],'Right').valid,false);
  f.points[f.w].x=1.1;
  assert.equal(armMeasurement([f.points],[f.world],'Right').valid,false);
  f.points[f.w].x=.5;f.world[f.e]=f.world[f.s];
  assert.equal(armMeasurement([f.points],[f.world],'Right').valid,false);
});
