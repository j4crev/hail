import {expect,it,vi} from 'vitest';
import {createApp} from '../src/app.js';
import type {AppConfig} from '../src/config.js';
import type {AccountApiRepository} from '../src/accounts/repository.js';
import type {AccountMessaging} from '../src/accounts/messaging.js';
import type {GrantRepository} from '../src/grants/repository.js';
import type {GrantService} from '../src/grants/service.js';
const did='did:plc:'+'a'.repeat(24),id='01900000-0000-7000-8000-000000000001',digest='A'.repeat(43);
function setup(){
 const session={account_id:crypto.randomUUID(),did,scopes:['messages:read','messages:write'],migration_state:null as string|null,serving_generation:1};
 const authenticate=vi.fn(async()=>session as typeof session|null),upload=vi.fn(),attachment=vi.fn();
 const app=createApp({publicOrigin:'https://example.com',hailServiceBase:'https://example.com/hail',providerId:'test'} as AppConfig,
  {accountApi:{accounts:{authenticate} as unknown as AccountApiRepository,grants:{} as GrantRepository,service:{} as GrantService,
   messaging:{attachments:{upload},attachment} as unknown as AccountMessaging},async checkReadiness(){return {ready:true};}});
 return {app,session,authenticate,upload,attachment};
}
it('forces downloads and authorizes against the requesting account and exact message',async()=>{
 const f=setup();f.attachment.mockResolvedValue({file:{filename:'résumé.pdf',media_type:'application/pdf'},bytes:new Uint8Array([1,2])});
 const path=`/api/v1/account/attachments/${did}/${id}/${digest}`;
 const response=await f.app.request(path);expect(response.status).toBe(200);
 expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
 expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('content-security-policy')).toContain('sandbox');
 expect(f.attachment).toHaveBeenCalledWith(f.session,did,id,digest,undefined);
 f.attachment.mockResolvedValue(null);expect((await f.app.request(path)).status).toBe(404);
 f.session.scopes=[];expect((await f.app.request(path)).status).toBe(403);
 f.authenticate.mockResolvedValue(null);expect((await f.app.request(path)).status).toBe(401);
});
it('requires write authority and an unfenced account for bounded uploads',async()=>{
 const f=setup(),request=()=>f.app.request('/api/v1/account/attachments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'test.log',data:'eA'})});
 f.upload.mockResolvedValue({filename:'test.log'});expect((await request()).status).toBe(200);
 f.session.migration_state='fenced';expect((await request()).status).toBe(409);
 f.session.migration_state=null;f.session.scopes=['messages:read'];expect((await request()).status).toBe(403);
 expect(f.upload).toHaveBeenCalledTimes(1);
});

it('cancels an interrupted inbound upload when its read deadline expires',async()=>{
 const {accountRequestBytes,RequestBodyTimeout}=await import('../src/accounts/routes.js');
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1]));},cancel});
 await expect(accountRequestBytes(new Request('https://example.com',{method:'POST',body,duplex:'half'} as RequestInit),10,5)).rejects.toBeInstanceOf(RequestBodyTimeout);
 expect(cancel).toHaveBeenCalledOnce();
});

it('encodes Unicode and every reserved filename character as an RFC 8187 value',async()=>{
 const f=setup(),filename="résumé (final)*'%;\".pdf";
 f.attachment.mockResolvedValue({file:{filename,media_type:'application/pdf'},bytes:new Uint8Array([1])});
 const r=await f.app.request(`/api/v1/account/attachments/${did}/${id}/${digest}`);
 const value=r.headers.get('content-disposition')!.split("UTF-8''")[1]!;
 expect(value).toMatch(/^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})+$/);
 expect(decodeURIComponent(value)).toBe(filename);
});

it('marks account download successes and authentication/scope/storage failures uncacheable',async()=>{
 const f=setup(),path=`/api/v1/account/attachments/${did}/${id}/${digest}`;
 f.attachment.mockResolvedValue({file:{filename:'a.pdf',media_type:'application/pdf'},bytes:new Uint8Array([1])});
 const check=async(status:number)=>{const r=await f.app.request(path);expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toContain('no-store');};
 await check(200);
 f.attachment.mockResolvedValue(null);await check(404);
 f.attachment.mockRejectedValue(new Error('storage failure'));await check(503);
 f.session.scopes=[];await check(403);
 f.authenticate.mockResolvedValue(null);await check(401);
});

it('rechecks the account for the same download URL after a session change',async()=>{
 const f=setup(),owner=f.session.account_id,path=`/api/v1/account/attachments/${did}/${id}/${digest}`;
 f.attachment.mockImplementation(async(session)=>session.account_id===owner?{file:{filename:'private.pdf',media_type:'application/pdf'},bytes:new Uint8Array([42])}:null);
 const first=await f.app.request(path);expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toContain('no-store');
 f.session.account_id=crypto.randomUUID();
 const second=await f.app.request(path);expect(second.status).toBe(404);expect(second.headers.get('cache-control')).toContain('no-store');
 expect(f.attachment).toHaveBeenCalledTimes(2);
});
