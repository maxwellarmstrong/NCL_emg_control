import {MovementTracker, classifyHandGesture} from './movement.js';
import {CytonSerial} from '/arm/serial.js';
import {CytonParser, SignalProcessor, channelScales, waveformBins, armMeasurement, FINGERS, fingerAngles, calibratedFlexion, syntheticFlexion, median} from './core.js?v=4';

const $ = id => document.getElementById(id);
const settings = ['source','rate','wiring','mains'];
let profile, processor, parser, serial, running = false, sourceStarted = 0, generated = 0;
let storageReady = false, visionReady = false;
let sampleCount = 0, packetGaps = 0, lastIndex = null, lastSampleTime = 0;
let plot = [], filteredWindow = [], latestVision = null, prediction = null, predictionBusy = false;
let cameraStream, worker, cameraReady = false, frameBusy = false, frameHandle, frameFallback;
let calibration = {open:null,closed:null}, angleHistory = [], previousAngles = null;
let frameCount = 0, validFrames = 0, skippedFrames = 0, syntheticVisionAt = -1;
let sessionId = null, recording = false, recordedAt = 0, savedCounts = null, batchId = 0, saving = null;
let pending = {emg:[],vision:[],events:[]};
let trialProtocol = {active:false, queue:[], index:0, phase:'idle', phaseStarted:0,
  current:null, trialId:null, holdMs:2000, restMs:2000, trialNumber:0, accepted:0, excluded:0};
