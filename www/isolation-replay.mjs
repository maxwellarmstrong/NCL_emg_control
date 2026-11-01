import {protocol, summarize, RATE, ROW} from './isolation-core.mjs';

export const REPLAY_VERSION = 'car-replay-v2-blocks';
export const BASELINE = ['rest', 'pronation', 'supination', 'triceps'];

export function validateRecord(record) {
  const m=record?.metadata, expected=protocol();
  if(record?.status==='incomplete-unscored')throw Error('Interrupted recordings cannot be scored.');
  if (![1,2,3].includes(record?.schema) || ![6,8].includes(m?.channels) || m.sampleRate!==RATE
      || !['cyton','synthetic-demo'].includes(m.source) || m.labels?.length!==m.channels
      || m.processing?.highpassHz!==20 || m.processing?.envelopeLowpassHz!==5
      || ![50,60].includes(m.processing?.mainsHz)) throw Error('Unsupported recording settings. Record a new placement-lab trial.');
  if (!Array.isArray(record.stages) || record.stages.length!==expected.length) throw Error('Incomplete recording; replay requires all stages.');
  record.stages.forEach((s,i)=>{
    const e=expected[i];
    if (s.kind!==e.kind || s.rep!==e.rep || s.seconds!==e.seconds || s.rows?.length!==e.seconds*RATE) throw Error('Incomplete or changed recording protocol.');
    for (const row of s.rows) {
      if (!Array.isArray(row) || row.length!==ROW || !row.every(Number.isFinite)) throw Error('Malformed recording samples.');
      if (s.kind!=='settle' && row.slice(16,16+m.channels).some(x=>x!==1)) throw Error('Recording contains unavailable or saturated channels.');
    }
  });
}

export function compareRecord(record, replay) {
  validateRecord(record);
  // Each block has 3 seconds of relaxed warm-up. Reset between blocks so a
  // discarded attempt or missing batch cannot affect later scored envelopes.
  const blocks=[record.stages.slice(0,2),record.stages.slice(2,5),record.stages.slice(5,8),record.stages.slice(8,11)];
  const results={};
  for (const [mode,car] of [['on',true],['off',false]]) {
    const stages=blocks.flatMap(block=>{
      const raw=Float32Array.from(block.flatMap(s=>s.rows.flatMap(row=>row.slice(0,8))));
      const output=replay(raw,record.metadata.channels,car,record.metadata.processing.mainsHz);
      if (output.length!==raw.length*2) throw Error('Replay returned incomplete data.');
      let offset=0;
      return block.map(s=>({...s,rows:s.rows.map(row=>{
      const processed=Array.from(output.slice(offset,offset+16)); offset+=16;
      if (!processed.every(Number.isFinite) || (s.kind!=='settle' && processed.slice(8,8+record.metadata.channels).some(x=>x!==1))) throw Error('Replay found invalid or saturated samples.');
      return [...row.slice(0,8),...processed];
      })}));
    });
    results[mode]=summarize({done:true,metadata:record.metadata,stages});
  }
  return {version:REPLAY_VERSION,...results,initialization:'Both modes reset independently for baseline and each repetition; 3-second settle/prepare warms each block. Missing batches and interrupted attempts are excluded.'};
}

export function layoutKey(m) {
  // Never silently pool different mappings, sites, sources or filter settings.
  return JSON.stringify([m.comparisonSet,m.source,m.channels,m.layout,m.sites,m.labels,m.sampleRate,
    m.physicalChannels??m.labels,m.processing,m.acquisition??'legacy-settings']);
}

export function patternDistance(a,b) {
  if (!a || !b || a.lowResponse || b.lowResponse) return null;
  const x=a.channels.map(c=>Math.max(0,c.delta)), y=b.channels.map(c=>Math.max(0,c.delta));
  const norm=Math.hypot(...x)*Math.hypot(...y);
  return norm>0 ? Math.max(0,Math.min(1,1-x.reduce((n,v,i)=>n+v*y[i],0)/norm)) : null;
}

export function baselineReport(records, metadata) {
  const selected={};
  [...records].filter(r=>r.comparison?.version===REPLAY_VERSION && layoutKey(r.metadata)===layoutKey(metadata))
    .sort((a,b)=>b.metadata.startedAt.localeCompare(a.metadata.startedAt))
    .forEach(r=>{if(BASELINE.includes(r.metadata.movement) && !selected[r.metadata.movement])selected[r.metadata.movement]=r;});
  const pairs=[['pronation','supination'],['pronation','triceps'],['supination','triceps']];
  const distance=mode=>pairs.map(([a,b])=>({a,b,value:patternDistance(selected[a]?.comparison[mode],selected[b]?.comparison[mode])}));
  return {selected,missing:BASELINE.filter(id=>!selected[id]),on:distance('on'),off:distance('off')};
}
