import {Calibration, Features} from './trained-control.js';

// Saras's exporter uses single-disk ZIP_DEFLATED with central-directory sizes
// (local headers may use ZIP64 even for small files).
function zipReader(buffer) {
  const view=new DataView(buffer), u16=p=>view.getUint16(p,true), u32=p=>view.getUint32(p,true);
  const utf=new TextDecoder();
  let end=buffer.byteLength-22;
  while(end>=Math.max(0,buffer.byteLength-65557) && u32(end)!==0x06054b50) end--;
  if(end<0 || u32(end)!==0x06054b50) throw Error('Invalid ZIP directory.');
  const entries=new Map();
  let at=u32(end+16), total=0;
  for(let n=0;n<u16(end+10);n++) {
    if(u32(at)!==0x02014b50) throw Error('Invalid ZIP entry.');
    const nameLen=u16(at+28), size=u32(at+24);
    const name=utf.decode(new Uint8Array(buffer,at+46,nameLen));
    total+=size;
    if(entries.has(name)||total>512*1024**2) throw Error('Duplicate entry or archive exceeds 512 MiB. Use a single-session export.');
    entries.set(name,{method:u16(at+10),compressed:u32(at+20),size,local:u32(at+42)});
    at+=46+nameLen+u16(at+30)+u16(at+32);
  }
  return async name=>{
    const entry=entries.get(name);
    if(!entry) throw Error('Missing '+name);
    const {local,compressed,method,size}=entry;
    const start=local+30+u16(local+26)+u16(local+28);
    if(u32(local)!==0x04034b50 || start+compressed>buffer.byteLength) throw Error('Damaged ZIP entry.');
    const data=new Uint8Array(buffer,start,compressed);
    if(method===0 && data.length===size) return data;
    if(method!==8) throw Error('Unsupported ZIP compression.');
    const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const output=new Uint8Array(size);
    let used=0;
    for await(const chunk of stream) {output.set(chunk,used);used+=chunk.length;}
    if(used!==size) throw Error('Incomplete ZIP entry.');
    return output;
  };
}

function *lines(data) {
  const utf=new TextDecoder();
  let start=0;
  while(start<data.length) {
    const end=data.indexOf(10,start);
    const line=utf.decode(data.subarray(start,end<0?data.length:end)).trim();
    if(line) yield JSON.parse(line);
    start=end<0?data.length:end+1;
  }
}

export async function trainArchive(file) {
  if(file.size>512*1024**2) throw Error('Use a single-session export below 512 MiB.');
  const read=zipReader(await file.arrayBuffer()), utf=new TextDecoder();
  const manifest=JSON.parse(utf.decode(await read('manifest.json')));
  if(manifest.schema_version!==1 || !manifest.files) throw Error('Unsupported research ZIP.');
  async function verified(name) {
    const data=await read(name), expected=manifest.files[name];
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
    if(data.length!==expected?.bytes || hash!==expected.sha256) throw Error('Checksum mismatch for '+name);
    return data;
  }
  const fit=new Calibration();
  let config,profile,key,sessions=0;
  for(const path of Object.keys(manifest.files).filter(p=>p.endsWith('/metadata.json'))) {
    const meta=JSON.parse(utf.decode(await verified(path))), cfg=meta.config;
    if(meta.status!=='complete'||meta.recording_kind==='placement'||cfg.split!=='train') continue;
    if(cfg.sample_rate_hz!==250 || !['common','bipolar'].includes(cfg.wiring) ||
       !['synthetic','cyton'].includes(cfg.source)) throw Error('Use a 250 Hz Cyton or synthetic training session.');
    const filter=meta.filter;
    if(filter?.sample_rate_hz!==250 || !Number.isFinite(filter.warmup_seconds) || filter.warmup_seconds<0 ||
       !filter.sos?.length || !filter.sos.every(row=>row.length===6 && row.every(Number.isFinite) && row[3]!==0))
      throw Error('Missing acquisition filter settings.');
    const signature=JSON.stringify([cfg.participant,cfg.hand,cfg.wiring,cfg.source,filter.sos,filter.warmup_seconds]);
    if(key && key!==signature) throw Error('Choose recordings from one person, hand, source, wiring and filter setup.');
    key=signature; config=cfg; profile=filter;
    const dir=path.slice(0,path.lastIndexOf('/')+1);
    if(!manifest.files[dir+'vision.jsonl'] || !manifest.files[dir+'emg.jsonl']) continue;
    const vision=lines(await verified(dir+'vision.jsonl'));
    let left=null,right=vision.next().value;
    const features=new Features(filter);
    for(const sample of lines(await verified(dir+'emg.jsonl'))) {
      if(sample.uv?.length!==8 || !sample.uv.every(Number.isFinite) || !Number.isFinite(sample.t_ms))
        throw Error('Invalid eight-channel sample.');
      const {x}=features.push(sample);
      if(!x) continue;
      const t=sample.t_ms+(cfg.label_delay_ms??0);
      while(right && right.t_ms<t) {left=right;right=vision.next().value;}
      if(!left?.valid||!right?.valid||right.t_ms-left.t_ms>120 || right.t_ms<=left.t_ms) continue;
      if(![left,right].every(f=>f.flexion?.length===5 && f.flexion.every(v=>Number.isFinite(v)&&v>=0&&v<=1))) continue;
      const w=(t-left.t_ms)/(right.t_ms-left.t_ms);
      fit.add(x,left.flexion.map((v,i)=>v+w*(right.flexion[i]-v)));
    }
    sessions++;
  }
  if(!sessions) throw Error('Choose a completed Training recording with camera labels and EMG samples.');
  return {...fit.finish(),profile,wiring:config.wiring,source:config.source,sessions};
}
self.onmessage=async({data})=>{
  try {self.postMessage({model:await trainArchive(data)});}
  catch(e) {self.postMessage({error:e.message});}
};
