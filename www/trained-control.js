import {CytonParser, SignalProcessor} from './cyton-signal.js';

export const digits = ['thumb', 'index', 'middle', 'ring + little'];
const zeros = () => Array(8).fill(0);
const dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);

// Identical trailing 200 ms RMS features during recording import and live control.
export class Features {
  constructor(profile) {
    this.filter = new SignalProcessor(profile);
    this.window = [];
    this.sum = zeros();
    this.hop = 0;
  }
  push(sample) {
    const point = this.filter.process(sample);
    if (!point.valid || point.gap) {
      this.window = []; this.sum = zeros(); this.hop = 0;
      return {reset:true};
    }
    const square = point.values.map(v=>v*v);
    const oldest = this.window.length === 50 ? this.window.shift() : null;
    this.window.push(square);
    square.forEach((v,i)=>this.sum[i]+=v-(oldest?.[i]??0));
    if (this.window.length < 50 || ++this.hop < 10) return {};
    this.hop = 0;
    return {x:this.sum.map(v=>Math.sqrt(Math.max(0,v)/50))};
  }
}

export class Calibration {
  constructor() {
    this.groups = Array.from({length:5},()=>({count:0,sum:zeros(),squares:zeros()}));
  }
  add(x, flexion) {
    const levels = [...flexion.slice(0,3), Math.max(flexion[3],flexion[4])];
    const peak = Math.max(...levels);
    let group = 0;
    if (peak > 0.12) {
      if (peak < 0.65 || levels.filter(v=>v>0.2).length !== 1) return;
      group = 1 + levels.indexOf(peak);
    }
    const stats = this.groups[group];
    stats.count++;
    x.forEach((v,i)=>{stats.sum[i]+=v;stats.squares[i]+=v*v;});
  }
  finish() {
    const rest = this.groups[0];
    if (rest.count<15) throw Error('Record at least one second with a relaxed open hand visible.');
    const baseline = rest.sum.map(v=>v/rest.count);
    const scale = baseline.map((v,i)=>Math.max(1,Math.sqrt(Math.max(0,rest.squares[i]/rest.count-v*v))));
    const patterns = this.groups.slice(1).map(group=>{
      if(group.count<15) return null;
      const vector=group.sum.map((v,i)=>(v/group.count-baseline[i])/scale[i]);
      return dot(vector,vector)>16 ? vector : null;
    });
    if (!patterns.some(Boolean)) throw Error('No distinct finger pattern. Record isolated finger curls and relaxed open-hand intervals.');
    return {baseline,scale,patterns};
  }
}

// Fit the observed activation to each learned finger direction in units of rest noise.
export function decode(model, x) {
  const observed=x.map((v,i)=>(v-model.baseline[i])/model.scale[i]);
  const scores=model.patterns.map(vector=>vector ? dot(observed,vector)/Math.sqrt(dot(vector,vector)) : -Infinity);
  const score=Math.max(...scores);
  const output=[0,0,0,0];
  if (score<3) return output;
  const finger=scores.indexOf(score), vector=model.patterns[finger];
  const level=Math.min(1,score/Math.sqrt(dot(vector,vector)));
  // A smooth negative band for a light curl and positive band for a firm curl.
  if(level>0.15 && level<0.55) output[finger]=-0.65*Math.sin(Math.PI*(level-0.15)/0.4);
  if(level>=0.55) output[finger]=(level-0.55)/0.45;
  return output;
}

export class LiveControl {
  constructor(model) { this.model=model; this.reset(); }
  reset() {
    this.parser=new CytonParser(); this.features=new Features(this.model.profile);
    this.command=[0,0,0,0]; this.last=-Infinity;
  }
  feed(bytes,now) {
    if(now-this.lastReceipt>250) this.reset();
    this.lastReceipt=now;
    for(const sample of this.parser.push(bytes,now)) {
      const {reset,x}=this.features.push(sample);
      if(reset) { this.command.fill(0); this.last=-Infinity; }
      if(!x) continue;
      const target=decode(this.model,x);
      const gain=1-Math.exp(-40/85);
      target.forEach((v,i)=>this.command[i]+=gain*(v-this.command[i]));
      this.last=now;
    }
  }
  inputs(now,mapping) {
    const joints=[0,0,0,0];
    if(now-this.last<=250) this.command.forEach((v,i)=>joints[mapping[i]]+=v);
    return joints.map(v=>Math.max(-1,Math.min(1,v)));
  }
}
