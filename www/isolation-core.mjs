export const RATE = 250;
export const ROW = 24;

// An open serial port is not proof that packets are still arriving.
export class StreamHealth {
  constructor() { this.reset(); }
  reset() { this.previous=null; this.lastAdvance=-Infinity; this.windowStart=null; this.count=0; this.pps=0; this.ready=false; }
  update(stats,now,connected) {
    if(!connected) { this.reset(); return this; }
    const previous=this.previous;
    this.previous=[...stats];
    if(!previous || stats[0]<previous[0] || stats[1]!==previous[1] || stats[2]!==previous[2]) {
      this.lastAdvance=-Infinity; this.windowStart=now; this.count=0; this.pps=0; this.ready=false; return this;
    }
    if(now-this.lastAdvance>500) { this.windowStart=now; this.count=0; this.pps=0; this.ready=false; if(stats[0]>previous[0])this.lastAdvance=now; return this; }
    if(stats[0]>previous[0]) { this.lastAdvance=now; this.count+=stats[0]-previous[0]; }
    const elapsed=now-this.windowStart;
    if(elapsed>=1000) { this.pps=this.count*1000/elapsed; this.count=0; this.windowStart=now; }
    this.ready=now-this.lastAdvance<=500 && this.pps>=200 && this.pps<=300;
    return this;
  }
}
export const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((a, b) => a - b), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const protocol = () => [
  {kind:'settle', seconds:3, rep:0}, {kind:'rest', seconds:10, rep:0},
  ...[1,2,3].flatMap(rep => [
    {kind:'prepare', seconds:3, rep}, {kind:'hold', seconds:3, rep}, {kind:'recover', seconds:5, rep},
  ]),
];

export class IsolationRun {
  constructor(metadata, stats, now = 0) {
    this.metadata = metadata;
    this.initialStats = [...stats];
    this.lastStats = [...stats];
    this.recoveries = [];
    this.notice = '';
    this.lastData = now;
    this.stages = protocol().map(s => ({...s, rows:[]}));
    this.index = 0;
    this.error = null;
  }
  get stage() { return this.stages[this.index]; }
  get done() { return this.index === this.stages.length && !this.error; }
  get remaining() { return this.stage ? this.stage.seconds - this.stage.rows.length / RATE : 0; }
  fail(reason) { if (!this.done && !this.error) this.error = reason; }
  check(stats, now, connected, overflow = false) {
    if (this.done || this.error) return false;
    const previous=this.lastStats;
    this.lastStats=[...stats];
    if (!connected) this.fail('The stream disconnected. Reconnect, then repeat this movement.');
    else if (overflow) this.fail('Recording buffer overflowed. Keep this tab visible and repeat.');
    else if (stats.some((v,i)=>v<previous[i])) this.fail('The stream counters reset. Reconnect before starting another recording.');
    else if (now - this.lastData > 1000) this.fail('No new samples for over a second. Close this lab and reconnect EMG before retrying. The last displayed channel values may be stale.');
    else if(stats[1]!==previous[1] || stats[2]!==previous[2]) {
      const dropped=stats[1]-previous[1], resyncs=stats[2]-previous[2];
      const start=this.index<2?0:2+3*Math.floor((this.index-2)/3);
      const attempts=this.recoveries.filter(e=>e.blockStart===start).length;
      if(dropped>25 || resyncs>3 || attempts>=3 || this.recoveries.length>=8) {
        this.fail(`Connection too unstable: ${dropped} missing packets, ${resyncs} parser resyncs in this batch; ${attempts} retries in this block. Reconnect before retrying.`);
      } else {
        const rep=this.stages[start].rep;
        this.recoveries.push({blockStart:start,rep,dropped,resyncs,discardedRows:this.stages.slice(start).reduce((n,s)=>n+s.rows.length,0),atReceivedPacket:stats[0]});
        // Discard this whole incoming batch: its exact gap position is unknown.
        // Earlier complete blocks remain untouched. Replay resets per block.
        this.stages.slice(start).forEach(s=>s.rows=[]);
        this.index=start;
        this.lastData=now;
        this.notice=`Brief signal gap (${dropped} missing packets, ${resyncs} resyncs). Relax. Repeating ${rep?`round ${rep}`:'the baseline'}; earlier complete rounds are kept.`;
      }
      return false;
    }
    return !this.error;
  }
  feed(flat, now) {
    if (this.error || this.done) return;
    if (flat.length % ROW) { this.fail('Incomplete sample buffer. Repeat the recording.'); return; }
    if (flat.length) this.lastData = now;
    for (let i = 0; i < flat.length && this.stage; i += ROW) {
      const row = Array.from(flat.slice(i, i + ROW));
      if (!row.every(Number.isFinite)) { this.fail('Invalid signal values. Repeat after checking the stream.'); return; }
      if (this.stage.kind !== 'settle' && row.slice(16, 16 + this.metadata.channels).some(x => x !== 1)) {
        this.fail('An active channel is saturated or unavailable. Check the lead and repeat.'); return;
      }
      this.stage.rows.push(row);
      if (this.stage.rows.length >= this.stage.seconds * RATE) this.index++;
    }
  }
}

export function summarize(run) {
  if (!run.done) throw new Error('Only complete recordings can be summarized');
  // Discard the first 0.5 s of rest/hold, allowing envelope and movement settling.
  const rest = run.stages.find(s => s.kind === 'rest').rows.slice(125);
  const holds = run.stages.filter(s => s.kind === 'hold').map(s => s.rows.slice(125));
  const recovery = run.stages.filter(s => s.kind === 'recover').map(s => s.rows.slice(-250));
  const channels = Array.from({length:run.metadata.channels}, (_, ch) => {
    const r = rest.map(row => row[8 + ch]), baseline = median(r);
    const noise = 1.4826 * median(r.map(x => Math.abs(x - baseline)));
    const trialLevels = holds.map(rows => median(rows.map(row => row[8 + ch])));
    const deltas = trialLevels.map(x => x - baseline);
    return {baseline, noise, trialLevels, deltas, delta:median(deltas),
      recovery:recovery.map(rows => median(rows.map(row => row[8 + ch])))};
  });
  const positive = channels.map(c => Math.max(0, c.delta)), total = positive.reduce((a,b) => a+b,0);
  const strongest = total > 0 ? positive.indexOf(Math.max(...positive)) : null;
  const target = run.metadata.target;
  const repeatLeaders = [0,1,2].map(i => {
    const v = channels.map(c => Math.max(0,c.deltas[i]));
    return Math.max(...v) > 0 ? v.indexOf(Math.max(...v)) : null;
  });
  return {channels, strongest, repeatLeaders,
    targetShare: total > 0 && target >= 0 ? positive[target] / total : null,
    lowResponse: channels.every(c => c.delta < Math.max(1, 3*c.noise))};
}
