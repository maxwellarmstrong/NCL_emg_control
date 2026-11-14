// Pure, testable acquisition primitives. Times use the browser's monotonic clock.
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
export const UV_PER_COUNT = 4.5 / 24 / 8388607 * 1e6;

export class CytonParser {
  constructor(rate = 250) { this.rate = rate; this.reset(); }
  reset() { this.buffer = []; this.previous = null; this.index = -1; this.anchor = null; this.lastReceipt = null; this.dropped = 0; this.resyncs = 0; this.duplicates = 0; }
  push(bytes, receivedMs) {
    this.buffer.push(...bytes);
    const packets = [];
    while (this.buffer.length >= 33) {
      if (this.buffer[0] !== 0xa0 || this.buffer[32] < 0xc0 || this.buffer[32] > 0xc6) {
        this.buffer.shift(); this.resyncs++; continue;
      }
      const p = this.buffer.splice(0, 33), sequence = p[1];
      const delta = this.previous === null ? 1 : (sequence - this.previous + 256) % 256;
      if (delta === 0) { this.duplicates++; continue; }
      this.index += delta; this.dropped += delta - 1; this.previous = sequence;
      const counts = Array.from({length: 8}, (_, ch) => {
        const k = 2 + ch * 3, n = p[k] * 65536 + p[k + 1] * 256 + p[k + 2];
        return n >= 8388608 ? n - 16777216 : n;
      });
      packets.push({index: this.index, sequence, counts, uv: counts.map(x => x * UV_PER_COUNT),
        received_ms: receivedMs, aux: p.slice(26, 32), footer: p[32], clipped: counts.some(x => Math.abs(x) >= .95 * 8388607)});
    }
    if (packets.length && this.anchor === null) this.anchor = receivedMs - packets.at(-1).index * 1000 / this.rate;
    if (!packets.length) return [];
    // An 8-bit counter cannot disambiguate losses of whole 256-packet cycles.
    // Flag suspicious host timing rather than silently inventing synchronization.
    const expected = this.anchor + packets.at(-1).index * 1000 / this.rate;
    const uncertain = Math.abs(receivedMs-expected)>250 || (this.lastReceipt!==null && receivedMs-this.lastReceipt>1000);
    this.lastReceipt=receivedMs;
    return packets.map(p => ({...p, t_ms: this.anchor + p.index * 1000 / this.rate, timing_uncertain:uncertain}));
  }
}

export class SOSFilter {
  constructor(sos, channels = 8) { this.sos = sos; this.channels = channels; this.reset(); }
  reset() { this.states = null; }
  process(values) {
    if (!this.states) {
      this.states = Array.from({length: this.channels}, (_, ch) => {
        let x = values[ch];
        return this.sos.map(([b0,b1,b2,a0,a1,a2]) => {
          const y = x * (b0+b1+b2) / (a0+a1+a2);
          const state = [y - b0/a0*x, b2/a0*x - a2/a0*y]; x = y; return state;
        });
      });
    }
    return values.map((v,ch) => {
      let x = v;
      this.sos.forEach(([b0,b1,b2,a0,a1,a2],i) => {
        const state = this.states[ch][i], y = b0/a0*x + state[0];
        state[0] = b1/a0*x - a1/a0*y + state[1];
        state[1] = b2/a0*x - a2/a0*y; x = y;
      });
      return x;
    });
  }
}

// The same reset/mask rules are implemented by Python's filter_segments.
export class SignalProcessor {
  constructor(profile) {
    this.profile=profile; this.filter=new SOSFilter(profile.sos);
    this.previous=null; this.previousBad=false; this.settleUntil=Infinity; this.segment=-1;
  }
  process(sample) {
    const previous=this.previous;
    const gap=previous!==null&&(sample.index!==previous.index+1 || sample.t_ms<=previous.t_ms ||
      sample.t_ms-previous.t_ms>1500/this.profile.sample_rate_hz);
    const bad=!!(sample.clipped||sample.timing_uncertain);
    const reset=!previous||gap||bad||this.previousBad;
    if(reset) {
      this.filter.reset(); this.segment++;
      this.settleUntil=sample.t_ms+1000*this.profile.warmup_seconds;
    }
    const values=bad?Array(8).fill(0):this.filter.process(sample.uv);
    const valid=!bad&&sample.t_ms>=this.settleUntil;
    this.previous=sample;this.previousBad=bad;
    return {t:sample.t_ms, values, valid, bad, gap, segment:this.segment,
      reason:sample.clipped?'ADC clipping':sample.timing_uncertain?'Timing uncertain':valid?'Ready':'Filter settling'};
  }
}

export function niceAmplitude(peak) {
  const target=Math.max(25,peak*1.1), decade=10**Math.floor(Math.log10(target));
  return [1,2,5,10].find(step=>step*decade>=target)*decade;
}

