import {randomUUID} from 'node:crypto';

/** Channel the JMAP state triggers notify (payload: the account ID). */
export const STATE_CHANNEL='hail_jmap_state';
type Listen=(channel:string,onNotify:(payload:string)=>void,onListen:()=>void)=>Promise<{unlisten():Promise<void>}>;
type Notify=(channel:string,payload:string)=>Promise<unknown>;

/**
 * Wakes connected event streams when an account's JMAP state changes, from one
 * PostgreSQL LISTEN per process (database triggers NOTIFY on commit, from any
 * process writing). Notifications can be lost while the listening connection is
 * down, so this is a hint: streams still poll, slowly while `healthy` and quickly
 * otherwise. Health is a self-test: a probe this process sends must come back.
 */
export class StateNotifications {
  private readonly watchers=new Map<string,Set<()=>void>>();
  private alive=false;
  private probe:string|null=null;
  private timers:ReturnType<typeof setTimeout>[]=[];
  private subscription:{unlisten():Promise<void>}|null=null;
  constructor(private readonly listen:Listen,private readonly notify:Notify,private readonly checkMs=30_000,private readonly probeMs=5_000){}
  get healthy(){return this.alive;}
  /** Calls wake on each state change of this account; returns the unwatch function. */
  watch(accountId:string,wake:()=>void):()=>void {
    const set=this.watchers.get(accountId)??new Set();set.add(wake);this.watchers.set(accountId,set);
    return ()=>{set.delete(wake);if(!set.size&&this.watchers.get(accountId)===set)this.watchers.delete(accountId);};
  }
  async start(){
    const interval=setInterval(()=>{void this.check();},this.checkMs);(interval as {unref?():void}).unref?.();this.timers.push(interval);
    try{
      // onListen also runs after every reconnect: changes may have been missed meanwhile.
      this.subscription=await this.listen(STATE_CHANNEL,payload=>this.receive(payload),()=>{void this.check();this.wakeAll();});
    }catch{this.setAlive(false);}
  }
  async stop(){for(const timer of this.timers)clearTimeout(timer);this.timers=[];await this.subscription?.unlisten().catch(()=>{});this.subscription=null;this.setAlive(false);}
  private receive(payload:string){
    if(payload===this.probe){this.probe=null;this.setAlive(true);return;}
    for(const wake of [...this.watchers.get(payload)??[]])wake();
  }
  private async check(){
    const probe=`probe:${randomUUID()}`;this.probe=probe;
    try{await this.notify(STATE_CHANNEL,probe);}catch{if(this.probe===probe){this.probe=null;this.setAlive(false);}return;}
    const timer=setTimeout(()=>{if(this.probe===probe){this.probe=null;this.setAlive(false);}},this.probeMs);
    (timer as {unref?():void}).unref?.();
  }
  private setAlive(alive:boolean){
    if(this.alive===alive)return;this.alive=alive;
    // Streams sleeping for the slow interval must switch to quick polling now.
    if(!alive)this.wakeAll();
  }
  private wakeAll(){for(const set of this.watchers.values())for(const wake of [...set])wake();}
}
