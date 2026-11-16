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
