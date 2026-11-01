import {CytonSerial} from '/arm/serial.js';
import {CytonParser, SOSFilter, FINGERS, fingerAngles, calibratedFlexion, syntheticFlexion, median} from './core.js?v=2';

const $ = id => document.getElementById(id);
const settings = ['source','rate','wiring','mains'];
let profile, filter, parser, serial, running = false, sourceStarted = 0, generated = 0;
let sampleCount = 0, packetGaps = 0, lastIndex = null, settleUntil = 0, lastSampleTime = 0;
let plot = [], filteredWindow = [], latestVision = null, prediction = null, predictionBusy = false;
let cameraStream, worker, cameraReady = false, frameBusy = false, frameHandle, frameFallback;
let calibration = {open:null,closed:null}, angleHistory = [], previousAngles = null;
let frameCount = 0, validFrames = 0, skippedFrames = 0, syntheticVisionAt = -1;
let sessionId = null, recording = false, recordedAt = 0, savedCounts = null, batchId = 0, saving = null;
let pending = {emg:[],vision:[],events:[]};
let prompting = false, promptStarted = 0, lastCue = -1;
let lastStatsAt = performance.now(), lastStatsSamples = 0, lastPredictAt = 0;
const cues = ['Rest · relax every finger','Thumb · slowly flex and extend','Index · slowly flex and extend',
  'Middle · slowly flex and extend','Ring · slowly flex and extend','Little · slowly flex and extend',
  'Thumb + index · move together','Middle + ring + little · move together'];

async function api(path, options={}) {
  const response = await fetch(path, {headers:{'Content-Type':'application/json'},...options});
  if (!response.ok) { let error; try { error = await response.json(); } catch { error = {}; } throw new Error(typeof error.detail === 'string' ? error.detail : `Recorder returned ${response.status}`); }
  return response.json();
}
function notice(message, error=false) { $('notice').textContent=message; $('notice').classList.toggle('error',error); }
function event(type, data={}) { if (recording) pending.events.push({t_ms:performance.now(),type,data}); }
function updateControls() {
  settings.forEach(id=>$(id).disabled=running||!!sessionId);
  ['participant','split','delay','hand'].forEach(id=>$(id).disabled=!!sessionId);
  $('rate').disabled ||= $('source').value==='cyton';
  $('connect').textContent=running?'Disconnect source':$('source').value==='cyton'?'Connect Cyton':'Start synthetic stream';
  $('connect').disabled=!!sessionId;
  $('camera').disabled=!!sessionId;
  if(sessionId) $('open-cal').disabled=$('closed-cal').disabled=true;
  $('record').disabled=!running&&!sessionId;
  $('record').innerHTML=sessionId?(recording?'■ Finish & save recording':'Retry save & finish'):'<span>●</span> Start recording';
  $('record').classList.toggle('recording-now',!!sessionId);
  $('state').textContent=recording?'Recording locally':running?'Live preview':'Ready to connect';
  $('source-pill').textContent=running?($('source').value==='synthetic'?'SYNTHETIC':'CYTON · 250 HZ'):'NO SOURCE';
  $('source-pill').classList.toggle('live',running);
}

async function configure() {
  if ($('source').value==='cyton') $('rate').value='250';
  profile=await api(`/api/filter?rate=${$('rate').value}&mains=${$('mains').value}`);
  filter=new SOSFilter(profile.sos); parser=new CytonParser(profile.sample_rate_hz);
  plot=[]; filteredWindow=[]; latestVision=null;
  if(!cameraStream) {
    $('camera-empty').querySelector('strong').textContent='A second view of the signal';
    $('vision-pill').textContent='OFFLINE';
    $('vision-status').textContent='Calibrate open and closed poses before collecting visual labels.';
  }
  $('filter-label').textContent=`${profile.low_hz}–${profile.high_hz} Hz · causal band-pass${profile.mains_hz?' · '+profile.mains_hz+' Hz notch':''}`;
  updateControls();
}
settings.forEach(id=>$(id).addEventListener('change',()=>configure().catch(e=>notice(e.message,true))));

