import {afterEach,expect,it,vi} from 'vitest';
import {MailboxEvents} from './jmap-events.js';
afterEach(()=>vi.useRealTimers());
it('uses only the same-origin bridge and treats reconnects and duplicate states as sync hints',()=>{
  const changed=vi.fn(),listeners=new Map<string,(event:unknown)=>void>();
  const source={close:vi.fn(),onopen:null as null|(()=>void),onerror:null as null|(()=>void),addEventListener:(name:string,callback:(event:unknown)=>void)=>listeners.set(name,callback)};
  const create=vi.fn(()=>source as unknown as EventSource),events=new MailboxEvents(changed,create);
  events.start();events.start();expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0]).toEqual(['/api/jmap/events?types=*&closeafter=no&ping=30']);
  source.onopen!();expect(changed).toHaveBeenCalledTimes(1);
  for(let i=0;i<2;i++)listeners.get('state')!({data:JSON.stringify({'@type':'StateChange',changed:{account:{HailMessage:'state'}}})});
  expect(changed).toHaveBeenCalledTimes(3);
  for(const data of ['bad',JSON.stringify({changed:{}}),'x'.repeat(8193)])listeners.get('state')!({data});
  expect(changed).toHaveBeenCalledTimes(3);events.stop();listeners.get('state')!({data:JSON.stringify({'@type':'StateChange',changed:{}})});
  expect(changed).toHaveBeenCalledTimes(3);expect(source.close).toHaveBeenCalledTimes(1);
});
it('backs off failures, cancels retries on stop and can start again',async()=>{
  vi.useFakeTimers();const sources:Array<{close:ReturnType<typeof vi.fn>;onerror:()=>void}>=[];
  const create=vi.fn(()=>{const source={close:vi.fn(),onerror:()=>{},addEventListener:()=>{}};sources.push(source);return source as unknown as EventSource;});
  const events=new MailboxEvents(()=>{},create);events.start();sources[0]!.onerror();expect(sources[0]!.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999);expect(create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001);expect(create).toHaveBeenCalledTimes(2);
  sources[1]!.onerror();events.stop();await vi.advanceTimersByTimeAsync(120000);expect(create).toHaveBeenCalledTimes(2);
  events.start();expect(create).toHaveBeenCalledTimes(3);events.stop();
});
