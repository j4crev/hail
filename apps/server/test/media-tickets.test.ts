import {expect,it,vi} from 'vitest';
import {MediaTickets,isMediaPath} from '../src/accounts/media-tickets.js';
import {createApp} from '../src/app.js';
import type {AppConfig} from '../src/config.js';
import type {AppDependencies} from '../src/app.js';
const did='did:plc:'+'a'.repeat(24),id='01900000-0000-7000-8000-000000000001';
const path=`/api/v1/account/attachments/${did}/${id}/${'A'.repeat(43)}?index=0`;
it('bounds capability lifetime, capacity and resource syntax',()=>{
 let now=0;const tickets=new MediaTickets(()=>now,1);
 const token=tickets.issue(path,{cookie:'hail_session=private'})!;
 expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(tickets.read(token)?.path).toBe(path);
 expect(tickets.issue(path,{})).toBeNull();now=60_000;expect(tickets.read(token)).toBeNull();expect(tickets.issue(path,{})).not.toBeNull();
 for(const value of ['https://evil.example/', '//evil.example/', '/api/v1/account',path+'&other=1',path+'#x',path.replace(id,'../auth'),'/api/v1/media/abc'])expect(isMediaPath(value)).toBe(false);
 expect(isMediaPath(`/api/v1/account/senders/${encodeURIComponent(did)}/avatar/image`)).toBe(true);
});
it('redeems only the bound resource and rechecks revoked sessions and permissions',async()=>{
 const token='hails_'+'B'.repeat(43),cookie=`hail_session=${token}`;
 let active=true;const session={account_id:crypto.randomUUID(),did,scopes:['messages:read'],serving_generation:1};
 const authenticate=vi.fn(async(_authorization,received)=>active&&received===token?session:null);
 const attachment=vi.fn(async()=>({file:{filename:'file.txt',media_type:'text/plain'},bytes:new Uint8Array([65])}));
 const app=createApp({publicOrigin:'https://svr.example.com',passkeys:{origin:'https://example.com',rpId:'example.com'}} as AppConfig,
  {accountApi:{accounts:{authenticate},grants:{},service:{},messaging:{attachment}}} as unknown as AppDependencies);
 const issue=(origin='https://example.com')=>app.request('/api/v1/account/media-ticket',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({path})});
 expect((await issue('https://svr.example.com')).status).toBe(403);
 const response=await issue();expect(response.status).toBe(200);
 const result=await response.json();expect(result.url).toMatch(/^https:\/\/svr.example.com\/api\/v1\/media\/[A-Za-z0-9_-]{43}$/);
 expect(JSON.stringify(result)).not.toContain(token);
 let media=await app.request(result.url);expect(media.status).toBe(200);expect(await media.text()).toBe('A');
 expect(media.headers.get('content-security-policy')).toContain('sandbox');expect(media.headers.get('referrer-policy')).toBe('no-referrer');
 expect(media.headers.get('set-cookie')).toBeNull();expect(attachment).toHaveBeenCalledWith(session,did,id,'A'.repeat(43),0);
 expect((await app.request(result.url+'?path=/api/v1/account')).status).toBe(404);
 session.scopes=[];expect((await app.request(result.url)).status).toBe(403);
 active=false;expect((await app.request(result.url)).status).toBe(401);
});
it('keeps CLI authorization at the selected provider and redirects only explicit browser entry points',async()=>{
 const app=createApp({publicOrigin:'https://svr.example.com',passkeys:{origin:'https://example.com',rpId:'example.com'}} as AppConfig);
 const response=await app.request('/auth/authorize?request=abc&state=def');
 expect(response.status).toBe(303);expect(response.headers.get('location')).toBe('https://example.com/auth/authorize?request=abc&state=def');
 expect((await app.request('/')).status).toBe(404);
});
