import {afterEach,expect,it,vi} from 'vitest';
vi.mock('$lib/server/canary.js',()=>({API_ORIGIN:'https://provider.example.com'}));
import {GET,POST} from '../routes/api/[...path]/+server.js';
afterEach(()=>vi.unstubAllGlobals());
it('streams only the fixed event endpoint and propagates cancellation without following redirects',async()=>{
  const abort=new AbortController(),text='event: state\ndata: {"@type":"StateChange","changed":{}}\n\n';
  const fetch=vi.fn(async()=>new Response(text,{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetch);
  const url=new URL('https://client.example.com/api/jmap/events?types=*&closeafter=no&ping=30');
  const event={request:new Request(url,{signal:abort.signal,headers:{'Last-Event-ID':'abc'}}),url,params:{path:'jmap/events'},cookies:{get:()=> 'session_fixture'}} as unknown as Parameters<typeof GET>[0];
  const response=await GET(event);expect(await response.text()).toBe(text);expect(response.headers.get('X-Accel-Buffering')).toBe('no');
  const [destination,options]=fetch.mock.calls[0]! as unknown as [string,RequestInit];
  expect(destination).toBe('https://provider.example.com/jmap/events'+url.search);expect(options.redirect).toBe('manual');
  expect(new Headers(options.headers).get('Last-Event-ID')).toBe('abc');abort.abort();expect(options.signal?.aborted).toBe(true);
  expect((await POST({...event,request:new Request(url,{method:'POST'})})).status).toBe(405);
  // The stream exception must not turn the general JSON bridge into a content proxy.
  const bad={...event,params:{path:'v1/account'},url:new URL('https://client.example.com/api/v1/account')};
  expect((await GET(bad)).status).toBe(502);
});
it('bridges only JMAP JSON endpoints to the configured provider and forwards the session and browser Origin',async()=>{
  const fetch=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal('fetch',fetch);
  for(const [path,method,target] of [['jmap/session','GET','/.well-known/jmap'],['jmap','POST','/jmap']] as const){
    const url=new URL('https://client.example.com/api/'+path);
    const request=new Request(url,{method,headers:{Origin:'https://client.example.com','X-Hail-Background':'true','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    const event={request,url,params:{path},cookies:{get:()=> 'session_fixture'}} as unknown as Parameters<typeof GET>[0];
    expect((await (method==='GET'?GET:POST)(event)).status).toBe(200);
    const [destination,options]=fetch.mock.calls.at(-1)! as unknown as [string,RequestInit];
    expect(destination).toBe('https://provider.example.com'+target);
    expect(new Headers(options.headers).get('Cookie')).toBe('hail_session=session_fixture');
    expect(new Headers(options.headers).get('Origin')).toBe('https://client.example.com');
    expect(new Headers(options.headers).get('X-Hail-Background')).toBe('true');
    expect(options.redirect).toBe('manual');
  }
  const url=new URL('https://client.example.com/api/jmap/download/secret');
  expect((await GET({request:new Request(url),url,params:{path:'jmap/download/secret'},cookies:{get:()=> 'session_fixture'}} as unknown as Parameters<typeof GET>[0])).status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(2);
});
