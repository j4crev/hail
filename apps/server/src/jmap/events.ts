import {createHash} from 'node:crypto';

export const HAIL_EVENTS='https://haili.app/ns/jmap/events';
export const EVENT_TYPES=['HailMessage','HailDraft','HailSent','HailSubmission','HailGrant','HailRelationship'] as const;
export interface EventSnapshot {accountId:string; states:Record<string,string>}
export interface EventOptions {types:string[]; closeAfterState:boolean; pingSeconds:number}
export function eventOptions(url:URL):EventOptions|null {
  const q=url.searchParams;
  if([...q.keys()].some(k=>!['types','closeafter','ping'].includes(k)||q.getAll(k).length!==1))return null;
  const types=q.get('types'),close=q.get('closeafter'),ping=q.get('ping');
  if(!types||types.length>256||!['state','no'].includes(close??'')||!/^\d{1,6}$/.test(ping??''))return null;
  const selected=types==='*'?[...EVENT_TYPES]:types.split(',');
  if(selected.some(t=>!(EVENT_TYPES as readonly string[]).includes(t))||new Set(selected).size!==selected.length)return null;
  return {types:selected,closeAfterState:close==='state',pingSeconds:Number(ping)===0?0:Math.max(30,Math.min(300,Number(ping)))};
}

// One bounded frame at a time. Durable /changes state is the recovery mechanism,
// so no in-memory event history, content, or credential-bearing event IDs exist.
export function stateStream(read:()=>Promise<EventSnapshot|null>,options:EventOptions,signal:AbortSignal,
  lastId:string|null,release:()=>void,timing={pollMs:2000,lifetimeMs:300_000}):Response {
  const encoder=new TextEncoder();let stopped=false,controller:ReadableStreamDefaultController<Uint8Array>;
  let wake:()=>void=()=>{},lastEvent=Date.now(),previous=lastId;
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(deadline);signal.removeEventListener('abort',stop);wake();release();try{controller.close();}catch{/* The consumer may already have cancelled. */}};
  const deadline=setTimeout(()=>stop(),timing.lifetimeMs);
  const body=new ReadableStream<Uint8Array>({
    start(c){controller=c;signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();},
    async pull(c){
      try{
        while(!stopped){
          const snapshot=await read();if(stopped)return;if(!snapshot){stop();return;}
          const states=Object.fromEntries(options.types.filter(t=>snapshot.states[t]!==undefined).map(t=>[t,snapshot.states[t]]));
          const data={'@type':'StateChange',changed:{[snapshot.accountId]:states}};
          const id=createHash('sha256').update(JSON.stringify(data)).digest('base64url');
          if(id!==previous&&Object.keys(states).length){
            previous=id;lastEvent=Date.now();c.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`));
            if(options.closeAfterState)stop();return;
          }
          if(options.pingSeconds&&Date.now()-lastEvent>=options.pingSeconds*1000){
            lastEvent=Date.now();c.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({interval:options.pingSeconds})}\n\n`));return;
          }
          await new Promise<void>(resolve=>{const timer=setTimeout(done,timing.pollMs);function done(){clearTimeout(timer);wake=()=>{};resolve();}wake=done;});
        }
      }catch{stop();}
    },
    cancel(){stop();}
  },{highWaterMark:0});
  return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff','Vary':'Authorization, Cookie'}});
}