export function channelScales(rows, mode='shared', fixed=100) {
  if(mode==='fixed') return Array(8).fill(fixed);
  const peaks=Array(8).fill(0);
  for(const row of rows) if(!row.bad) row.values.forEach((v,ch)=>peaks[ch]=Math.max(peaks[ch],Math.abs(v)));
  return mode==='channel'?peaks.map(niceAmplitude):Array(8).fill(niceAmplitude(Math.max(...peaks)));
}

// Min/max per pixel keeps brief EMG peaks that stride-based decimation discards.
// Segment and validity changes always start a new path, even within one pixel.
export function waveformBins(rows, channel, startMs, durationMs, width) {
  const bins=[];let current;
  for(const row of rows) {
    if(row.t<startMs||row.t>startMs+durationMs||row.bad) {current=null;continue;}
    const x=Math.min(width-1,Math.floor((row.t-startMs)/durationMs*width));
    const v=row.values[channel];
    if(!current||current.x!==x||current.segment!==row.segment||current.valid!==row.valid) {
      const join=!!current&&current.segment===row.segment&&current.valid===row.valid;
      current={x,min:v,max:v,first:v,last:v,segment:row.segment,valid:row.valid,join};bins.push(current);
    }else{current.min=Math.min(current.min,v);current.max=Math.max(current.max,v);current.last=v;}
  }
  return bins;
}

function bend(a,b,c) {
  const u = a.map((v,i) => v-b[i]), v = c.map((n,i) => n-b[i]);
  const norm = Math.hypot(...u)*Math.hypot(...v);
  if (norm < 1e-10) return NaN;
  return 180 - Math.acos(Math.max(-1, Math.min(1,u.reduce((s,n,i)=>s+n*v[i],0)/norm)))*180/Math.PI;
}

export function armMeasurement(poses, worlds, side) {
  const result={side,valid:false,reason:'no person detected',landmarks:null,world_landmarks:null,
    visibility:null,elbow_flexion_deg:null,upper_arm_to_torso_deg:null};
  if(poses?.length!==1) {if(poses?.length>1)result.reason='multiple people in frame';return result;}
  const points=poses[0], world=worlds?.[0];
  if(points.length!==33||world?.length!==33) {result.reason='incomplete pose';return result;}
  const xyz=p=>[p.x,p.y,p.z];
  if(!points.every(p=>xyz(p).every(Number.isFinite)&&Number.isFinite(p.visibility)) ||
     !world.every(p=>xyz(p).every(Number.isFinite))) {result.reason='invalid pose geometry';return result;}
  result.landmarks=points.map(xyz);result.world_landmarks=world.map(xyz);result.visibility=points.map(p=>p.visibility);
  const [s,e,w,h]=side==='Left'?[11,13,15,23]:[12,14,16,24];
  const visible=id=>points[id].visibility>=.65&&points[id].x>=.02&&points[id].x<=.98&&points[id].y>=.02&&points[id].y<=.98;
  if(![s,e,w].every(visible)) {result.reason='show shoulder, elbow and wrist clearly';return result;}
  const elbow=bend(...[s,e,w].map(id=>xyz(world[id])));
  if(!Number.isFinite(elbow)) {result.reason='degenerate arm geometry';return result;}
  result.valid=true;result.reason='ok';result.elbow_flexion_deg=elbow;
  if(visible(h)) {
    const angle=180-bend(...[e,s,h].map(id=>xyz(world[id])));
    if(Number.isFinite(angle))result.upper_arm_to_torso_deg=angle;
  }
  return result;
}

export function fingerAngles(world) {
  if (!world || world.length !== 21) return null;
  const groups = [[[1,2,3],[2,3,4]], [[0,5,6],[5,6,7],[6,7,8]],
    [[0,9,10],[9,10,11],[10,11,12]], [[0,13,14],[13,14,15],[14,15,16]], [[0,17,18],[17,18,19],[18,19,20]]];
  const angles = groups.map(group => group.reduce((sum, ids) => sum+bend(...ids.map(i=>world[i])),0)/group.length);
  return angles.every(Number.isFinite) ? angles : null;
}

export function calibratedFlexion(angles, calibration) {
  if (!angles || !calibration.open || !calibration.closed) return null;
  const spans = calibration.closed.map((v,i)=>v-calibration.open[i]);
  if (spans.some(v=>v<15)) return null;
  return angles.map((a,i)=>Math.max(0, Math.min(1, (a-calibration.open[i])/spans[i])));
}

export function syntheticFlexion(t) {
  const targets = [Array(5).fill(0), ...Array.from({length:5},(_,i)=>Array.from({length:5},(_,j)=>i===j?.85:0)), [.65,.65,0,0,0], [0,0,.65,.65,.65]];
  const segment = Math.floor(t/3), phase = Math.min(1,(t%3)/.4), blend = phase*phase*(3-2*phase);
  return targets[segment%8].map((v,i)=>targets[(segment+7)%8][i]*(1-blend)+v*blend);
}

export function median(rows) {
  return Array.from({length:5},(_,i)=>rows.map(r=>r[i]).sort((a,b)=>a-b)[Math.floor(rows.length/2)]);
}