const gestureClasses = [
  {id:0, key:'rest', label:'Rest · relax your hand, fingers and arm.', detail:'Sit still. Let your fingers, wrist and arm rest without squeezing or lifting.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:1, key:'open_hand', label:'Open hand · straighten your fingers.', detail:'Keep your wrist still and spread or straighten all fingers comfortably. Hold the open pose.', sensor:'hand', labelSource:'camera_hand_flexion'},
  {id:2, key:'fist', label:'Close hand · make a comfortable fist.', detail:'Keep your wrist still and slowly curl all fingers into a comfortable fist. Do not squeeze as hard as possible.', sensor:'hand', labelSource:'camera_hand_flexion'},
  {id:3, key:'pinch', label:'Pinch · touch thumb to index finger.', detail:'Keep the other fingers relaxed. Bring the thumb and index fingertip together and hold.', sensor:'hand', labelSource:'camera_hand_flexion'},
  {id:4, key:'bicep_curl', label:'Bicep curl · bend your elbow.', detail:'Keep your upper arm near your side. Bend your elbow to bring your hand toward your shoulder, then hold.', sensor:'elbow', labelSource:'camera_elbow_angle'},
  {id:5, key:'elbow_extend', label:'Elbow extension · straighten your arm.', detail:'Keep your upper arm near your side. Slowly straighten your elbow without raising your shoulder, then hold.', sensor:'elbow', labelSource:'camera_elbow_angle'},
  {id:6, key:'arm_raise_forward', label:'Raise arm forward · lift to shoulder height.', detail:'With your elbow mostly straight, raise your arm in front of you to about shoulder height. Keep your torso still.', sensor:'shoulder', labelSource:'camera_upper_arm_angle'},
  {id:7, key:'arm_raise_side', label:'Raise arm sideways · lift to shoulder height.', detail:'With your elbow mostly straight, raise your arm out to the side to about shoulder height. Keep your torso still.', sensor:'shoulder', labelSource:'camera_upper_arm_angle'},
  {id:8, key:'forearm_supination', label:'Rotate forearm · turn palm up.', detail:'Keep your elbow tucked beside your body and rotate your forearm until your palm faces up. Keep the upper arm still.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:9, key:'forearm_pronation', label:'Rotate forearm · turn palm down.', detail:'Keep your elbow tucked beside your body and rotate your forearm until your palm faces down. Keep the upper arm still.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:10, key:'wrist_flexion', label:'Wrist flexion · bend palm inward.', detail:'Rest your forearm on a table if comfortable. Bend your wrist so your palm moves toward the underside of your forearm.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:11, key:'wrist_extension', label:'Wrist extension · bend hand back.', detail:'Keep your forearm still. Bend your wrist so the back of your hand moves toward the top of your forearm.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:12, key:'wrist_radial_deviation', label:'Wrist tilt · move toward thumb side.', detail:'Keep your palm facing down and forearm still. Move your hand sideways toward your thumb.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:13, key:'wrist_ulnar_deviation', label:'Wrist tilt · move toward little-finger side.', detail:'Keep your palm facing down and forearm still. Move your hand sideways toward your little finger.', sensor:'prompt_only', labelSource:'participant_prompt'},
  {id:14, key:'release_pinch', cameraKey:'open_hand', label:'Release pinch · open your fingers.', detail:'Start with thumb and index touching. Slowly separate them and relax your fingers into an open hand.', sensor:'hand', labelSource:'camera_hand_flexion'},
  {id:15, key:'arm_lower_forward', label:'Lower arm · return it from the forward raise.', detail:'From the forward-raised position, slowly lower your arm back to your side.', sensor:'shoulder', labelSource:'camera_upper_arm_angle'},
  {id:16, key:'arm_lower_side', label:'Lower arm · return it from the side raise.', detail:'From the side-raised position, slowly lower your arm back to your side.', sensor:'shoulder', labelSource:'camera_upper_arm_angle'},
];
const movementPairs = [
  {key:'hand_open_close', label:'Open hand ↔ close hand', gestures:['open_hand','fist']},
  {key:'pinch_release', label:'Pinch ↔ release pinch', gestures:['pinch','release_pinch']},
  {key:'elbow_curl_extend', label:'Bicep curl ↔ elbow extension', gestures:['bicep_curl','elbow_extend']},
  {key:'forward_raise_lower', label:'Raise arm forward ↔ lower arm', gestures:['arm_raise_forward','arm_lower_forward']},
  {key:'side_raise_lower', label:'Raise arm sideways ↔ lower arm', gestures:['arm_raise_side','arm_lower_side']},
  {key:'forearm_palm_up_down', label:'Rotate forearm palm up ↔ palm down', gestures:['forearm_supination','forearm_pronation']},
  {key:'wrist_flex_extend', label:'Wrist flexion ↔ wrist extension', gestures:['wrist_flexion','wrist_extension']},
  {key:'wrist_tilt', label:'Wrist tilt thumb side ↔ little-finger side', gestures:['wrist_radial_deviation','wrist_ulnar_deviation']},
].map(pair=>({...pair,gestures:pair.gestures.map(key=>gestureClasses.find(item=>item.key===key))}));
function selectedPair() { return movementPairs.find(item=>item.key===$('trial-pair').value) || movementPairs[0]; }
function gestureReadiness(gesture,now=performance.now()) {
  if(!cameraStream||!cameraReady)return 'Enable the camera before starting guided prompts.';
  if(!latestVision||now-latestVision.t_ms>=250)return 'Waiting for a fresh camera frame.';
  if(gesture.sensor==='hand'&&!calibratedFlexion(calibration.open,calibration))return 'Capture open-hand and fist calibration poses before training hand movements.';
  if(gesture.sensor==='elbow'&&(!latestVision.arm?.valid||!Number.isFinite(latestVision.arm.elbow_flexion_deg)))return 'Show your shoulder, elbow and wrist clearly so the camera can measure elbow motion.';
  if(gesture.sensor==='shoulder'&&(!latestVision.arm?.valid||!Number.isFinite(latestVision.arm.upper_arm_to_torso_deg)))return 'Show your shoulder, elbow and hip clearly so the camera can estimate arm raising.';
  return '';
}
function pairReadiness(pair=selectedPair(),now=performance.now()) {
  for(const gesture of pair.gestures){const message=gestureReadiness(gesture,now);if(message)return message;}
  return '';
}
let lastStatsAt = performance.now(), lastStatsSamples = 0, lastPredictAt = 0;
let lastPlotAt = -Infinity, lastScaleAt = -Infinity, scales = Array(8).fill(100);
let movementTracker=new MovementTracker(), lastMovementEvent='', lastCameraFeedKey='';

async function api(path, options={}) {
  const response = await fetch(path, {headers:{'Content-Type':'application/json'},...options});
  if (!response.ok) { let error; try { error = await response.json(); } catch { error = {}; } throw new Error(typeof error.detail === 'string' ? error.detail : `Recorder returned ${response.status}`); }
  return response.json();
}
function notice(message, error=false) { $('notice').textContent=message; $('notice').classList.toggle('error',error); }
function event(type, data={}) { if (recording) pending.events.push({t_ms:performance.now(),type,data}); }
function timedEvent(t_ms,type,data={}) { if(recording) pending.events.push({t_ms,type,data}); }
let startingRecording=false;
function labelPrompt(now) {
  if ($('source').value==='synthetic' || $('allow-unlabeled').checked) return '';
  if (!cameraStream) return 'Enable the camera to record finger labels.';
  if (!calibration.open) return 'Hold your hand open and click Capture open hand.';
  if (!calibration.closed) return 'Make a fist and click Capture closed hand.';
  if (!calibratedFlexion(calibration.open, calibration)) return 'Recapture the poses with more bend in each finger.';
  if (!latestVision || now-latestVision.t_ms>=250) return 'Waiting for a fresh camera frame.';
  return latestVision.valid ? '' : 'Tracking needs attention: '+latestVision.reason+'.';
}
function updateRecordingReadiness(now) {
  const prompt=labelPrompt(now);
  if (!sessionId) $('record').disabled=startingRecording || !running || !!prompt;
  const message=recording && prompt ? 'Finger labels interrupted. '+prompt : prompt;
  if ($('label-help').textContent!==message) $('label-help').textContent=message;
}
function cameraTarget() {
  return trialProtocol.active&&['prepare','active','review'].includes(trialProtocol.phase)
    ?trialProtocol.current?.gesture:null;
}
function cameraElapsedLabel(t) {
  const origin=recording?recordedAt:sourceStarted;
  const seconds=Math.max(0,Math.floor((t-(origin||t))/1000));
  return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
}
function updateCameraGestureFeed(frame,result) {
  const target=cameraTarget(),phase=trialProtocol.phase;
  const targetLabel=target?.label??'No active trial';
  let feedback='Preview only',kind='preview',classification=result.label,detail=result.detail??'',measurement=null;
  if(target&&phase==='prepare'){feedback='Get ready for prompt';kind='waiting';}
  else if(target?.sensor==='elbow'){
    measurement=frame.arm?.elbow_flexion_deg;
    const visible=Number.isFinite(measurement);
    classification=visible?`Elbow angle · ${Math.round(measurement)}°`:'Elbow not visible';
    detail='Camera records elbow angle; check that you performed the prompted direction.';
    feedback=visible?'Angle visible · follow the prompt':'Show shoulder, elbow and wrist';kind=visible?'uncertain':'mismatch';
  }else if(target?.sensor==='shoulder'){
    measurement=frame.arm?.upper_arm_to_torso_deg;
    const visible=Number.isFinite(measurement);
    classification=visible?`Upper arm angle · ${Math.round(measurement)}°`:'Upper arm not visible';
    detail='Camera estimates upper-arm angle; check that you performed the prompted direction.';
    feedback=visible?'Angle visible · follow the prompt':'Show shoulder, elbow and hip';kind=visible?'uncertain':'mismatch';
  }else if(target?.sensor==='prompt_only'){
    feedback='Camera does not measure this motion';kind='uncertain';
  }else if(target?.key==='rest'){
    feedback=result.key==='fist'||result.key==='pinch'?'Does not look like rest':'Camera cannot verify rest';kind='uncertain';
  }else if(target&&result.key==='unavailable'){feedback='Improve camera view';kind='uncertain';}
  else if(target&&result.key===(target.cameraKey??target.key)){feedback='Looks like the prompted pose';kind='match';}
  else if(target&&result.key==='partial'){feedback='No clear pose match yet';kind='uncertain';}
  else if(target){feedback='Does not match prompt';kind='mismatch';}
  $('camera-target').textContent=targetLabel;
  $('camera-classification').textContent=classification;
  $('camera-classification-detail').textContent=detail;
  $('camera-feedback').textContent=feedback;
  $('camera-feedback').dataset.state=kind;
  const cameraAvailable=target?.sensor==='elbow'||target?.sensor==='shoulder'?Number.isFinite(measurement):result.key!=='unavailable';
  $('camera-read-state').textContent=target?.sensor==='prompt_only'?'PROMPT ONLY':cameraAvailable?'LIVE':'CHECK VIEW';
  $('camera-read-state').classList.toggle('live',cameraAvailable);
  const signature=`${target?.key??'preview'}:${phase}:${classification}:${result.key}:${kind}`;
  if(signature===lastCameraFeedKey)return;
  lastCameraFeedKey=signature;
  const item=document.createElement('li');item.dataset.state=kind;
  item.textContent=`${cameraElapsedLabel(frame.t_ms)} · ${classification}${target?` · prompt: ${target.key}`:''} · ${feedback}`;
  $('camera-class-log').prepend(item);
  while($('camera-class-log').children.length>5)$('camera-class-log').lastElementChild.remove();
  timedEvent(frame.t_ms,'camera_gesture_estimate',{trial_id:trialProtocol.active?trialProtocol.trialId:null,
    target_class:target?.key??null,camera_class:result.key,feedback:kind,detail,measurement_name:target?.sensor??null,
    measurement_value:Number.isFinite(measurement)?measurement:null,pinch_ratio:result.pinch_ratio??null});
}
function updateControls() {
  settings.forEach(id=>$(id).disabled=running||!!sessionId);
  ['participant','split','delay','hand'].forEach(id=>$(id).disabled=!!sessionId);
  $('rate').disabled ||= $('source').value==='cyton';
  $('connect').textContent=running?'Disconnect source':$('source').value==='cyton'?'Connect Cyton':'Start synthetic stream';
  $('connect').disabled=!!sessionId;
  $('camera').disabled=!!sessionId||!visionReady;
  $('import-placement').disabled=!!sessionId||!storageReady;
  if(sessionId) $('open-cal').disabled=$('closed-cal').disabled=true;
  $('allow-unlabeled').disabled=!!sessionId || startingRecording;
  $('protocol-start').disabled=!recording||trialProtocol.active||!!pairReadiness();
  $('protocol-stop').hidden=!trialProtocol.active;
  $('trial-accept').hidden=trialProtocol.phase!=='review';
  $('trial-retry').hidden=trialProtocol.phase!=='review';
  const promptOnly=trialProtocol.current?.gesture.labelSource==='participant_prompt';
  $('trial-uncertain').hidden=trialProtocol.phase!=='review'||promptOnly;
  $('trial-accept').textContent=promptOnly?'Performed prompt · accept':'Prompt and visual check clear · accept';
  for(const input of [$('trial-pair'),$('trial-repetitions'),$('trial-hold'),$('trial-rest')]) input.disabled=trialProtocol.active;
  $('protocol-state').textContent=trialProtocol.active?trialProtocol.phase.toUpperCase():recording?'READY · RECORDING':'READY';
  $('record').disabled=!running&&!sessionId;
  updateRecordingReadiness(performance.now());
  $('record').innerHTML=sessionId?(recording?'■ Finish & save recording':'Retry save & finish'):'<span>●</span> Start recording';
  $('record').classList.toggle('recording-now',!!sessionId);
  $('state').textContent=recording?'Recording locally':running?'Live preview':'Ready to connect';
  $('source-pill').textContent=running?($('source').value==='synthetic'?'SYNTHETIC':'CYTON · 250 HZ'):'NO SOURCE';
  $('source-pill').classList.toggle('live',running);
}

async function configure() {
  if ($('source').value==='cyton') $('rate').value='250';
  profile=await api(`/api/filter?rate=${$('rate').value}&mains=${$('mains').value}`);
  processor=new SignalProcessor(profile); parser=new CytonParser(profile.sample_rate_hz);
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
    if(lastIndex!==null) packetGaps+=Math.max(0,sample.index-lastIndex-1);
    lastIndex=sample.index; lastSampleTime=sample.t_ms; sampleCount++;
    const point=processor.process(sample);
    if (sample.clipped && sample.counts) {
      const clipped = sample.counts.flatMap((count, i) =>
        Math.abs(count) >= 0.95 * 8388607 ? [`CH${i+1}`] : []);
      if (clipped.length) point.reason = 'ADC clipping · ' + clipped.join(', ');
    }
    plot.push(point);
    if(!point.valid||point.gap) {filteredWindow=[];prediction=null;}
    if(point.valid) filteredWindow.push(point.values);
    if(recording) pending.emg.push(sample);
  }
  const first=plot.findIndex(p=>p.t>=lastSampleTime-3000);
  if(first>0)plot.splice(0,first);
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
    $('arm-status').textContent='Synthetic demo has no measured arm pose.';
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

function reportMovement(t, labels) {
  const key=JSON.stringify(labels);
  if(recording && key!==lastMovementEvent) {
    pending.events.push({t_ms:t,type:'camera_movement',data:labels});
    lastMovementEvent=key;
  }
}
function acceptVision(frame) {
  latestVision=frame;frameCount++;if(frame.valid)validFrames++;
  if(recording) pending.vision.push(frame);
  if(cameraStream && $('source').value!=='synthetic') {
    updateCameraGestureFeed(frame,classifyHandGesture(frame));
    const labels=movementTracker.classify(frame);
    reportMovement(frame.t_ms,labels);
    $('hand-measure').textContent=frame.valid
      ? Math.round(100*frame.flexion.slice(1).reduce((sum,v)=>sum+v,0)/4)+'% bend (four fingers)'
      : frame.reason;
    for(const [part,label] of Object.entries(labels)) {
      const measured=part==='elbow'?frame.arm?.elbow_flexion_deg:frame.arm?.upper_arm_to_torso_deg;
      const waiting=part!=='hand' && frame.arm?.valid && Number.isFinite(measured);
      $(part+'-label').textContent=label ?? (waiting?'Measuring…':'Unavailable');
    }
  }
}
function handleVision(data) {
  frameBusy=false;
  if(data.type==='ready') {cameraReady=true;$('vision-status').textContent='Hand + arm trackers ready. Keep your shoulder, elbow, wrist and fingers in view.';updateControls();return;}
  if(data.type==='error') {notice(`Video tracker: ${data.message}`,true);cameraReady=false;updateControls();return;}
  if(data.type!=='result')return;
  const arm=armMeasurement(data.pose_landmarks,data.pose_world,$('hand').value);
  const matches=data.handedness.map((h,i)=>({h:h[0],i})).filter(({h})=>h.categoryName===$('hand').value);
  let reason='no selected hand', angles=null, landmarks=null, world=null, score=null;
  if(matches.length===1) {
    const {h,i}=matches[0];score=h.score;
    landmarks=data.landmarks[i].map(p=>[p.x,p.y,p.z]);world=data.world[i].map(p=>[p.x,p.y,p.z]);
    angles=fingerAngles(world);
    reason=!angles?'degenerate geometry':landmarks.some(p=>p[0]<.02||p[0]>.98||p[1]<.02||p[1]>.98)?'hand crosses frame edge':score<.6?'ambiguous handedness':'ok';
    if(reason==='ok'&&arm.valid) {
      const wrist=arm.landmarks[$('hand').value==='Left'?15:16];
      const aspect=$('video').videoWidth/($('video').videoHeight||480);
      if(Math.hypot((wrist[0]-landmarks[0][0])*aspect,wrist[1]-landmarks[0][1])>.18)reason='hand / arm wrist mismatch';
    }
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
  acceptVision({t_ms:data.t_ms,processed_ms:performance.now(),media_time_s:data.media_time_s,aspect_ratio:$('video').videoWidth/($('video').videoHeight||480),valid,reason,
    flexion,angles,landmarks,world_landmarks:world,handedness_score:score,arm});
  $('vision-pill').textContent=valid?'TRACKING':'CHECK LABEL';$('vision-pill').classList.toggle('live',valid);
  $('vision-status').textContent=valid?`Calibrated visual label · ${skippedFrames} frames skipped while tracker was busy`:`Label unavailable: ${reason}`;
  $('open-cal').disabled=!angles||!!sessionId;$('closed-cal').disabled=!angles||!!sessionId;
  $('arm-status').textContent=arm.valid?`${arm.side} shoulder → elbow → wrist tracked`:`Arm unavailable: ${arm.reason}`;
  $('elbow-angle').textContent=arm.valid?`${Math.round(arm.elbow_flexion_deg)}°`:'—';
  $('shoulder-angle').textContent=arm.upper_arm_to_torso_deg===null?'—':`${Math.round(arm.upper_arm_to_torso_deg)}°`;
  drawHand(landmarks,arm);
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
function resetCameraMotion() {
  movementTracker=new MovementTracker();
  for(const id of ['hand-measure','hand-label','elbow-label','upper_arm-label','elbow-angle','shoulder-angle']) $(id).textContent='—';
}
async function stopCamera() {
  resetCameraMotion();
  lastCameraFeedKey='';
  $('camera-read-state').textContent='WAITING';$('camera-read-state').classList.remove('live');
  $('camera-classification').textContent='Camera off';$('camera-classification-detail').textContent='Enable the camera to see pose estimates.';
  $('camera-feedback').textContent='Preview only';$('camera-feedback').dataset.state='preview';
  $('camera-target').textContent='No active trial';
  calibration={open:null,closed:null};
  angleHistory=[];previousAngles=null;
  if(frameHandle) $('video').cancelVideoFrameCallback?.(frameHandle);
  clearInterval(frameFallback);
  cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;
  worker?.terminate();worker=null;cameraReady=false;frameBusy=false;
  latestVision=null;drawHand(null);$('elbow-angle').textContent=$('shoulder-angle').textContent='—';
  $('arm-status').textContent='Camera off. Keep shoulder, elbow and wrist in view when enabled.';
  $('video').srcObject=null;$('camera-empty').hidden=false;$('camera').textContent='Enable camera';
  $('vision-pill').textContent='OFFLINE';
  updateControls();
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
    $('camera-class-log').replaceChildren();lastCameraFeedKey='';
    $('vision-status').textContent='Loading local hand and arm trackers…';
    worker=new Worker('/assets/vision-worker.js?v=4');
    worker.onmessage=({data})=>handleVision(data);
    worker.onerror=e=>{cameraReady=false;frameBusy=false;notice(`Tracker failed: ${e.message}. Run scripts/download_models.py.`,true);};
    worker.postMessage({type:'init'});
    if($('video').requestVideoFrameCallback)frameHandle=$('video').requestVideoFrameCallback(sendCameraFrame);
    else frameFallback=setInterval(()=>sendCameraFrame(performance.now()),34);
    event('camera_started');updateControls();
  }catch(e){await stopCamera();notice(`Camera: ${e.message}`,true);}
};
$('hand').onchange=()=>{resetCameraMotion();calibration={open:null,closed:null};angleHistory=[];previousAngles=null;latestVision=null;drawHand(null);$('elbow-angle').textContent=$('shoulder-angle').textContent='—';notice('Side selection changed. Capture both hand calibration poses again.');updateControls();};
for(const pose of ['open','closed']) $(pose+'-cal').onclick=()=>{
  const rows=angleHistory.filter(x=>performance.now()-x.t<1200);
  if(rows.length<10||rows.at(-1).t-rows[0].t<400){notice('Keep the full hand visible and hold the pose steady for one second.',true);return;}
  const center=median(rows.map(x=>x.values));
  if(rows.some(r=>r.values.some((v,i)=>Math.abs(v-center[i])>15))){notice('The pose moved during calibration. Hold it still and try again.',true);return;}
  calibration[pose]=center;latestVision=null;resetCameraMotion();$(pose+'-cal').textContent=pose==='open'?'Open pose captured ✓':'Closed pose captured ✓';
  if(calibration.open&&calibration.closed&&!calibratedFlexion(center,calibration))notice('Open-to-closed range is too small for one or more fingers. Re-capture both poses with all fingertips visible.',true);
  else notice(`${pose==='open'?'Open':'Closed'} pose captured. ${calibration.open&&calibration.closed?'Visual labels are calibrated.':'Capture the other pose next.'}`);
  updateControls();
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
  stopTrialProtocol('recording_finished');
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
    if (startingRecording) return;
    const prompt=labelPrompt(performance.now());
    if (prompt) {notice(prompt,true);return;}
    startingRecording=true;
    updateControls();
    const config={source:$('source').value,sample_rate_hz:profile.sample_rate_hz,participant:$('participant').value.trim(),
      split:$('split').value,wiring:$('wiring').value,mains_hz:Number($('mains').value),hand:$('hand').value,
      label_delay_ms:Number($('delay').value),client_time_origin_ms:performance.timeOrigin,notes:''};
    const result=await api('/api/sessions',{method:'POST',body:JSON.stringify(config)});
    lastMovementEvent='';
    sessionId=result.id;recording=true;recordedAt=performance.now();batchId=0;savedCounts=null;
    pending={emg:[],vision:[],events:[]};
    event('recording_started',{calibration,source_started_ms:sourceStarted,preprocessing_version:2,
      tracking_thresholds:{detection:.6,presence:.6,tracking_iou:.6,arm_visibility:.65},
      vision_models:['hand_landmarker/float16/1','pose_landmarker_lite/float16/1'],
      arm_definition:'elbow flexion: 0 straight; upper arm to torso: shoulder-to-elbow vs shoulder-to-hip; independent validity',
      label_definition:'mean joint bend normalized between open and closed poses'});
    $('record-title').textContent='Recording in progress.';
    if(!latestVision?.valid)notice('Recording raw EMG without valid visual labels. Finish this recording, then calibrate the camera before your next supervised session.');
    else notice('Recording raw EMG and visual labels locally. Finish recording before closing the tab.');
  }catch(e){notice(e.message,true);}finally{startingRecording=false;updateControls();}
};
window.addEventListener('beforeunload',e=>{if(sessionId){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>event('page_visibility',{state:document.visibilityState}));

function shuffledTrials(classes,repetitions) {
  const queue=[];
  for(const gesture of classes) for(let repetition=1;repetition<=repetitions;repetition++) queue.push({gesture,repetition});
  for(let i=queue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[queue[i],queue[j]]=[queue[j],queue[i]];}
  for(let i=1;i<queue.length;i++) if(queue[i].gesture.key===queue[i-1].gesture.key){
    const swap=queue.findIndex((row,j)=>j>i&&row.gesture.key!==queue[i-1].gesture.key&&row.gesture.key!==queue[i].gesture.key);
    if(swap>i)[queue[i],queue[swap]]=[queue[swap],queue[i]];
  }
  return queue;
}
function beginGestureTrial(now) {
  if(trialProtocol.index>=trialProtocol.queue.length){
    trialProtocol.active=false;trialProtocol.phase='complete';
    timedEvent(now,'gesture_protocol_completed',{trials:trialProtocol.queue.length,accepted:trialProtocol.accepted,excluded:trialProtocol.excluded});
    $('trial-instruction').textContent='Trial set complete';
    $('trial-count').textContent=`${trialProtocol.queue.length} trials · accepted ${trialProtocol.accepted} · excluded ${trialProtocol.excluded}`;
    $('trial-stage').textContent='Start another set or finish and save this recording.';
    $('protocol-help').textContent='Finished. The archive contains EMG, selected prompt labels, available camera measurements, and your per-trial quality decisions.';
    updateControls();return;
  }
  const item=trialProtocol.queue[trialProtocol.index];
  trialProtocol.current=item;trialProtocol.phase='prepare';trialProtocol.phaseStarted=now;
  trialProtocol.trialId=crypto.randomUUID();trialProtocol.trialNumber=trialProtocol.index+1;
  timedEvent(now,'gesture_trial_prompt',{trial_id:trialProtocol.trialId,class_id:item.gesture.id,class_name:item.gesture.key,
    pair_key:selectedPair().key,pair_label:selectedPair().label,
    repetition:item.repetition,trial_number:trialProtocol.trialNumber,total_trials:trialProtocol.queue.length,
    instruction:item.gesture.label,description:item.gesture.detail,label_source:item.gesture.labelSource,
    camera_measurement:item.gesture.sensor,split:$('split').value});
  $('trial-instruction').textContent=item.gesture.label;
  $('trial-stage').textContent=item.gesture.detail;
  $('trial-count').textContent=`Trial ${trialProtocol.trialNumber} of ${trialProtocol.queue.length} · rep ${item.repetition} · accepted ${trialProtocol.accepted} · excluded ${trialProtocol.excluded}`;
  updateControls();
}
function startGestureTrials() {
  if(!recording){notice('Start and save a recording before starting guided trials.',true);return;}
  const pair=selectedPair(),selected=pair.gestures,readiness=pairReadiness(pair);
  if(readiness){notice(readiness,true);return;}
  const repetitions=Math.max(2,Math.min(40,Number($('trial-repetitions').value)||12));
  $('trial-repetitions').value=repetitions;
  trialProtocol={active:true,queue:shuffledTrials(selected,repetitions),index:0,phase:'prepare',phaseStarted:performance.now(),
    current:null,trialId:null,holdMs:Math.max(1,Math.min(5,Number($('trial-hold').value)||2))*1000,
    restMs:Math.max(1,Math.min(6,Number($('trial-rest').value)||2))*1000,trialNumber:0,accepted:0,excluded:0};
  $('trial-hold').value=trialProtocol.holdMs/1000;$('trial-rest').value=trialProtocol.restMs/1000;
  timedEvent(performance.now(),'gesture_protocol_started',{pair_key:pair.key,pair_label:pair.label,
    classes:selected.map(g=>({id:g.id,name:g.key})),repetitions_per_class:repetitions,
    hold_ms:trialProtocol.holdMs,rest_ms:trialProtocol.restMs,order:trialProtocol.queue.map(x=>({class_name:x.gesture.key,repetition:x.repetition})),
    split:$('split').value,label_sources:Object.fromEntries(selected.map(g=>[g.key,g.labelSource])),
    camera_measurements:Object.fromEntries(selected.map(g=>[g.key,g.sensor])),
    labels_are_camera_checked:selected.every(g=>g.labelSource!=='participant_prompt')});
  $('protocol-help').textContent=selected.some(g=>g.labelSource==='participant_prompt')
    ?'These forearm/wrist trials are labeled from your prompt and confirmation; the camera does not measure that motion. Accept only if you performed the movement as instructed.'
    :'Both directions will be prompted with balanced repetitions. Keep the relevant body part visible and accept only trials performed correctly with a clear camera measurement.';
  beginGestureTrial(performance.now());updateControls();
}
function reviewGestureTrial(outcome) {
  if(!trialProtocol.active||trialProtocol.phase!=='review')return;
  const now=performance.now(),item=trialProtocol.current;
  const accepted=outcome==='accepted';
  timedEvent(now,'gesture_trial_review',{trial_id:trialProtocol.trialId,class_id:item.gesture.id,class_name:item.gesture.key,
    repetition:item.repetition,outcome,performed_as_prompted:outcome!=='incorrect',
    camera_clear:item.gesture.labelSource==='participant_prompt'?null:outcome==='accepted'?true:outcome==='camera_unclear'?false:null,
    label_source:item.gesture.labelSource,reviewer:'participant'});
  if(accepted)trialProtocol.accepted++;else trialProtocol.excluded++;
  $('trial-count').textContent=`Trial ${trialProtocol.trialNumber} of ${trialProtocol.queue.length} · rep ${item.repetition} · accepted ${trialProtocol.accepted} · excluded ${trialProtocol.excluded}`;
  $('trial-stage').textContent=accepted
    ?item.gesture.labelSource==='participant_prompt'?'Accepted · you confirmed the prompted movement':'Accepted · you checked the prompt and camera measurement'
    :outcome==='incorrect'?'Excluded · prompt not followed; raw signal remains saved':'Excluded · camera unclear; raw signal remains saved';
  trialProtocol.phase='rest';trialProtocol.phaseStarted=now;updateControls();
}
function stopTrialProtocol(reason='stopped_by_user') {
  if(!trialProtocol.active)return;
  const now=performance.now();
  if(trialProtocol.phase==='active'&&trialProtocol.current) timedEvent(now,'gesture_trial_end',{trial_id:trialProtocol.trialId,
    class_name:trialProtocol.current.gesture.key,early:true,reason});
  timedEvent(now,'gesture_protocol_stopped',{reason,completed_trials:trialProtocol.index,accepted:trialProtocol.accepted,excluded:trialProtocol.excluded});
  trialProtocol.active=false;trialProtocol.phase='stopped';$('trial-instruction').textContent='Trial set stopped';
  $('trial-stage').textContent='Finish and save the recording, or start a new trial set.';updateControls();
}
function updateGestureTrials(now) {
  if(!trialProtocol.active)return;
  if(!recording){stopTrialProtocol('recording_paused');return;}
  $('protocol-state').textContent=trialProtocol.phase.toUpperCase();
  const elapsed=now-trialProtocol.phaseStarted;
  const item=trialProtocol.current;
  if(trialProtocol.phase==='prepare'){
    $('trial-stage').textContent=`Get ready · ${item.gesture.detail}`;$('trial-progress-fill').style.width=`${Math.min(100,elapsed/10)}%`;
    if(elapsed>=1000){trialProtocol.phase='active';trialProtocol.phaseStarted=now;
      timedEvent(now,'gesture_trial_start',{trial_id:trialProtocol.trialId,class_id:item.gesture.id,class_name:item.gesture.key,
        repetition:item.repetition,hold_ms:trialProtocol.holdMs,source:'prompt'});}
  }else if(trialProtocol.phase==='active'){
    const fraction=Math.min(1,elapsed/trialProtocol.holdMs);
    $('trial-stage').textContent=`Do now · ${item.gesture.detail} · ${(Math.max(0,trialProtocol.holdMs-elapsed)/1000).toFixed(1)} sec`;
    $('trial-progress-fill').style.width=`${fraction*100}%`;
    if(fraction>=1){timedEvent(now,'gesture_trial_end',{trial_id:trialProtocol.trialId,class_name:item.gesture.key,early:false});
      trialProtocol.phase='review';trialProtocol.phaseStarted=now;$('trial-stage').textContent=item.gesture.labelSource==='participant_prompt'
        ?'Did you perform the movement as instructed?':'Did you perform it correctly, and was the camera measurement clear?';updateControls();}
  }else if(trialProtocol.phase==='review'){
    $('trial-progress-fill').style.width='100%';
  }else if(trialProtocol.phase==='rest'){
    $('trial-stage').textContent=`Rest · ${(Math.max(0,trialProtocol.restMs-elapsed)/1000).toFixed(1)} sec`;
    $('trial-progress-fill').style.width=`${Math.min(100,elapsed/trialProtocol.restMs*100)}%`;
    if(elapsed>=trialProtocol.restMs){trialProtocol.index++;beginGestureTrial(now);}
  }
}
$('protocol-start').onclick=startGestureTrials;
$('trial-pair').onchange=()=>{
  const pair=selectedPair(),first=pair.gestures[0],second=pair.gestures[1];
  const cameraNote=pair.gestures.some(g=>g.labelSource==='participant_prompt')
    ?'Camera cannot measure one or both directions; confirm those prompts yourself.'
    :'Camera measurements are saved separately for each direction.';
  $('trial-pair-cue').textContent=`The app will alternate these prompts, with equal repetitions: ${first.label} ${first.detail} Then ${second.label} ${second.detail} ${cameraNote}`;
  $('trial-instruction').textContent=pair.label;
  $('trial-stage').textContent=`${first.detail} Then ${second.detail}`;
  updateControls();
};
$('trial-pair').dispatchEvent(new Event('change'));
$('protocol-stop').onclick=()=>stopTrialProtocol();
$('trial-accept').onclick=()=>reviewGestureTrial('accepted');
$('trial-retry').onclick=()=>reviewGestureTrial('incorrect');
$('trial-uncertain').onclick=()=>reviewGestureTrial('camera_unclear');

async function refreshSessions(){
  const rows=await api('/api/sessions');$('session-list').replaceChildren();
  if(!rows.length){$('session-list').textContent='No recordings yet. Start with a short synthetic recording to check the workflow.';return;}
  for(const row of rows){
    const div=document.createElement('div');div.className='session-row';
    const identity=document.createElement('span');identity.textContent=row.config.participant;
    const placement=row.recording_kind==='placement';
    const small=document.createElement('small');small.textContent=placement?`Placement · ${row.placement?.movement??'trial'} · ${row.config.active_channels} active channels`:new Date(row.created_utc).toLocaleString();identity.append(small);div.append(identity);
    for(const text of [`${row.config.source==='synthetic'?'Synthetic':'Cyton'} · ${row.config.sample_rate_hz} Hz`,`${placement?'CUE LABELS':row.config.split.toUpperCase()} · ${row.status}`,`${row.counts.emg.toLocaleString()} samples`]){const el=document.createElement('span');el.textContent=text;if(text.startsWith('Synthetic'))el.className='synthetic';div.append(el);}
    const a=document.createElement('a');a.textContent=row.status==='recording'?'Recording…':'Download ZIP ↗';if(row.status!=='recording')a.href=`/api/sessions/${row.id}/export`;div.append(a);$('session-list').append(div);
  }
}
$('refresh').onclick=()=>refreshSessions().catch(e=>notice(e.message,true));
$('import-placement').onclick=()=>{if(!sessionId)$('placement-file').click();};
$('placement-file').onchange=async()=>{
  const file=$('placement-file').files[0];if(!file)return;
  $('import-placement').disabled=true;
  try{
    if(file.size>64*1024*1024)throw new Error('Placement export exceeds 64 MiB. Export a smaller comparison set.');
    $('import-status').textContent='Validating and saving placement trials locally…';
    const result=await api(`/api/import/placement?participant=${encodeURIComponent($('participant').value.trim())}`,{method:'POST',body:await file.text()});
    $('import-status').textContent=`Imported ${result.imported} trial(s); ${result.already_present} already present. Original blocks, mappings and cues preserved.`;
    await refreshSessions();
  }catch(e){$('import-status').textContent=`Import failed: ${e.message}`;}
  finally{$('placement-file').value='';$('import-placement').disabled=!!sessionId;}
};

FINGERS.forEach(name=>{const row=document.createElement('div');row.className='finger-row';row.innerHTML=`<span>${name}</span><div class="finger-track"><div class="measured"></div><div class="predicted"></div></div><output>—</output>`;$('finger-bars').append(row);});
for(const id of ['scale-mode','scale-range'])$(id).onchange=()=>{
  lastScaleAt=-Infinity;
  if(id==='scale-range') $('scale-mode').value='fixed';
};
function drawSignal(now){
  if(now-lastPlotAt<50)return;
  lastPlotAt=now;
  const canvas=$('signal'),dpr=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.font='10px Segoe UI';
  const chHeight=(h-35)/8,left=76,right=w-10,top=8;
  const mode=$('scale-mode').value;
  if(now-lastScaleAt>=1000){scales=channelScales(plot,mode,Number($('scale-range').value));lastScaleAt=now;}
  $('plot-scale-note').textContent=`3 seconds · ${mode==='channel'?'each channel auto-scales':mode==='fixed'?'fixed scale across channels':'shared auto scale'} · ticks in µV`;
  $('signal-quality').textContent=!running?'Source stopped':performance.now()-lastSampleTime>500?'Waiting for fresh samples':plot.at(-1)?.reason??'Waiting for samples';
  for(let tick=0;tick<=3;tick++) {
    const x=left+tick/3*(right-left);ctx.strokeStyle='#edf1ee';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-28);ctx.stroke();
    ctx.fillStyle='#72857b';ctx.textAlign=tick===3?'right':'left';ctx.fillText(`${tick-3} s`,x,h-8);
  }
  ctx.textAlign='left';ctx.fillStyle='#72857b';ctx.fillText('µV',40,10);
  for(let ch=0;ch<8;ch++){
    const center=top+(ch+.5)*chHeight,amplitude=chHeight*.34,scale=scales[ch];
    ctx.fillStyle='#466356';ctx.fillText(`CH${ch+1}`,0,center+3);
    for(const [value,y] of [[scale,center-amplitude],[0,center],[-scale,center+amplitude]]){
      ctx.textAlign='right';ctx.fillStyle='#72857b';ctx.fillText(value>0?`+${value}`:String(value),left-7,y+3);
      ctx.strokeStyle=value===0?'#d7e1da':'#f0f3f0';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
    }
    ctx.textAlign='left';
    ctx.save();ctx.beginPath();ctx.rect(left,center-amplitude,right-left,amplitude*2);ctx.clip();
    const bins=waveformBins(plot,ch,lastSampleTime-3000,3000,Math.max(1,Math.floor(right-left)));
    let previous;
    const y=v=>center-v/scale*amplitude;
    for(const bin of bins){
      const x=left+bin.x;ctx.strokeStyle=bin.valid?(ch%2?'#377c86':'#4b947d'):'#bd8b42';ctx.lineWidth=1;
      ctx.beginPath();
      if(bin.join&&previous){ctx.moveTo(left+previous.x,y(previous.last));ctx.lineTo(x,y(bin.first));}
      ctx.moveTo(x,y(bin.min));ctx.lineTo(x,y(bin.max));ctx.stroke();previous=bin;
    }
    ctx.restore();
    if(bins.some(bin=>Math.max(Math.abs(bin.min),Math.abs(bin.max))>scale)){
      ctx.fillStyle='#b15a32';ctx.textAlign='right';ctx.fillText('↕ off scale',right,center-amplitude-3);ctx.textAlign='left';
    }
  }
}
function drawHand(points,arm=null){
  const canvas=$('overlay'),video=$('video'),ctx=canvas.getContext('2d');canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||480;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(arm?.valid){
    const ids=arm.side==='Left'?[11,13,15]:[12,14,16];
    ctx.strokeStyle='#ffcb79';ctx.fillStyle='#ffcb79';ctx.lineWidth=4;ctx.beginPath();
    ids.forEach((id,i)=>{const p=arm.landmarks[id];ctx[i?'lineTo':'moveTo'](p[0]*canvas.width,p[1]*canvas.height);});ctx.stroke();
    ids.forEach((id,i)=>{const p=arm.landmarks[id],x=p[0]*canvas.width,y=p[1]*canvas.height;ctx.beginPath();ctx.arc(x,y,6,0,2*Math.PI);ctx.fill();ctx.font='14px Segoe UI';ctx.fillText(['Shoulder','Elbow','Wrist'][i],x+9,y-9);});
  }
  if(!points)return;
  const chains=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  ctx.strokeStyle='#73dbb5';ctx.lineWidth=3;
  for(const chain of chains){ctx.beginPath();chain.forEach((id,j)=>{const p=points[id];ctx[j?'lineTo':'moveTo'](p[0]*canvas.width,p[1]*canvas.height);});ctx.stroke();}
  ctx.fillStyle='#eafef5';points.forEach(p=>{ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,3,0,Math.PI*2);ctx.fill();});
}
async function updatePrediction(now){
  if(!$('predict').checked||predictionBusy||!running||now-lastSampleTime>250||now-lastPredictAt<100||filteredWindow.length!==profile.sample_rate_hz*.2)return;
  lastPredictAt=now;predictionBusy=true;
  const segment=processor.segment, predictionProcessor=processor;
  try{const result=await api('/api/predict',{method:'POST',body:JSON.stringify({sample_rate_hz:profile.sample_rate_hz,mains_hz:profile.mains_hz,wiring:$('wiring').value,filtered_uv:filteredWindow})});
    if(!running||processor!==predictionProcessor||processor.segment!==segment||performance.now()-lastSampleTime>250)return;
    prediction=result;
    $('model-status').textContent=`${prediction.training_source==='synthetic'?'Synthetic-trained demo · not validated on people':'Local CNN'} · predicts visual flexion ${prediction.label_delay_ms>=0?'+':''}${prediction.label_delay_ms} ms from window end`;
  }catch(e){$('predict').checked=false;$('model-status').textContent=e.message;prediction=null;}
  finally{predictionBusy=false;}
}
function draw(now){
  updateRecordingReadiness(now);
  const calibrated=calibratedFlexion(calibration.open,calibration);
  const steps=calibrated?2:Number(!!(calibration.open||calibration.closed));
  $('cal-progress').value=steps;
  const instruction=!cameraStream?'Enable camera to begin.':calibrated?'Ready · move your fingers to check the live percentages.':
    !calibration.open?'Hold hand open for one second, then capture.':!calibration.closed?'Hold a fist for one second, then capture.':
    'Finger range too small. Recapture open hand and fist.';
  const status=`${steps}/2 poses · ${instruction}`;
  if($('cal-progress-text').textContent!==status) $('cal-progress-text').textContent=status;
  drawSignal(now);
  if(latestVision&&now-latestVision.t_ms>=500&&cameraStream){
    updateCameraGestureFeed({t_ms:now},{key:'unavailable',label:'No fresh camera frame',detail:'Check camera tracking'});
    resetCameraMotion();reportMovement(now,{hand:null,elbow:null,upper_arm:null});
    drawHand(null);$('elbow-angle').textContent=$('shoulder-angle').textContent='—';
    $('arm-status').textContent='Waiting for a fresh arm measurement…';
  }
  const fresh=latestVision&&now-latestVision.t_ms<250&&latestVision.valid;
  [...$('finger-bars').children].forEach((row,i)=>{const value=fresh?latestVision.flexion[i]:null;row.querySelector('.measured').style.width=`${(value??0)*100}%`;row.querySelector('.predicted').style.width=`${$('predict').checked&&prediction&&running&&now-lastSampleTime<250?prediction.flexion[i]*100:0}%`;row.querySelector('output').textContent=value===null?'—':`${Math.round(value*100)}%`;});
  if(now-lastStatsAt>=1000){$('pps').textContent=running?Math.round((sampleCount-lastStatsSamples)*1000/(now-lastStatsAt)):'—';lastStatsAt=now;lastStatsSamples=sampleCount;$('gaps').textContent=packetGaps;$('coverage').textContent=frameCount?`${Math.round(validFrames/frameCount*100)}%`:'—';}
  if(recording){const elapsed=Math.floor((now-recordedAt)/1000);$('elapsed').textContent=`${Math.floor(elapsed/60).toString().padStart(2,'0')}:${(elapsed%60).toString().padStart(2,'0')}`;}
  updateGestureTrials(now);
  updatePrediction(now);requestAnimationFrame(draw);
}
try{
  const health=await api('/api/health');$('server').textContent='Recorder online · files stay on this computer';
  $('storage-path').textContent=health.data_directory;
  storageReady=health.storage_api_version===1;
  visionReady=health.vision_schema_version===2&&health.pose_model_ready&&health.camera_model_ready&&health.mediapipe_ready;
  if(!storageReady){
    $('backup-all').removeAttribute('href');$('backup-all').setAttribute('aria-disabled','true');
    $('import-status').textContent='Restart the local recorder to enable verified archives and placement imports. Older single-session ZIP downloads do not include checksum manifests.';
  }
  if(!visionReady)notice('Hand + arm tracking needs the updated recorder and both models. Run .venv\\Scripts\\python scripts/download_models.py, then restart scripts/start-lab.ps1.',true);
  const model=await api('/api/model');$('model-status').textContent=model.available?'Local model found. Enable comparison after connecting a source.':'No trained model yet. Record sessions, build a dataset, then run emg-train.';
  $('predict').disabled=!model.available;
  await configure();await refreshSessions();requestAnimationFrame(draw);
}catch(e){$('server').textContent='Recorder unavailable';notice(e.message,true);}
