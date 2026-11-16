// Pure, testable acquisition primitives. Times use the browser's monotonic clock.
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
