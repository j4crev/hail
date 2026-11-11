import Ajv from 'ajv';
import schema from '../../../spec/schemas/jmap-state-change-v1.json';
import vectors from '../../../spec/vectors/jmap-events.json';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {eventOptions,stateStream,HAIL_EVENTS} from '../src/jmap/events.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import type {JmapMessages} from '../src/jmap/messages.js';
afterEach(()=>vi.useRealTimers());
const validate=new Ajv().compile(schema);
for(const vector of vectors.cases)it(vector.name,()=>expect(validate(vector.value)).toBe(vector.valid));
const options={types:['HailMessage'],closeAfterState:false,pingSeconds:30};
const decode=(v:Uint8Array|undefined)=>new TextDecoder().decode(v);
it('validates type filters, closeafter and ping, clamping only nonzero ping',()=>{
  const parse=(q:string)=>eventOptions(new URL('https://p.example/jmap/events?'+q));
  expect(parse('types=HailMessage&closeafter=state&ping=1')).toEqual({...options,closeAfterState:true});
  expect(parse('types=*&closeafter=no&ping=0')?.pingSeconds).toBe(0);
  expect(parse('types=*&closeafter=no&ping=9999')?.pingSeconds).toBe(300);
  for(const q of ['','types=Secret&closeafter=no&ping=30','types=HailMessage,HailMessage&closeafter=no&ping=30','types=*&closeafter=bad&ping=30','types=*&closeafter=no&ping=-1','types=*&types=HailMessage&closeafter=no&ping=30'])expect(parse(q)).toBeNull();
});
it('sends only selected states, resumes without duplicates, and reports missed changes',async()=>{
  vi.useFakeTimers();let state='one';const release=vi.fn(),abort=new AbortController();
  const read=async()=>({accountId:'account_a',states:{HailMessage:state,HailGrant:'secret'}});
  const first=stateStream(read,{...options,closeAfterState:true},abort.signal,null,release);
  const frame=await first.text();expect(validate(JSON.parse(frame.split('\n')[1]!.slice(6)))).toBe(true);expect(frame).toContain('"HailMessage":"one"');expect(frame).not.toContain('secret');expect(release).toHaveBeenCalledTimes(1);
  const id=/id: (\S+)/.exec(frame)![1]!;
  const response=stateStream(read,options,abort.signal,id,release),reader=response.body!.getReader();
  const next=reader.read();let received=false;void next.then(()=>received=true);
  await vi.advanceTimersByTimeAsync(2000);expect(received).toBe(false);
  state='three';await vi.advanceTimersByTimeAsync(2000);expect(decode((await next).value)).toContain('"HailMessage":"three"');
  await reader.cancel();expect(release).toHaveBeenCalledTimes(2);
});
it('pings without event IDs and releases on expiry, revocation, abort and backpressure',async()=>{
  vi.useFakeTimers();let active=true;const release=vi.fn(),abort=new AbortController();
  const read=async()=>active?{accountId:'a',states:{HailMessage:'one'}}:null;
  const reader=stateStream(read,options,abort.signal,null,release).body!.getReader();await reader.read();
  const ping=reader.read();await vi.advanceTimersByTimeAsync(30000);expect(decode((await ping).value)).toBe('event: ping\ndata: {"interval":30}\n\n');
  active=false;expect((await reader.read()).done).toBe(true);expect(release).toHaveBeenCalledTimes(1);
  const idle=stateStream(read,options,abort.signal,null,release).body!.getReader();abort.abort();expect((await idle.read()).done).toBe(true);
  const bounded=stateStream(read,options,new AbortController().signal,null,release).body!.getReader();
  await vi.advanceTimersByTimeAsync(300000);expect((await bounded.read()).done).toBe(true);expect(release).toHaveBeenCalledTimes(3);
});
describe('authenticated event route',()=>{
  function fixture(){
    let session:AccountApiSession|null={account_id:'a',credential_id:'c',did:'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',canonical_address:'a@example.com',scopes:['messages:read'],migration_state:null,serving_generation:1} as AccountApiSession;
    const authenticate=vi.fn(async(..._args:unknown[])=>session),messages={accountId:()=> 'account_a',currentState:async()=> 'account_a_m_0'} as unknown as JmapMessages;
    const app=new Hono();registerJmapRoutes(app,{authenticate} as unknown as AccountApiRepository,messages,'https://p.example');
    const request=(query='types=*&closeafter=no&ping=30',init?:RequestInit)=>app.request('https://p.example/jmap/events?'+query,init);
    return {app,request,authenticate,revoke:()=>session=null,change:()=>{session={...session!,serving_generation:2};}};
  }
  it('advertises connected events, rejects cross-origin access and frees account stream limits',async()=>{
    const f=fixture();expect((await (await f.app.request('/.well-known/jmap')).json()).capabilities[HAIL_EVENTS].transport).toBe('eventsource');
    expect((await f.request(undefined,{headers:{Origin:'https://other.example'}})).status).toBe(403);
    expect((await f.request(undefined,{method:'POST'})).status).toBe(405);
    const one=await f.request(),two=await f.request();expect((await f.request()).status).toBe(429);
    await one.body!.cancel();const three=await f.request();expect(three.status).toBe(200);
    await two.body!.cancel();await three.body!.cancel();
  });
  for(const action of ['revoke','change'] as const)it('ends stream on '+action+' without refreshing session activity',async()=>{
    const f=fixture(),response=await f.request(),reader=response.body!.getReader();
    expect(decode((await reader.read()).value)).toContain('account_a_m_0');f[action]();
    expect((await reader.read()).done).toBe(true);
    expect(f.authenticate.mock.calls.every(call=>call[2]===false)).toBe(true);
  });
});
