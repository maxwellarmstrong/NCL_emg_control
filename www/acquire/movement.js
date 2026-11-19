// Compare a short history of valid camera observations independently for each joint.
class MotionHistory {
  constructor() { this.rows=[]; }
  change(t,value) {
    if (value===null) { this.rows=[]; return null; }
    const last=this.rows.at(-1);
    if(last && (t<=last.t || t-last.t>180)) this.rows=[];
    this.rows=this.rows.filter(row=>t-row.t<=350);
    this.rows.push({t,value});
    const first=this.rows[0];
    return t-first.t>=180 ? value.map((v,i)=>v-first.value[i]) : null;
  }
}

// A simple, transparent pose heuristic for the pilot feed. It is feedback for
// the collector, not a trained model or a ground-truth label.
export function classifyHandGesture(frame) {
  if(!frame?.valid||!Array.isArray(frame.flexion)||!Array.isArray(frame.landmarks))
    return {key:'unavailable',label:'No clear hand reading',detail:frame?.reason??'Waiting for camera'};
  const points=frame.landmarks;
  if(points.length<21||!points[4]||!points[5]||!points[8]||!points[17])
    return {key:'unavailable',label:'No clear hand reading',detail:'Hand landmarks incomplete'};
  const aspect=Number.isFinite(frame.aspect_ratio)&&frame.aspect_ratio>0?frame.aspect_ratio:1;
  const distance=(a,b)=>Math.hypot((a[0]-b[0])*aspect,a[1]-b[1]);
  const palmWidth=distance(points[5],points[17]);
  const pinchRatio=palmWidth>1e-4?distance(points[4],points[8])/palmWidth:null;
  if(pinchRatio!==null&&pinchRatio<.34)
    return {key:'pinch',label:'Thumb–index pinch-like',detail:`tip gap ${pinchRatio.toFixed(2)} × palm width`,pinch_ratio:pinchRatio};
  const fingers=frame.flexion.slice(1);
  if(fingers.length===4&&fingers.every(value=>value>=.7))
    return {key:'fist',label:'Closed fist-like',detail:`four-finger bend ${Math.round(fingers.reduce((a,b)=>a+b,0)/4*100)}%`,pinch_ratio:pinchRatio};
  if(fingers.length===4&&fingers.every(value=>value<=.2))
    return {key:'open_hand',label:'Open hand-like',detail:`four-finger bend ${Math.round(fingers.reduce((a,b)=>a+b,0)/4*100)}%`,pinch_ratio:pinchRatio};
  return {key:'partial',label:'Other / changing pose',detail:pinchRatio===null?'Pinch gap unavailable':`four-finger bend ${Math.round(fingers.reduce((a,b)=>a+b,0)/4*100)}% · pinch gap ${pinchRatio.toFixed(2)}`,pinch_ratio:pinchRatio};
}

export class MovementTracker {
  constructor() {
    this.hand=new MotionHistory(); this.elbow=new MotionHistory(); this.shoulder=new MotionHistory();
  }
  classify(frame) {
    const t=frame.t_ms, fingers=frame.valid ? frame.flexion : null;
    const change=this.hand.change(t,fingers);
    let hand=null;
    if(fingers) {
      const four=fingers.slice(1); // Thumb opposition varies with the type of fist.
      if(change?.slice(1).filter(v=>v>=0.12).length>=3) hand='closing';
      else if(change?.slice(1).filter(v=>v<=-0.12).length>=3) hand='opening';
      else if(four.every(v=>v<=0.2)) hand='open';
      else if(four.every(v=>v>=0.7)) hand='closed';
      else hand='partial';
    }
    const arm=frame.arm?.valid ? frame.arm : null;
    function direction(history,angle,positive,negative) {
      const delta=history.change(t,Number.isFinite(angle)?[angle]:null);
      if(!delta) return null;
      return delta[0]>=8 ? positive : delta[0]<=-8 ? negative : 'steady';
    }
    return {hand,elbow:direction(this.elbow,arm?.elbow_flexion_deg,'curling','extending'),
      upper_arm:direction(this.shoulder,arm?.upper_arm_to_torso_deg,'raising','lowering')};
  }
}