function acceptSamples(samples) {
  for (const sample of samples) {
    if (lastIndex===null||sample.index!==lastIndex+1) {
      if(lastIndex!==null) packetGaps+=Math.max(0,sample.index-lastIndex-1);
      filter.reset(); filteredWindow=[]; settleUntil=sample.t_ms+1000;
    }
    lastIndex=sample.index; lastSampleTime=sample.t_ms; sampleCount++;
    const filtered=filter.process(sample.uv);
    if(sample.clipped||sample.timing_uncertain) { filteredWindow=[]; settleUntil=sample.t_ms+1000; }
    plot.push({t:sample.t_ms,values:filtered});
    if(sample.t_ms>=settleUntil) filteredWindow.push(filtered);
    if(recording) pending.emg.push(sample);
  }
  const max=profile.sample_rate_hz*3;
  if(plot.length>max) plot.splice(0,plot.length-max);
  const window=profile.sample_rate_hz*.2;
  if(filteredWindow.length>window) filteredWindow.splice(0,filteredWindow.length-window);
  $('clock-quality').textContent=$('source').value==='synthetic'?'Synthetic sample clock':samples.some(s=>s.timing_uncertain)?'Timing uncertain · finish and reconnect':'Reconstructed · timing offset unmeasured';
  if(pending.emg.length>profile.sample_rate_hz*10) {
    recording=false; notice('Recording paused: save queue exceeded 10 seconds. Keep this tab open and use Retry save & finish.',true); updateControls();
  }
}

function normal() { return Math.sqrt(-2*Math.log(1-Math.random()))*Math.cos(2*Math.PI*Math.random()); }
function synthTick() {
  if(!running||$('source').value!=='synthetic') return;
  const now=performance.now(), rate=profile.sample_rate_hz;
  const due=Math.floor((now-sourceStarted)*rate/1000), rows=[];
  if(due-generated>rate) generated=due-rate; // Explicit index gap after a suspended/throttled tab.
  for(;generated<due;generated++) {
    const t=generated/rate, y=syntheticFlexion(t);
    const uv=Array.from({length:8},(_,ch)=>{
      const drive=y.reduce((s,v,i)=>s+v*(.12+((ch*3+i*5)%11)/18),0);
      return 1000+ch*100+(3+60*drive)*normal()+12*Math.sin(2*Math.PI*60*t);
    });
    rows.push({index:generated,sequence:generated%256,t_ms:sourceStarted+t*1000,received_ms:now,uv,clipped:false});
  }
  acceptSamples(rows);
  if(now-syntheticVisionAt>1000/30) {
    syntheticVisionAt=now;
    acceptVision({t_ms:now,processed_ms:now,valid:true,reason:'synthetic ground truth',flexion:syntheticFlexion((now-sourceStarted)/1000)});
    $('vision-pill').textContent='SYNTHETIC'; $('vision-status').textContent='Generated labels for pipeline testing. These are not camera measurements.';
  }
}
setInterval(synthTick,20);

$('connect').onclick=async()=>{
  try {
    if(running) {
      running=false;
      await serial?.disconnect(); serial=null;
      $('source-status').textContent='Source disconnected.'; updateControls(); return;
    }
    await configure();
    plot=[];filteredWindow=[];lastIndex=null;packetGaps=0;sampleCount=0;lastStatsSamples=0;lastStatsAt=performance.now();
    latestVision=null;frameCount=validFrames=0;
    if($('source').value==='synthetic') {
      await stopCamera();
      sourceStarted=performance.now();generated=0;running=true;
      $('source-status').textContent='Synthetic signals + generated labels. No hardware or camera needed.';
      $('camera-empty').hidden=false; $('camera-empty').querySelector('strong').textContent='Synthetic label stream';
      notice('Synthetic data is for pipeline checks only. Keep it separate from human training recordings.');
    } else {
      if(!('serial' in navigator)) throw new Error('Web Serial requires Chrome or Edge on localhost.');
      $('connect').disabled=true;
      serial=new CytonSerial({wiring:$('wiring').value,
        onData:bytes=>acceptSamples(parser.push(bytes,performance.now())),
        onStatus:message=>$('source-status').textContent=message,
        onClose:()=>{
          running=false;
          event('source_disconnected');
          if(recording) { recording=false; notice('Cyton disconnected. Finish and save this interrupted source recording before reconnecting.',true); }
          updateControls();
        }});
      await serial.connect();running=true;
      notice('Cyton is connected. Enable the camera and capture open/closed hand poses to create visual labels.');
    }
  } catch(e) { try{await serial?.disconnect();}catch{} serial=null;running=false;notice(e.message,true); }
  updateControls();
};

