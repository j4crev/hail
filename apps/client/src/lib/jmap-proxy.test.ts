import {afterEach,expect,it,vi} from 'vitest';
vi.mock('$lib/server/canary.js',()=>({API_ORIGIN:'https://provider.example.com'}));
import {GET,POST} from '../routes/api/[...path]/+server.js';
afterEach(()=>vi.unstubAllGlobals());
it('bridges only JMAP JSON endpoints to the configured provider and forwards the session and browser Origin',async()=>{
  const fetch=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal('fetch',fetch);
  for(const [path,method,target] of [['jmap/session','GET','/.well-known/jmap'],['jmap','POST','/jmap']] as const){
    const url=new URL('https://client.example.com/api/'+path);
    const request=new Request(url,{method,headers:{Origin:'https://client.example.com','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    const event={request,url,params:{path},cookies:{get:()=> 'session_fixture'}} as unknown as Parameters<typeof GET>[0];
    expect((await (method==='GET'?GET:POST)(event)).status).toBe(200);
    const [destination,options]=fetch.mock.calls.at(-1)! as unknown as [string,RequestInit];
    expect(destination).toBe('https://provider.example.com'+target);
    expect(new Headers(options.headers).get('Cookie')).toBe('hail_session=session_fixture');
    expect(new Headers(options.headers).get('Origin')).toBe('https://client.example.com');
    expect(options.redirect).toBe('manual');
  }
  const url=new URL('https://client.example.com/api/jmap/download/secret');
  expect((await GET({request:new Request(url),url,params:{path:'jmap/download/secret'},cookies:{get:()=> 'session_fixture'}} as unknown as Parameters<typeof GET>[0])).status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(2);
});
