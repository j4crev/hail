import {afterEach,expect,it,vi} from 'vitest';
import {MailboxEvents} from './jmap-events.js';
afterEach(()=>vi.useRealTimers());
/** No Web Locks/BroadcastChannel: each tab holds its own stream. */
const solo={locks:null,channel:null};
it('uses only the same-origin bridge and treats reconnects and duplicate states as sync hints',()=>{
  const changed=vi.fn(),listeners=new Map<string,(event:unknown)=>void>();
  const source={close:vi.fn(),onopen:null as null|(()=>void),onerror:null as null|(()=>void),addEventListener:(name:string,callback:(event:unknown)=>void)=>listeners.set(name,callback)};
  const create=vi.fn(()=>source as unknown as EventSource),events=new MailboxEvents(changed,create,solo);
  events.start();events.start();expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0]).toEqual(['/api/jmap/events?types=*&closeafter=no&ping=30']);
  expect(events.connected).toBe(false);source.onopen!();expect(changed).toHaveBeenCalledTimes(1);expect(events.connected).toBe(true);
  for(let i=0;i<2;i++)listeners.get('state')!({data:JSON.stringify({'@type':'StateChange',changed:{account:{HailMessage:'state'}}})});
  expect(changed).toHaveBeenCalledTimes(3);
  for(const data of ['bad',JSON.stringify({changed:{}}),'x'.repeat(8193)])listeners.get('state')!({data});
  expect(changed).toHaveBeenCalledTimes(3);events.stop();listeners.get('state')!({data:JSON.stringify({'@type':'StateChange',changed:{}})});
  expect(changed).toHaveBeenCalledTimes(3);expect(source.close).toHaveBeenCalledTimes(1);expect(events.connected).toBe(false);
});
it('reports a dropped stream as disconnected so polling resumes',()=>{
  const source={close:vi.fn(),onopen:null as null|(()=>void),onerror:null as null|(()=>void),addEventListener:()=>{}};
  const events=new MailboxEvents(()=>{},()=>source as unknown as EventSource,solo);
  events.start();source.onopen!();expect(events.connected).toBe(true);
  source.onerror!();expect(events.connected).toBe(false);events.stop();
});
it('backs off failures, cancels retries on stop and can start again',async()=>{
  vi.useFakeTimers();const sources:Array<{close:ReturnType<typeof vi.fn>;onerror:()=>void}>=[];
  const create=vi.fn(()=>{const source={close:vi.fn(),onerror:()=>{},addEventListener:()=>{}};sources.push(source);return source as unknown as EventSource;});
  const events=new MailboxEvents(()=>{},create,solo);events.start();sources[0]!.onerror();expect(sources[0]!.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999);expect(create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001);expect(create).toHaveBeenCalledTimes(2);
  sources[1]!.onerror();events.stop();await vi.advanceTimersByTimeAsync(120000);expect(create).toHaveBeenCalledTimes(2);
  events.start();expect(create).toHaveBeenCalledTimes(3);events.stop();
});

/** In-memory Web Locks and BroadcastChannel shared by several simulated tabs. */
function browser(){
  const held=new Set<string>(),waiting:Array<{name:string;signal?:AbortSignal;grant:()=>void}>=[];
  const pump=()=>{for(const entry of [...waiting])if(!held.has(entry.name)){waiting.splice(waiting.indexOf(entry),1);entry.grant();}};
  const locks={request:(name:string,options:{signal?:AbortSignal},callback:()=>unknown)=>new Promise((resolve,reject)=>{
    const entry={name,signal:options.signal,grant:()=>{held.add(name);Promise.resolve(callback()).then(resolve,reject).finally(()=>{held.delete(name);pump();});}};
    options.signal?.addEventListener('abort',()=>{const index=waiting.indexOf(entry);if(index>=0){waiting.splice(index,1);reject(new DOMException('Aborted','AbortError'));}});
    waiting.push(entry);pump();
  })} as unknown as LockManager;
  const channels=new Set<{onmessage:((event:{data:unknown})=>void)|null}>();
  const channel=()=>{const self={onmessage:null as ((event:{data:unknown})=>void)|null,
    postMessage:(data:unknown)=>{for(const other of channels)if(other!==self)queueMicrotask(()=>other.onmessage?.({data:structuredClone(data)}));},
    close:()=>{channels.delete(self);}};channels.add(self);return self as unknown as BroadcastChannel;};
  return {locks,channel};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
function tab(shared:ReturnType<typeof browser>){
  const changed=vi.fn(),sources:Array<{close:ReturnType<typeof vi.fn>;onopen:null|(()=>void);onerror:null|(()=>void);listeners:Map<string,(event:unknown)=>void>}>=[];
  const create=vi.fn(()=>{const listeners=new Map<string,(event:unknown)=>void>();const source={close:vi.fn(),onopen:null,onerror:null,listeners,addEventListener:(name:string,callback:(event:unknown)=>void)=>listeners.set(name,callback)};sources.push(source);return source as unknown as EventSource;});
  return {changed,create,sources,events:new MailboxEvents(changed,create,shared)};
}
it('opens one stream per browser and relays its hints and state to the other tabs',async()=>{
  const shared=browser(),a=tab(shared),b=tab(shared);
  a.events.start();await settle();b.events.start();await settle();
  expect(a.create).toHaveBeenCalledTimes(1);expect(b.create).not.toHaveBeenCalled();
  a.sources[0]!.onopen!();await settle();
  expect(a.events.connected).toBe(true);expect(b.events.connected).toBe(true);
  expect(a.changed).toHaveBeenCalledTimes(1);expect(b.changed).toHaveBeenCalledTimes(1);
  a.sources[0]!.listeners.get('state')!({data:JSON.stringify({'@type':'StateChange',changed:{account:{HailMessage:'s'}}})});await settle();
  expect(a.changed).toHaveBeenCalledTimes(2);expect(b.changed).toHaveBeenCalledTimes(2);
  // A dropped stream stops vouching for every tab, so they all resume polling.
  a.sources[0]!.onerror!();await settle();expect(a.events.connected).toBe(false);expect(b.events.connected).toBe(false);
  a.events.stop();b.events.stop();
});
it('hands the stream to a waiting tab when the leader stops, and tells late tabs it is open',async()=>{
  const shared=browser(),a=tab(shared),b=tab(shared);
  a.events.start();await settle();a.sources[0]!.onopen!();
  b.events.start();await settle();expect(b.events.connected).toBe(true);
  a.events.stop();await settle();
  expect(a.sources[0]!.close).toHaveBeenCalled();expect(b.create).toHaveBeenCalledTimes(1);expect(b.events.connected).toBe(false);
  b.sources[0]!.onopen!();expect(b.events.connected).toBe(true);
  // A stopped follower leaves the queue without ever opening a stream.
  const c=tab(shared);c.events.start();await settle();c.events.stop();b.events.stop();await settle();
  expect(c.create).not.toHaveBeenCalled();
});
