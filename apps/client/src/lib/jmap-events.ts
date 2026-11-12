export const EVENT_CAPABILITY='https://racrproto.com/ns/jmap/events';
type Coordination={locks:Pick<LockManager,'request'>|null;channel:(()=>BroadcastChannel)|null};
type Message={type:'hint'}|{type:'state';open:boolean}|{type:'query'};
const LOCK='hail-mailbox-events';
const browserCoordination=():Coordination=>({
  locks:typeof navigator!=='undefined'&&navigator.locks?navigator.locks:null,
  channel:typeof BroadcastChannel==='undefined'?null:()=>new BroadcastChannel(LOCK),
});
/**
 * Notifications are hints only: never replace /changes cursors or modify mail.
 *
 * One stream per browser: the tabs that want events elect a leader with a Web
 * Lock; only the leader opens the stream, and it relays each hint (and whether its
 * stream is open) to the other tabs over a BroadcastChannel. When the leader stops
 * (hidden, closed or crashed) its lock is released and a waiting tab takes over.
 * Without Web Locks or BroadcastChannel each tab opens its own stream.
 */
export class MailboxEvents {
  private source:EventSource|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private enabled=false;
  private failures=0;
  private open=false;
  private leader=false;
  private leaderOpen=false;
  private channel:BroadcastChannel|null=null;
  private election:AbortController|null=null;
  private release:(()=>void)|null=null;
  /** Whether a stream (this tab's or the leader's) is open now, so change hints will arrive without polling. */
  get connected(){return this.enabled&&(this.leader||!this.channel?this.open:this.leaderOpen);}
  constructor(private changed:()=>void,private create:(url:string)=>EventSource=url=>new EventSource(url),private coordination:Coordination=browserCoordination()){}
  start(){
    if(this.enabled)return;this.enabled=true;
    const {locks,channel}=this.coordination;
    if(!locks||!channel){this.leader=true;this.connect();return;}
    this.channel=channel();
    this.channel.onmessage=event=>this.receive(event.data as Message);
    this.post({type:'query'});
    const election=new AbortController();this.election=election;
    locks.request(LOCK,{signal:election.signal},()=>{
      if(!this.enabled||this.election!==election)return;
      this.leader=true;this.connect();
      return new Promise<void>(resolve=>{this.release=resolve;});
    }).catch(()=>{/* Abandoned when this tab stops before it leads. */});
  }
  stop(){
    const wasLeader=this.leader;
    this.enabled=false;clearTimeout(this.timer);this.timer=undefined;this.source?.close();this.source=null;this.failures=0;
    this.open=false;this.leader=false;this.leaderOpen=false;
    if(wasLeader)this.post({type:'state',open:false});
    this.election?.abort();this.election=null;this.release?.();this.release=null;
    if(this.channel){this.channel.onmessage=null;this.channel.close();this.channel=null;}
  }
  private post(message:Message){try{this.channel?.postMessage(message);}catch{/* Closing channel. */}}
  private receive(message:Message){
    if(!this.enabled||!message||typeof message!=='object')return;
    if(this.leader){if(message.type==='query')this.post({type:'state',open:this.open});return;}
    if(message.type==='hint')this.changed();
    else if(message.type==='state'&&typeof message.open==='boolean')this.leaderOpen=message.open;
  }
  /** A hint for this tab and, as leader, for every other tab. */
  private hint(){this.post({type:'hint'});this.changed();}
  private setOpen(open:boolean){if(this.open===open)return;this.open=open;this.post({type:'state',open});}
  private connect(){
    if(!this.enabled)return;
    try{
      const source=this.create('/api/jmap/events?types=*&closeafter=no&ping=30');this.source=source;
      source.onopen=()=>{if(this.source===source){this.setOpen(true);this.hint();}};
      source.addEventListener('ping',()=>{if(this.source===source)this.failures=0;});
      source.addEventListener('state',event=>{
        if(this.source!==source)return;
        const text=(event as MessageEvent).data;if(typeof text!=='string'||text.length>8192)return;
        try{const value=JSON.parse(text);if(value?.['@type']==='StateChange'&&value.changed&&typeof value.changed==='object'&&!Array.isArray(value.changed))this.hint();}catch{/* Malformed hints never affect cursors. */}
      });
      source.onerror=()=>{if(this.source!==source)return;this.setOpen(false);source.close();this.source=null;this.retry();};
    }catch{this.retry();}
  }
  private retry(){if(this.enabled)this.timer=setTimeout(()=>{this.timer=undefined;this.connect();},Math.min(60_000,1000*2**Math.min(this.failures++,6))+Math.random()*1000);}
}