function acceptVision(frame) {
  latestVision=frame;frameCount++;if(frame.valid)validFrames++;
  if(recording) pending.vision.push(frame);
}
function handleVision(data) {
  frameBusy=false;
  if(data.type==='ready') {cameraReady=true;$('vision-status').textContent='Tracker ready. Show the selected hand, then capture open and closed poses.';return;}
  if(data.type==='error') {notice(`Hand tracker: ${data.message}`,true);cameraReady=false;return;}
  if(data.type!=='result')return;
  const matches=data.handedness.map((h,i)=>({h:h[0],i})).filter(({h})=>h.categoryName===$('hand').value);
  let reason='no selected hand', angles=null, landmarks=null, world=null, score=null;
  if(matches.length===1) {
    const {h,i}=matches[0];score=h.score;
    landmarks=data.landmarks[i].map(p=>[p.x,p.y,p.z]);world=data.world[i].map(p=>[p.x,p.y,p.z]);
    angles=fingerAngles(world);
    reason=!angles?'degenerate geometry':landmarks.some(p=>p[0]<.02||p[0]>.98||p[1]<.02||p[1]>.98)?'hand crosses frame edge':score<.6?'ambiguous handedness':'ok';
    if(reason==='ok'&&previousAngles&&data.t_ms-previousAngles.t<150&&angles.some((v,i)=>Math.abs(v-previousAngles.values[i])>65))reason='implausible angle jump';
    if(angles) previousAngles={t:data.t_ms,values:angles};
    if(reason==='ok') {
      angleHistory.push({t:data.t_ms,values:angles});
      angleHistory=angleHistory.filter(x=>data.t_ms-x.t<1500);
    }
  }
  if(matches.length>1)reason='ambiguous hands';
  const flexion=reason==='ok'?calibratedFlexion(angles,calibration):null;
  if(reason==='ok'&&!flexion)reason='open / closed calibration needed';
  const valid=reason==='ok';
  acceptVision({t_ms:data.t_ms,processed_ms:performance.now(),media_time_s:data.media_time_s,valid,reason,
    flexion,angles,landmarks,world_landmarks:world,handedness_score:score});
  $('vision-pill').textContent=valid?'TRACKING':'CHECK LABEL';$('vision-pill').classList.toggle('live',valid);
  $('vision-status').textContent=valid?`Calibrated visual label · ${skippedFrames} frames skipped while tracker was busy`:`Label unavailable: ${reason}`;
  $('open-cal').disabled=!angles||!!sessionId;$('closed-cal').disabled=!angles||!!sessionId;
  drawHand(landmarks);
}
async function sendCameraFrame(now, metadata={}) {
  if(!cameraStream)return;
  if(cameraReady&&!frameBusy&&$('video').readyState>=2) {
    frameBusy=true;
    try {
      const bitmap=await createImageBitmap($('video'));
      if(worker)worker.postMessage({type:'frame',bitmap,t_ms:now,media_time_s:metadata.mediaTime??$('video').currentTime},[bitmap]);
      else bitmap.close();
    } catch(e){frameBusy=false;notice(e.message,true);}
  }else if(frameBusy)skippedFrames++;
  if(cameraStream&&$('video').requestVideoFrameCallback)frameHandle=$('video').requestVideoFrameCallback(sendCameraFrame);
}
async function stopCamera() {
  if(frameHandle) $('video').cancelVideoFrameCallback?.(frameHandle);
  clearInterval(frameFallback);
  cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;
  worker?.terminate();worker=null;cameraReady=false;frameBusy=false;
  $('video').srcObject=null;$('camera-empty').hidden=false;$('camera').textContent='Enable camera';
  $('vision-pill').textContent='OFFLINE';
  $('open-cal').disabled=$('closed-cal').disabled=true;
}
$('camera').onclick=async()=>{
  try{
    if(cameraStream){event('camera_stopped');await stopCamera();return;}
    if(running&&$('source').value==='synthetic')throw new Error('Stop the synthetic stream before enabling a real camera.');
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:30}},audio:false});
    $('video').srcObject=cameraStream;await $('video').play();
    calibration={open:null,closed:null};angleHistory=[];previousAngles=null;skippedFrames=0;
    $('open-cal').textContent='Capture open hand';$('closed-cal').textContent='Capture closed hand';
    $('camera-empty').hidden=true;$('camera').textContent='Disable camera';
    $('vision-status').textContent='Loading local hand tracker…';
    worker=new Worker('/assets/vision-worker.js?v=2');
    worker.onmessage=({data})=>handleVision(data);
    worker.onerror=e=>{cameraReady=false;frameBusy=false;notice(`Tracker failed: ${e.message}. Run scripts/download_models.py.`,true);};
    worker.postMessage({type:'init'});
    if($('video').requestVideoFrameCallback)frameHandle=$('video').requestVideoFrameCallback(sendCameraFrame);
    else frameFallback=setInterval(()=>sendCameraFrame(performance.now()),34);
    event('camera_started');
  }catch(e){await stopCamera();notice(`Camera: ${e.message}`,true);}
};
$('hand').onchange=()=>{calibration={open:null,closed:null};angleHistory=[];previousAngles=null;notice('Hand selection changed. Capture both calibration poses again.');};
for(const pose of ['open','closed']) $(pose+'-cal').onclick=()=>{
  const rows=angleHistory.filter(x=>performance.now()-x.t<1200);
  if(rows.length<10||rows.at(-1).t-rows[0].t<400){notice('Keep the full hand visible and hold the pose steady for one second.',true);return;}
  const center=median(rows.map(x=>x.values));
  if(rows.some(r=>r.values.some((v,i)=>Math.abs(v-center[i])>15))){notice('The pose moved during calibration. Hold it still and try again.',true);return;}
  calibration[pose]=center;$(pose+'-cal').textContent=pose==='open'?'Open pose captured ✓':'Closed pose captured ✓';
  if(calibration.open&&calibration.closed&&!calibratedFlexion(center,calibration))notice('Open-to-closed range is too small for one or more fingers. Re-capture both poses with all fingertips visible.',true);
  else notice(`${pose==='open'?'Open':'Closed'} pose captured. ${calibration.open&&calibration.closed?'Visual labels are calibrated.':'Capture the other pose next.'}`);
};

