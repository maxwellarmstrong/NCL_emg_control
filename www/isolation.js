import { IsolationRun, summarize, StreamHealth } from './isolation-core.mjs';
import {compareRecord, baselineReport, BASELINE, REPLAY_VERSION, layoutKey} from './isolation-replay.mjs';

import {GuidedSequence, STANDARD_MOVES} from './isolation-sequence.mjs';

const MOVES = [
  {id:'rest', name:'Relaxed-rest control', target:-1, img:null,
   setup:'Support your right elbow and forearm comfortably, wrist straight, fingers loose. Use the same starting posture as the rotation trials.',
   action:'Stay relaxed throughout this control trial, including the three observation periods. Do not deliberately contract.',
   avoid:'This is a negative control. Small changes are baseline variation, not successful gestures.'},
  {id:'wrist-extension', name:'Wrist extension', target:4, img:'gesture-wrist-back.svg',
   setup:'Rest your right forearm palm-down on a table, with your hand just beyond the edge. Keep your elbow supported and fingers loose.',
   action:'Lift the back of your hand toward the ceiling by bending only at the wrist. Use a small, comfortable movement; hold gently when cued.',
   avoid:'Keep your forearm on the table. Do not make a fist or lift your entire arm.'},
  {id:'wrist-flexion', name:'Wrist flexion', target:5, img:'gesture-wrist-curl.svg',
   setup:'Rest your right forearm palm-up, with your hand just beyond the edge. Keep your fingers loose.',
   action:'Bend your palm toward the inside of your forearm. Use a small movement and hold gently.',
   avoid:'Keep your elbow and forearm supported. Avoid squeezing your fingers.'},
  {id:'pronation', name:'Palm-down rotation', target:0, img:'gesture-rotate-in.svg',
   setup:'Support your elbow with it bent about 90°. Start with your thumb pointing upward and wrist straight.',
   action:'Turn your forearm so your palm faces downward. Hold gently without forcing the end of the movement.',
   avoid:'Rotate the forearm, not the whole shoulder. Keep your wrist straight and fingers loose.'},
  {id:'supination', name:'Palm-up rotation', target:1, img:'gesture-rotate-out.svg',
   setup:'Support your elbow with it bent about 90°. Start with your thumb pointing upward and wrist straight.',
   action:'Turn your forearm so your palm faces upward. Hold gently without forcing the end of the movement.',
   avoid:'Keep your shoulder still. Avoid curling your elbow or making a fist.'},
  {id:'hand-open', name:'Hand opening', target:-1, img:null,
   setup:'Support your forearm and keep your wrist straight. Begin with your fingers resting in a loose curve.',
   action:'Gently straighten and spread your fingers, then hold the open hand.',
   avoid:'Do not bend the wrist backward. Keep the movement comfortable.'},
  {id:'fist', name:'Gentle fist', target:-1, img:'gesture-grip.svg',
   setup:'Support your forearm, wrist straight, hand relaxed.',
   action:'Close your fingers into a loose fist and hold gently. Use light effort, not a maximum squeeze.',
   avoid:'Do not curl your wrist or brace your upper arm.'},
  {id:'triceps', name:'Triceps comparison', target:2, img:'gesture-tricep.svg',
   setup:'Rest your upper arm comfortably near your side with your elbow bent. Keep your hand relaxed.',
   action:'Gently try to straighten your elbow against light resistance from your other hand. Keep the tested hand loose.',
   avoid:'Do not rotate your forearm or push hard. This checks whether an upper-arm action resembles a rotation signal.'},
  {id:'biceps', name:'Biceps comparison', target:3, img:'gesture-bicep.svg',
   setup:'Keep your upper arm near your side, elbow bent and palm up. Keep your hand loose.',
   action:'Gently try to bend your elbow against light resistance from your other hand.',
   avoid:'Keep your wrist straight and avoid gripping. Use the same light effort each time.'},
];
const DEFAULT_SITES=['Inner forearm / rotation','Outer forearm / rotation','Triceps','Biceps','Wrist extensor region','Wrist flexor region','Unused / describe site','Unused / describe site'];
const el = (tag, text, cls) => {const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
function dbOpen(){return new Promise((resolve,reject)=>{
 const req=indexedDB.open('emg-isolation-v1',1);
 req.onupgradeneeded=()=>{req.result.createObjectStore('recordings',{keyPath:'id'});req.result.createObjectStore('summaries',{keyPath:'id'});};
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
async function dbSave(record){const db=await dbOpen();try{await new Promise((resolve,reject)=>{
 const tx=db.transaction(['recordings','summaries'],'readwrite');
 tx.objectStore('recordings').put(record);
 const {stages,...brief}=record;tx.objectStore('summaries').put(brief);
 tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Save cancelled'));
 });}finally{db.close();}}
async function dbRead(store,id){const db=await dbOpen();try{return await new Promise((resolve,reject)=>{
 const req=id?db.transaction(store).objectStore(store).get(id):db.transaction(store).objectStore(store).getAll();
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });}finally{db.close();}}

export function createIsolation({app,channels,labels,physicalChannels,connected,isDemo,onOpen,onClose}){
 const dialog=el('dialog',undefined,'isolation');dialog.id='isolation';
 dialog.innerHTML=`
 <header class="iso-header"><div><div class="iso-eyebrow">PLACEMENT LAB · RIGHT ARM</div><h1>Find movements you can distinguish</h1><p>Start with your current sites. Compare processing before moving electrodes. Calibration is kept separate.</p></div><button id="iso-close">Close</button></header>
 <section class="iso-baseline"><h2>Standard placement procedure · about 6 min 22 s</h2><p>One start runs rest → palm-down rotation → palm-up rotation → triceps → biceps → wrist extension → wrist flexion. Each step takes 46 s, with 10 s to change position between steps. Read the instructions as they change; keep electrodes in place. Retries and saving can add time. This collects placement data; it does not retrain the arm controller.</p><div class="row"><button id="iso-sequence" class="primary">Start standard procedure · 6:22</button><button id="iso-export-set">Export this comparison set (JSON)</button></div><p id="iso-sequence-status" role="status">7 movements · automatic progression · stop any time</p><p class="hint">Completed movements save automatically in this browser on this site. Raw EMG, cues, placement notes and analysis stay local; clearing site data can remove them. Export the comparison set for a separate backup. Interrupted attempts are unscored and need their own export.</p><h2>Rotation baseline · same wiring</h2><p>Record rest, both rotation directions and a triceps comparison. Each recording is replayed with common-average subtraction ON and OFF. For an individual retry, choose a step, read its instructions, then press Ready. Live control settings do not change.</p><div id="iso-baseline-steps" class="row"></div><details><summary>Baseline comparison report</summary><div id="iso-baseline-report"></div></details></section>
 <div class="iso-layout"><section class="iso-setup">
 <label>Comparison set<input id="iso-batch" maxlength="100"></label>
 <label>Placement name<input id="iso-layout-name" value="Layout A — today's guide" maxlength="100"></label>
 <label>Movement<select id="iso-move"></select></label>
 <label>Channel to compare<select id="iso-target"></select></label>
 <details><summary>Electrode locations / placement notes</summary><div id="iso-sites"></div><label>What changed?<textarea id="iso-notes" rows="3" maxlength="1000" placeholder="For example: CH5 moved 1 cm toward elbow; other sites unchanged"></textarea></label></details>
 <div class="iso-instructions"><h2 id="iso-move-title"></h2><img id="iso-picture" alt=""><p id="iso-setup-text"></p><p id="iso-action"></p><p id="iso-avoid" class="hint"></p></div>
 <p class="hint">REF and BIAS stay in place. Six sensing sites need not respond independently: we are comparing repeatable patterns, not diagnosing individual muscles.</p>
 </section><section class="iso-live">
 <div id="iso-source" class="iso-badge"></div>
 <div id="iso-phase" aria-live="polite">Get into position</div><div id="iso-timer" class="mono">Ready when you are</div>
 <p id="iso-cue">Read the movement instructions. Begin with your hand relaxed.</p>
 <progress id="iso-progress" max="1" value="0"></progress>
 <div class="row"><button id="iso-start" class="primary">Ready — start this movement</button><button id="iso-stop" hidden>Stop test</button></div>
 <p id="iso-feedback" role="status"></p><button id="iso-partial" hidden>Export interrupted recording (unscored)</button>
 <p class="hint">3 s to settle → 10 s resting baseline → three rounds of 3 s preparation, 3 s gentle hold, 5 s relaxation. Brief packet gaps repeat only the affected round. Completed rounds are kept; a long interruption still stops the test.</p>
 <div id="iso-meters" class="iso-meters"></div>
 <p class="hint">Live values are processed envelopes in µV. Common-average referencing is ON, so activity can appear across channels through processing. Saturation checks are not electrode-impedance measurements.</p>
 </section></div>
 <section id="iso-results" hidden><h2>Movement response</h2><p id="iso-result-note"></p><div class="iso-table-wrap"><table><thead><tr><th>Channel</th><th>Rest µV</th><th>Hold µV</th><th>Change µV</th><th>Changes in repeats 1 / 2 / 3</th></tr></thead><tbody id="iso-result-rows"></tbody></table></div><p id="iso-interpretation"></p><h2>Same recording · common-average ON / OFF</h2><p id="iso-replay-note"></p><div class="iso-table-wrap" id="iso-replay-table"></div><button id="iso-replay">Replay both modes</button>
 <button id="iso-export">Export this recording (JSON)</button><p id="iso-save" class="hint"></p></section>
 <section><h2>Placement comparisons</h2><p class="hint">Compare the same movement, effort and posture. “Selected-channel share” is its share of positive envelope increases, not accuracy or muscle purity. Low-response recordings cannot establish good isolation.</p><div id="iso-history" class="iso-table-wrap"></div></section>`;
 document.body.append(dialog);
 const $=id=>dialog.querySelector(`#iso-${id}`);
 MOVES.forEach(m=>{const o=el('option',m.name);o.value=m.id;$('move').append(o);});
 const targetNone=el('option','No specific channel — compare all');targetNone.value='-1';$('target').append(targetNone);
 labels.forEach((label,i)=>{const o=el('option',label);o.value=i;$('target').append(o);
 const l=el('label',label),input=el('input');input.value=DEFAULT_SITES[i];input.maxLength=100;input.dataset.channel=i;l.append(input);$('sites').append(l);});
 const meters=labels.map(label=>{const n=el('div',undefined,'iso-meter');const name=el('span',label),bar=el('progress'),v=el('span','—','mono');bar.max=100;n.append(name,bar,v);$('meters').append(n);return{bar,v};});
 let run=null,record=null,history=[],lastPaint=0,lastPhase='',saveState='',active=false,sequence=null,finishing=false;
 const health=new StreamHealth();
 $('batch').value=new Date().toISOString().slice(0,16);
 const selected=()=>MOVES.find(m=>m.id===$('move').value);
 function currentMetadata(){return {comparisonSet:$('batch').value.trim(),layout:$('layout-name').value.trim(),movement:selected().id,movementName:selected().name,target:Number($('target').value),channels,labels,
  sites:[...$('sites').querySelectorAll('input')].map(n=>n.value),notes:$('notes').value,source:isDemo()?'synthetic-demo':'cyton',sampleRate:250,
  physicalChannels,acquisition:{gain:24,srb2:true,srb1:false},
  processing:{highpassHz:20,commonAverage:true,mainsHz:60,envelopeLowpassHz:5}};}
 function renderBaseline(metadata=currentMetadata()){
  const report=baselineReport(history,metadata),root=$('baseline-report');root.replaceChildren();
  root.append(el('p',`${metadata.source==='synthetic-demo'?'DEMO · ':''}${metadata.layout} · Set ${metadata.comparisonSet??'legacy'} · ${4-report.missing.length}/4 baseline recordings available. Latest matching trial per action; all recordings remain in history.`));
  const table=el('table'),h=el('tr');['Pattern comparison','CAR ON distance','CAR OFF distance'].forEach(t=>h.append(el('th',t)));table.append(h);
  report.on.forEach((pair,i)=>{const tr=el('tr');[`${MOVES.find(m=>m.id===pair.a).name} / ${MOVES.find(m=>m.id===pair.b).name}`,pair.value===null?'Need valid responses':pair.value.toFixed(3),report.off[i].value===null?'Need valid responses':report.off[i].value.toFixed(3)].forEach(t=>tr.append(el('td',t)));table.append(tr);});
  root.append(table,el('p','Distance compares the six/eight-channel response shapes: 0 = same shape, 1 = no overlap. Higher is more different, not recognition accuracy. Low responses are not scored. Check rest noise and repeat consistency too.','hint'));
  for(const id of ['rest','triceps']){const r=report.selected[id];if(!r)continue;
   const fmt=(mode,kind)=>r.comparison[mode].channels.slice(0,2).map((c,i)=>`CH${i+1} ${c[kind].toFixed(1)}`).join(', ');
   root.append(el('p',id==='rest'?`Rest median µV — ON: ${fmt('on','baseline')}; OFF: ${fmt('off','baseline')}.`:`Triceps-trial rotation-site changes µV — ON: ${fmt('on','delta')}; OFF: ${fmt('off','delta')}. These are envelope changes, not false command counts.`));
  }
  $('baseline-steps').querySelectorAll('button').forEach(b=>{b.disabled=active;b.textContent=`${report.selected[b.dataset.move]?'✓ ':''}${MOVES.find(m=>m.id===b.dataset.move).name}`;});
 }
 BASELINE.forEach(id=>{const b=el('button',MOVES.find(m=>m.id===id).name);b.dataset.move=id;b.onclick=()=>{$('move').value=id;$('move').onchange();};$('baseline-steps').append(b);});
 dialog.querySelectorAll('.iso-setup input').forEach(n=>n.addEventListener('change',()=>renderBaseline()));
 function showReplay(r){const root=$('replay-table');root.replaceChildren();$('replay').disabled=active;
  if(!r.comparison || r.comparison.version!==REPLAY_VERSION){$('replay-note').textContent=r.replayError||'Replay this saved recording to calculate the current per-round ON/OFF comparison.';return;}
  $('replay-note').textContent='Both modes use the same raw samples and production filters, reset separately for the baseline and each round. Three seconds of settle/prepare warm each block. Interrupted attempts are excluded; only common-average subtraction changes. This is not a gesture-decoder accuracy test.';
  const table=el('table'),h=el('tr');['Channel','Rest ON / OFF µV','Change ON / OFF µV','Repeat changes ON','Repeat changes OFF'].forEach(t=>h.append(el('th',t)));table.append(h);
  r.comparison.on.channels.forEach((a,i)=>{const b=r.comparison.off.channels[i],tr=el('tr');[r.metadata.labels[i],`${a.baseline.toFixed(1)} / ${b.baseline.toFixed(1)}`,`${a.delta.toFixed(1)} / ${b.delta.toFixed(1)}`,a.deltas.map(v=>v.toFixed(1)).join(' / '),b.deltas.map(v=>v.toFixed(1)).join(' / ')].forEach(t=>tr.append(el('td',t)));table.append(tr);});root.append(table);
 }
 function replayRecord(r){try{r.comparison=compareRecord(r,(raw,n,car,hz)=>app.replay_isolation(raw,n,car,hz));delete r.replayError;}catch(e){r.replayError=`Replay unavailable: ${e.message??e}`;delete r.comparison;}}
 $('replay').onclick=async()=>{if(!record||active)return;const r=record;replayRecord(r);showReplay(r);try{await dbSave(r);$('save').textContent='Recording and comparison saved locally.';}catch(e){$('save').textContent=`Save failed: ${e.message}. Export JSON to keep the result.`;}history=[{...r,stages:undefined},...history.filter(h=>h.id!==r.id)];renderHistory();};
 function instructions(){const m=selected();$('move-title').textContent=m.name;$('setup-text').textContent=m.setup;$('action').textContent=m.action;$('avoid').textContent=m.avoid;$('target').value=String(m.target<channels?m.target:-1);
 $('picture').hidden=!m.img;if(m.img){$('picture').src=m.img;$('picture').alt=`Illustration of ${m.name.toLowerCase()}; follow the written instructions.`;}}
 $('move').onchange=()=>{instructions();$('phase').textContent='Get into position';$('timer').textContent='Ready when you are';$('cue').textContent='Read the movement instructions. Begin with your hand relaxed.';$('progress').value=0;status('Press Ready when positioned for this movement.');};instructions();
 function lock(value){$('sequence').disabled=value||!health.ready;$('export-set').disabled=value;dialog.querySelectorAll('.iso-setup input,.iso-setup select,.iso-setup textarea').forEach(n=>n.disabled=value);$('start').hidden=value;$('stop').hidden=!value;$('close').textContent=value?'Stop and close':'Close';$('replay').disabled=value;renderBaseline();}
 function status(message){$('feedback').textContent=message;}
 function stop(reason){
  if(!active)return;
  sequence?.cancel();sequence=null;
  if(run&&!run.done)run.fail(reason);
  active=false;app.set_isolation_capture(false);lock(false);renderHistory();
  $('phase').textContent='Test stopped — relax';$('timer').textContent=run?.done?'Completed movement kept':'Current attempt unscored';
  $('partial').hidden=!run||run.done||!run.stages.some(s=>s.rows.length);
  $('sequence-status').textContent='Stopped. Completed movements remain in history; retry an unfinished movement individually or start a new procedure.';status(reason);
 }
 function close(){stop('Test cancelled. The incomplete recording was not scored.');dialog.close();onClose();}
 $('close').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 $('stop').onclick=()=>stop('Stopped by you. Relax, then restart when ready.');
 function exportJson(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 $('partial').onclick=()=>{if(run&&!run.done)exportJson({schema:3,status:'incomplete-unscored',metadata:run.metadata,error:run.error,recoveries:run.recoveries,stages:run.stages,packetStats:{start:run.initialStats,end:run.lastStats}},`emg-interrupted-${Date.now()}.json`);};
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)stop('The tab was hidden. Keep it visible and repeat the movement.');});
 function canStart(){
   if(active||finishing)return false;
   if(!connected()){status('Connect EMG first using the simulation’s CONNECT EMG button, then reopen this test.');return false;}
   health.update(app.stats(),performance.now(),connected());
   if(!health.ready){status('Waiting for a steady sample stream. If it stays stalled, close this lab and reconnect EMG.');return false;}
   if(!$('layout-name').value.trim()||!$('batch').value.trim()){status('Name this placement and comparison set before starting.');return false;}
   return true;
 }
 function startMovement(){
   const metadata={...currentMetadata(),instructions:{...selected()},startedAt:new Date().toISOString(),...(sequence?{sequence:sequence.metadata()}:{})};
   run=new IsolationRun(metadata,app.stats(),performance.now());$('partial').hidden=true;record=null;active=true;lastPhase='';
   app.set_isolation_capture(true);lock(true);renderHistory();$('results').hidden=true;status('Follow the large cue. Use your other hand for controls if needed.');
   if(sequence)$('sequence-status').textContent=`Step ${sequence.index+1} of ${STANDARD_MOVES.length} · ${selected().name} · about 6:22 total, plus any retries`;
   else $('sequence-status').textContent='Individual movement · about 46 seconds, plus any retries';
 }
 $('start').onclick=()=>{if(canStart()){sequence=null;startMovement();}};
 $('sequence').onclick=()=>{if(!canStart())return;sequence=new GuidedSequence(crypto.randomUUID());$('move').value=sequence.movement;instructions();startMovement();};
 $('export-set').onclick=async()=>{
  const metadata=currentMetadata();$('export-set').disabled=true;
  try{const summaries=await dbRead('summaries');const matching=summaries.filter(r=>layoutKey(r.metadata)===layoutKey(metadata));
   const recordings=await Promise.all(matching.map(r=>dbRead('recordings',r.id)));
   if(record&&layoutKey(record.metadata)===layoutKey(metadata)&&!recordings.some(r=>r?.id===record.id))recordings.push(record);
   if(!recordings.length)throw Error('No completed recordings for this comparison set and placement yet.');
   if(recordings.some(r=>!r))throw Error('A recording is unavailable. Export individual recordings from history.');
   exportJson({schema:1,type:'emg-placement-comparison-set',exportedAt:new Date().toISOString(),metadata,recordings},`emg-comparison-set-${Date.now()}.json`);
   status(`Exported ${recordings.length} completed recordings for this set and placement.`);
  }catch(e){status(`Export failed: ${e.message}`);}finally{$('export-set').disabled=active;}
 };
 function showRecord(r){record=r;showReplay(r);const s=r.summary;$('results').hidden=false;$('result-rows').replaceChildren();
  $('result-note').textContent=`${r.metadata.source==='synthetic-demo'?'DEMO · ':''}${r.metadata.layout} · ${r.metadata.movementName} · ${new Date(r.metadata.startedAt).toLocaleString()} · ${r.recoveries?.length??0} interrupted block(s) repeated`;
  s.channels.forEach((c,i)=>{const tr=el('tr');if(i===r.metadata.target)tr.className='iso-selected';
   [r.metadata.labels[i],c.baseline.toFixed(1),(c.baseline+c.delta).toFixed(1),(c.delta>=0?'+':'')+c.delta.toFixed(1),c.deltas.map(d=>d.toFixed(1)).join(' / ')].forEach(v=>tr.append(el('td',v)));$('result-rows').append(tr);});
  const leaders=s.repeatLeaders.map(i=>i===null?'none':r.metadata.labels[i]).join(' / ');
  $('interpretation').textContent=r.metadata.movement==='rest'?'Rest control: small changes are expected. Compare baseline levels and drift across repeats; this is not a gesture-isolation score.':s.lowResponse?'Little change above baseline variation. This does not establish isolation; check the movement and contact, then repeat.':`Largest increases across repeats: ${leaders}. ${s.targetShare===null?'':`Selected-channel share: ${Math.round(s.targetShare*100)}%. `}Check repeat consistency and the other channels before changing a site. Shared activity may reflect coactivation, pickup or common-average processing.`;
 }
 async function complete(){finishing=true;const owner=sequence;app.set_isolation_capture(false);$('phase').textContent='Movement complete — relax';$('timer').textContent=selected().id==='rest'?'3 of 3 rest periods recorded':'3 of 3 holds recorded';$('progress').value=1;
   const completed={id:crypto.randomUUID(),schema:3,recoveries:run.recoveries,packetStats:{start:run.initialStats,end:Array.from(app.stats()),missingSamplesScored:false},metadata:run.metadata,summary:summarize(run),stages:run.stages,
    rowFormat:'Each row: raw logical CH1–8 µV, envelope logical CH1–8 µV, 8 saturation/contact flags. Rows within each baseline/repetition block are contiguous at 250 Hz. Blocks may be separated by discarded attempts listed in recoveries; never concatenate their time axes as continuous.'};
   replayRecord(completed);showRecord(completed);status(`Trial ready for review. ${run.recoveries.length} interrupted block(s) repeated; no missing samples scored. Choose the next baseline step above and keep electrodes in place.`);
   $('save').textContent='Saving locally in this browser…';
   let saved=false;
   try{await dbSave(completed);saved=true;saveState='Saved locally in this browser. Export JSON to keep a separate copy.';}
   catch(e){saveState=`Local save failed (${e.message}). Export JSON now to keep this recording.`;}
   if(record?.id===completed.id)$('save').textContent=saveState;
   history=[{...completed,stages:undefined},...history.filter(h=>h.id!==completed.id)];finishing=false;
   // Stop/close during the asynchronous save must never restart the sequence.
   if(!active||sequence!==owner){lock(false);renderHistory();return;}
   if(owner&&!saved){stop('Local save failed. Procedure stopped; export this recording before continuing.');return;}
   if(owner){
    owner.saved(completed.id,performance.now());
    if(owner.state==='transition'){
     $('move').value=owner.movement;instructions();
     $('phase').textContent=`Change position · next: ${selected().name}`;$('cue').textContent=selected().setup;
     $('sequence-status').textContent=`${owner.recordIds.length} of 7 saved · next: ${selected().name}`;
     status('Relax and get into the next position. Recording begins automatically after the countdown.');
     renderHistory();return;
    }
    $('phase').textContent='Standard procedure complete — relax';$('timer').textContent='7 of 7 movements saved';
    $('sequence-status').textContent='All 7 movements saved locally. Export this comparison set for a separate backup.';
    status('Procedure complete. Review the results in history or export the whole comparison set.');sequence=null;
   }
   active=false;lock(false);renderHistory();
 }
 function renderHistory(){renderBaseline();const root=$('history');root.replaceChildren();const visible = history.filter(r => r.metadata.source === (isDemo() ? 'synthetic-demo' : 'cyton') && r.metadata.channels === channels);if(!visible.length){root.append(el('p','No completed tests for this source yet.'));return;}
  const table=el('table'),head=el('tr');['Placement / movement','Largest response','Selected-channel share','Repeats',''].forEach(x=>head.append(el('th',x)));table.append(head);
  visible.sort((a,b)=>b.metadata.startedAt.localeCompare(a.metadata.startedAt)).forEach(r=>{
   const tr=el('tr'),s=r.summary;[`${r.metadata.source==='synthetic-demo'?'DEMO · ':''}${r.metadata.layout} / ${r.metadata.movementName}`,
   s.strongest===null?'No increase':r.metadata.labels[s.strongest],s.lowResponse?'Low response':s.targetShare===null?'—':`${Math.round(s.targetShare*100)}%`,s.repeatLeaders.map(i=>i===null?'—':r.metadata.labels[i]).join(' / ')].forEach(x=>tr.append(el('td',x)));
   const td=el('td'),b=el('button','View');b.disabled=active;b.onclick=async()=>{try{const full=record?.id===r.id?record:await dbRead('recordings',r.id);if(!full)throw new Error('Recording unavailable');$('batch').value=full.metadata.comparisonSet??'Legacy comparison';$('layout-name').value=full.metadata.layout;
   $('sites').querySelectorAll('input').forEach((n,i)=>n.value=full.metadata.sites[i]??'');$('notes').value=full.metadata.notes??'';
   $('move').value=full.metadata.movement;$('move').onchange();$('target').value=String(full.metadata.target);
   showRecord(full);renderBaseline();$('save').textContent='Loaded from this browser.';}catch(e){status(e.message);}};td.append(b);tr.append(td);table.append(tr);
  });root.append(table);
 }
 $('export').onclick=()=>{if(record)exportJson(record,`emg-isolation-${record.metadata.movement}-${record.id}.json`);};
 dbRead('summaries').then(rows=>{history=rows;renderHistory();}).catch(()=>{$('history').textContent='Local history is unavailable. Completed tests can still be exported.';});
 return {
  get open(){return dialog.open;},
  get active(){return active;},
  demoChannel(){return active&&!finishing&&(!sequence||sequence.state==='recording')&&selected().id!=='rest'&&run?.stage?.kind==='hold'?(selected().target>=0?selected().target:4):-1;},
  show(){onOpen();health.reset();$('start').disabled=true;dialog.showModal();renderHistory();$('source').textContent=isDemo()?'SYNTHETIC DEMO — not your muscle readings':connected()?'LIVE CYTON · robot movement paused':'NO STREAM · connect EMG to record';status(connected()?'Start the standard procedure, or choose an individual movement and press Ready.':'Connect EMG first, then return here.');},
  tick(now){
   if(!dialog.open)return;
   health.update(app.stats(),now,connected());
   $('start').disabled=active||finishing||!health.ready;$('sequence').disabled=active||finishing||!health.ready;
   $('source').textContent=!connected()?'NO STREAM · close lab and connect EMG':health.ready?`${isDemo()?'SYNTHETIC DEMO':'LIVE CYTON'} · ${Math.round(health.pps)} samples/s · robot movement paused`:'WAITING / STALLED · no steady samples · close lab and reconnect if this persists';
   if(active&&sequence?.state==='transition'){
    if(!connected()){stop('Stream disconnected between movements. Completed recordings are kept.');return;}
    const left=Math.max(0,Math.ceil((sequence.readyAt-now)/1000));
    $('timer').textContent=left?`${left} s to next movement`:health.ready?'Starting…':'Waiting for steady samples…';
    if(now>sequence.readyAt+10000&&!health.ready){stop('No steady stream for the next movement. Completed recordings are kept.');return;}
    if(sequence.begin(now,health.ready))startMovement();
   }
   if(active&&!finishing&&(!sequence||sequence.state==='recording')){
    const samples=app.take_isolation_samples();
    // Check elapsed silence BEFORE accepting a late burst after a stalled frame.
    const acceptBatch=run.check(app.stats(),now,connected(),app.isolation_overflow());
    if(acceptBatch)run.feed(samples,now);
    else if(!run.error){lastPhase='';status(run.notice);}
    if(run.error){stop(run.error);return;}
    if(run.done){complete();return;}
    const phase=`${run.stage.kind}-${run.stage.rep}`;
    if(phase!==lastPhase){lastPhase=phase;const kind=run.stage.kind;
     $('phase').textContent=kind==='hold'?`${selected().id==='rest'?'Stay relaxed':'Hold gently'} · ${run.stage.rep} of 3`:kind==='rest'?'Resting baseline':kind==='recover'?`Relax · after ${selected().id==='rest'?'observation':'hold'} ${run.stage.rep}`:kind==='prepare'?`${selected().id==='rest'?'Stay relaxed · observation':'Get ready · hold'} ${run.stage.rep} of 3`:'Settle into position';
     $('cue').textContent=kind==='hold'?selected().action:kind==='prepare'?(selected().id==='rest'?'Keep resting through the observation period.':'Stay relaxed until the cue changes to Hold gently.'):'Let your hand return to its relaxed starting position. Keep the arm supported.';
    }
    $('timer').textContent=`${Math.ceil(run.remaining)} s`;
    $('progress').value=run.stages.reduce((n,s)=>n+s.rows.length,0)/(46*250);
   }
   if(now-lastPaint>100){lastPaint=now;const values=app.envelopes();const max=Math.max(10,...Array.from(values).slice(0,channels));meters.forEach((m,i)=>{m.bar.max=max;m.bar.value=health.ready?values[i]:0;m.v.textContent=health.ready?`${values[i].toFixed(1)} µV`:'— awaiting samples';});}
  },
 };
}
