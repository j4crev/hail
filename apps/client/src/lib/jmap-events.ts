export const EVENT_CAPABILITY='https://haili.app/ns/jmap/events';
// Notifications are hints only: never replace /changes cursors or modify mail.
export class MailboxEvents {
  private source:EventSource|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private enabled=false;
  private failures=0;
  constructor(private changed:()=>void,private create:(url:string)=>EventSource=url=>new EventSource(url)){}
  start(){if(this.enabled)return;this.enabled=true;this.connect();}
  stop(){this.enabled=false;clearTimeout(this.timer);this.timer=undefined;this.source?.close();this.source=null;this.failures=0;}
  private connect(){
    if(!this.enabled)return;
    try{
      const source=this.create('/api/jmap/events?types=*&closeafter=no&ping=30');this.source=source;
      source.onopen=()=>{if(this.source===source)this.changed();};
      source.addEventListener('ping',()=>{if(this.source===source)this.failures=0;});
      source.addEventListener('state',event=>{
        if(this.source!==source)return;
        const text=(event as MessageEvent).data;if(typeof text!=='string'||text.length>8192)return;
        try{const value=JSON.parse(text);if(value?.['@type']==='StateChange'&&value.changed&&typeof value.changed==='object'&&!Array.isArray(value.changed))this.changed();}catch{/* Malformed hints never affect cursors. */}
      });
      source.onerror=()=>{if(this.source!==source)return;source.close();this.source=null;this.retry();};
    }catch{this.retry();}
  }
  private retry(){if(this.enabled)this.timer=setTimeout(()=>{this.timer=undefined;this.connect();},Math.min(60_000,1000*2**Math.min(this.failures++,6))+Math.random()*1000);}
}
