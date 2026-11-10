import {expect,it,vi,beforeEach} from 'vitest';
vi.mock('$lib/server/canary.js',()=>({API_ORIGIN:'http://provider:3000',PROVIDER:'https://svr.example.com'}));
import {GET,POST} from '../routes/api/[...path]/+server.js';
import {redirectMedia} from './server/media.js';
const fetcher=vi.fn();
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});
const event=(path:string,method='GET')=>({params:{path},url:new URL(`https://example.com/api/${path}`),
 request:new Request(`https://example.com/api/${path}`,{method,headers:{Origin:'https://example.com',Authorization:'Bearer racr_signup'},...(method==='POST'?{body:'{}'}:{})}),
 cookies:{get:()=> 'hails_private'}}) as unknown as Parameters<typeof GET>[0];
it('never bridges raw media, capabilities, or non-JSON responses onto the app origin',async()=>{
 for(const path of ['v1/media/secret','v1/account/media-ticket','v1/account/attachments/a/b/c','v1/account/senders/a/avatar/image'])expect((await GET(event(path))).status).toBe(404);
 expect(fetcher).not.toHaveBeenCalled();
 fetcher.mockResolvedValue(new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}}));
 expect((await GET(event('v1/account/profile'))).status).toBe(502);
});
it('retains host-only sessions and original browser origin through the JSON bridge',async()=>{
 fetcher.mockResolvedValue(new Response('{}',{headers:{'Content-Type':'application/json','Set-Cookie':'hail_session=new; HttpOnly; Secure; Path=/; SameSite=Lax'}}));
 const result=await POST(event('v1/auth/passkeys/authentication','POST'));
 expect(result.status).toBe(200);expect(result.headers.get('set-cookie')).toContain('hail_session=new');
 const [url,options]=fetcher.mock.calls[0]!;expect(url).toBe('http://provider:3000/api/v1/auth/passkeys/authentication');
 expect(options.headers.get('Origin')).toBe('https://example.com');expect(options.headers.get('Cookie')).toBe('hail_session=hails_private');
 expect(options.headers.get('Authorization')).toBe('Bearer racr_signup');
 fetcher.mockResolvedValue(new Response('{}',{headers:{'Content-Type':'application/json','Set-Cookie':'hail_session=new; Domain=example.com; Path=/'}}));
 expect((await POST(event('v1/auth/passkeys/authentication','POST'))).headers.get('set-cookie')).toBeNull();
});
it('redirects to a validated provider capability, never to an arbitrary URL',async()=>{
 const request=vi.fn(async()=>({url:`https://svr.example.com/api/v1/media/${'A'.repeat(43)}`}));
 await expect(redirectMedia({request} as never,'/resource')).rejects.toMatchObject({status:303,location:`https://svr.example.com/api/v1/media/${'A'.repeat(43)}`});
 request.mockResolvedValue({url:'https://evil.example/api/v1/media/'+ 'A'.repeat(43)});
 await expect(redirectMedia({request} as never,'/resource')).rejects.toMatchObject({status:404});
});
