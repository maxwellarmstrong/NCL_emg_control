import {protocol} from './isolation-core.mjs';
export const STANDARD_MOVES=Object.freeze(['rest','pronation','supination','triceps','biceps','wrist-extension','wrist-flexion']);
export const TRANSITION_SECONDS=10;
export const MOVEMENT_SECONDS=protocol().reduce((n,s)=>n+s.seconds,0);
export const STANDARD_SECONDS=STANDARD_MOVES.length*MOVEMENT_SECONDS+(STANDARD_MOVES.length-1)*TRANSITION_SECONDS;
// Advance only after a complete recording has been saved. Cancellation is terminal.
export class GuidedSequence {
 constructor(id){this.id=id;this.index=0;this.state='recording';this.readyAt=null;this.recordIds=[];}
 get movement(){return STANDARD_MOVES[this.index];}
 saved(id,now){
  if(this.state!=='recording')throw Error('Sequence is not recording');
  this.recordIds.push(id);
  if(this.index===STANDARD_MOVES.length-1){this.state='complete';return;}
  this.index++;this.state='transition';this.readyAt=now+TRANSITION_SECONDS*1000;
 }
 begin(now,healthy){if(this.state!=='transition'||now<this.readyAt||!healthy)return false;this.state='recording';return true;}
 cancel(){if(this.state!=='complete')this.state='stopped';}
 metadata(){return {id:this.id,index:this.index,order:[...STANDARD_MOVES],nominalSeconds:STANDARD_SECONDS};}
}