async function flush() {
  if(saving)return saving;
  if(!sessionId||!Object.values(pending).some(x=>x.length))return;
  const batch={batch_id:batchId,emg:pending.emg.splice(0,2000),vision:pending.vision.splice(0,120),events:pending.events.splice(0,100)};
  saving=(async()=>{
    try{
      const result=await api(`/api/sessions/${sessionId}/batch`,{method:'POST',body:JSON.stringify(batch)});
      batchId++;savedCounts=result.counts;
      $('save-status').textContent=`Saved ${savedCounts.emg.toLocaleString()} raw samples · ${savedCounts.vision.toLocaleString()} visual frames · session ${sessionId.slice(0,8)}`;
    }catch(e){for(const k of ['emg','vision','events'])pending[k].unshift(...batch[k]);recording=false;updateControls();notice(`Save paused: ${e.message}. Keep this tab open; Retry save & finish retains queued data.`,true);throw e;}
    finally{saving=null;}
  })();
  return saving;
}
setInterval(()=>{if(recording)flush().catch(()=>{});},200);

async function finishRecording() {
  event('recording_stopped');recording=false;$('record').disabled=true;
  try{
    if(saving)await saving;
    while(Object.values(pending).some(x=>x.length))await flush();
    await api(`/api/sessions/${sessionId}/stop`,{method:'POST'});
    sessionId=null;$('record-title').textContent='Recording saved.';
    notice('Recording saved locally. Create separate validation and test recordings before training.');
    await refreshSessions();
  }finally{updateControls();}
}
$('record').onclick=async()=>{
  try{
    if(sessionId){await finishRecording();return;}
    const config={source:$('source').value,sample_rate_hz:profile.sample_rate_hz,participant:$('participant').value.trim(),
      split:$('split').value,wiring:$('wiring').value,mains_hz:Number($('mains').value),hand:$('hand').value,
      label_delay_ms:Number($('delay').value),client_time_origin_ms:performance.timeOrigin,notes:''};
    const result=await api('/api/sessions',{method:'POST',body:JSON.stringify(config)});
    sessionId=result.id;recording=true;recordedAt=performance.now();batchId=0;savedCounts=null;
    pending={emg:[],vision:[],events:[]};
    event('recording_started',{calibration,source_started_ms:sourceStarted,tracking_thresholds:{detection:.6,presence:.6,tracking_iou:.6},label_definition:'mean joint bend normalized between open and closed poses'});
    $('record-title').textContent='Recording in progress.';
    if(!latestVision?.valid)notice('Recording raw EMG without valid visual labels. Finish this recording, then calibrate the camera before your next supervised session.');
    else notice('Recording raw EMG and visual labels locally. Finish recording before closing the tab.');
    updateControls();
  }catch(e){notice(e.message,true);}
};
window.addEventListener('beforeunload',e=>{if(sessionId){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>event('page_visibility',{state:document.visibilityState}));
$('prompts').onclick=()=>{prompting=!prompting;promptStarted=performance.now();lastCue=-1;$('prompts').textContent=prompting?'Stop prompts':'Start prompts';if(!prompting){$('cue').textContent='Move freely, or follow a cue';$('cue-progress').firstElementChild.style.width='0';event('prompts_stopped');}};

async function refreshSessions(){
  const rows=await api('/api/sessions');$('session-list').replaceChildren();
  if(!rows.length){$('session-list').textContent='No recordings yet. Start with a short synthetic recording to check the workflow.';return;}
  for(const row of rows){
    const div=document.createElement('div');div.className='session-row';
    const identity=document.createElement('span');identity.textContent=row.config.participant;
    const small=document.createElement('small');small.textContent=new Date(row.created_utc).toLocaleString();identity.append(small);div.append(identity);
    for(const text of [`${row.config.source==='synthetic'?'Synthetic':'Cyton'} · ${row.config.sample_rate_hz} Hz`,`${row.config.split.toUpperCase()} · ${row.status}`,`${row.counts.emg.toLocaleString()} samples`]){const el=document.createElement('span');el.textContent=text;if(text.startsWith('Synthetic'))el.className='synthetic';div.append(el);}
    const a=document.createElement('a');a.textContent=row.status==='recording'?'Recording…':'Download ZIP ↗';if(row.status!=='recording')a.href=`/api/sessions/${row.id}/export`;div.append(a);$('session-list').append(div);
  }
}
$('refresh').onclick=()=>refreshSessions().catch(e=>notice(e.message,true));

FINGERS.forEach(name=>{const row=document.createElement('div');row.className='finger-row';row.innerHTML=`<span>${name}</span><div class="finger-track"><div class="measured"></div><div class="predicted"></div></div><output>—</output>`;$('finger-bars').append(row);});
function drawSignal(){
  const canvas=$('signal'),dpr=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.font='10px Segoe UI';
  const chHeight=h/8,left=40;
  for(let ch=0;ch<8;ch++){
    const center=(ch+.5)*chHeight;ctx.strokeStyle='#eaf0eb';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,center);ctx.lineTo(w,center);ctx.stroke();ctx.fillStyle='#72857b';ctx.fillText(`CH${ch+1}`,0,center+3);
    if(!plot.length)continue;
    const scale=Math.max(15,...plot.filter((_,i)=>i%4===0).map(p=>Math.abs(p.values[ch])));
    ctx.strokeStyle=ch%2?'#377c86':'#4b947d';ctx.lineWidth=1;ctx.beginPath();
    const stride=Math.max(1,Math.floor(plot.length/(w-left)));
    for(let i=0;i<plot.length;i+=stride){const p=plot[i],x=left+(p.t-(lastSampleTime-3000))/3000*(w-left),y=center-p.values[ch]/scale*chHeight*.38;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
  }
}
function drawHand(points){
  const canvas=$('overlay'),video=$('video'),ctx=canvas.getContext('2d');canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||480;
  ctx.clearRect(0,0,canvas.width,canvas.height);if(!points)return;
  const chains=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  ctx.strokeStyle='#73dbb5';ctx.lineWidth=3;
  for(const chain of chains){ctx.beginPath();chain.forEach((id,j)=>{const p=points[id];ctx[j?'lineTo':'moveTo'](p[0]*canvas.width,p[1]*canvas.height);});ctx.stroke();}
  ctx.fillStyle='#eafef5';points.forEach(p=>{ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,3,0,Math.PI*2);ctx.fill();});
}
async function updatePrediction(now){
  if(!$('predict').checked||predictionBusy||!running||now-lastPredictAt<100||filteredWindow.length!==profile.sample_rate_hz*.2)return;
  lastPredictAt=now;predictionBusy=true;
  try{prediction=await api('/api/predict',{method:'POST',body:JSON.stringify({sample_rate_hz:profile.sample_rate_hz,mains_hz:profile.mains_hz,filtered_uv:filteredWindow})});
    $('model-status').textContent=`${prediction.training_source==='synthetic'?'Synthetic-trained demo · not validated on people':'Local CNN'} · predicts visual flexion ${prediction.label_delay_ms>=0?'+':''}${prediction.label_delay_ms} ms from window end`;
  }catch(e){$('predict').checked=false;$('model-status').textContent=e.message;prediction=null;}
  finally{predictionBusy=false;}
}
function draw(now){
  drawSignal();
  const fresh=latestVision&&now-latestVision.t_ms<250&&latestVision.valid;
  [...$('finger-bars').children].forEach((row,i)=>{const value=fresh?latestVision.flexion[i]:null;row.querySelector('.measured').style.width=`${(value??0)*100}%`;row.querySelector('.predicted').style.width=`${$('predict').checked&&prediction?prediction.flexion[i]*100:0}%`;row.querySelector('output').textContent=value===null?'—':`${Math.round(value*100)}%`;});
  if(now-lastStatsAt>=1000){$('pps').textContent=running?Math.round((sampleCount-lastStatsSamples)*1000/(now-lastStatsAt)):'—';lastStatsAt=now;lastStatsSamples=sampleCount;$('gaps').textContent=packetGaps;$('coverage').textContent=frameCount?`${Math.round(validFrames/frameCount*100)}%`:'—';}
  if(recording){const elapsed=Math.floor((now-recordedAt)/1000);$('elapsed').textContent=`${Math.floor(elapsed/60).toString().padStart(2,'0')}:${(elapsed%60).toString().padStart(2,'0')}`;}
  if(prompting){const index=Math.floor((now-promptStarted)/6000)%cues.length;if(index!==lastCue){lastCue=index;$('cue').textContent=cues[index];event('cue',{text:cues[index],not_ground_truth:true});}$('cue-progress').firstElementChild.style.width=`${((now-promptStarted)%6000)/60}%`;}
  updatePrediction(now);requestAnimationFrame(draw);
}
try{
  const health=await api('/api/health');$('server').textContent='Recorder online · files stay on this computer';
  if(!health.camera_model_ready||!health.mediapipe_ready)notice('Camera assets are missing. Run npm install and .venv\\Scripts\\python scripts/download_models.py.',true);
  const model=await api('/api/model');$('model-status').textContent=model.available?'Local model found. Enable comparison after connecting a source.':'No trained model yet. Record sessions, build a dataset, then run emg-train.';
  $('predict').disabled=!model.available;
  await configure();await refreshSessions();requestAnimationFrame(draw);
}catch(e){$('server').textContent='Recorder unavailable';notice(e.message,true);}
