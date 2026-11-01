import test from 'node:test';
import assert from 'node:assert/strict';
import {CytonParser, SOSFilter, UV_PER_COUNT, calibratedFlexion} from '../www/acquire/core.js';
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
