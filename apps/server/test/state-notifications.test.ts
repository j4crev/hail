import {afterEach,expect,it,vi} from 'vitest';
import {STATE_CHANNEL,StateNotifications} from '../src/jmap/state-notifications.js';
afterEach(()=>vi.useRealTimers());
function fixture(){
  let deliver:(payload:string)=>void=()=>{},listened:()=>void=()=>{},online=true;
  const unlisten=vi.fn(async()=>{});
  const listen=vi.fn(async(channel:string,onNotify:(p:string)=>void,onListen:()=>void)=>{expect(channel).toBe(STATE_CHANNEL);deliver=onNotify;listened=onListen;onListen();return {unlisten};});
  const notify=vi.fn(async(_channel:string,payload:string)=>{if(online)queueMicrotask(()=>deliver(payload));});
  return {listen,notify,unlisten,deliver:(p:string)=>deliver(p),reconnect:()=>listened(),setOnline:(value:boolean)=>{online=value;},
    notifications:new StateNotifications(listen,notify,30_000,5_000)};
}
it('is healthy only while its own probe comes back, and wakes streams to poll quickly when it stops',async()=>{
  vi.useFakeTimers();const f=fixture(),wake=vi.fn();
  f.notifications.watch('account',wake);
  await f.notifications.start();await vi.advanceTimersByTimeAsync(0);expect(f.notifications.healthy).toBe(true);
  wake.mockClear();f.setOnline(false);
  await vi.advanceTimersByTimeAsync(30_000);expect(f.notifications.healthy).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);expect(f.notifications.healthy).toBe(false);expect(wake).toHaveBeenCalledOnce();
  // A reconnect re-subscribes: probe again and wake streams for anything missed meanwhile.
  f.setOnline(true);f.reconnect();await vi.advanceTimersByTimeAsync(0);expect(f.notifications.healthy).toBe(true);expect(wake).toHaveBeenCalledTimes(2);
  await f.notifications.stop();expect(f.unlisten).toHaveBeenCalledOnce();expect(f.notifications.healthy).toBe(false);
});
it('wakes only the watchers of the notified account until they unwatch',async()=>{
  const f=fixture(),a=vi.fn(),b=vi.fn();await f.notifications.start();
  const unwatch=f.notifications.watch('a',a);f.notifications.watch('b',b);
  f.deliver('a');expect(a).toHaveBeenCalledOnce();expect(b).not.toHaveBeenCalled();
  unwatch();f.deliver('a');expect(a).toHaveBeenCalledOnce();
  f.deliver('probe:not-ours');expect(b).not.toHaveBeenCalled();
  await f.notifications.stop();
});
it('stays unhealthy when listening fails',async()=>{
  const notifications=new StateNotifications(async()=>{throw new Error('down');},async()=>{});
  await notifications.start();expect(notifications.healthy).toBe(false);await notifications.stop();
});
