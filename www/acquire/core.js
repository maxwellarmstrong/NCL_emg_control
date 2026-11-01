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

function bend(a,b,c) {
  const u = a.map((v,i) => v-b[i]), v = c.map((n,i) => n-b[i]);
  const norm = Math.hypot(...u)*Math.hypot(...v);
  if (norm < 1e-10) return NaN;
  return 180 - Math.acos(Math.max(-1, Math.min(1,u.reduce((s,n,i)=>s+n*v[i],0)/norm)))*180/Math.PI;
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
