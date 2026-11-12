import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {encodeBase64Url} from '@racrproto/codec';
import {AccountMessaging,referenceImages} from '../src/accounts/messaging.js';
import {JmapMessages} from '../src/jmap/messages.js';
import {createApp} from '../src/app.js';
import type {AppConfig} from '../src/config.js';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import type {GrantRepository} from '../src/grants/repository.js';
import type {GrantService} from '../src/grants/service.js';

const did='did:plc:'+'a'.repeat(24),sender='did:plc:'+'b'.repeat(24),id='01900000-0000-7000-8000-000000000001';
const png=new Uint8Array([137,80,78,71,1,2,3]),data=encodeBase64Url(png);
const digest=encodeBase64Url(new Uint8Array(createHash('sha256').update(png).digest()));
const body={version:1,profile:'spt-3',blocks:[{_type:'spt.image',asset:'hero'}],assets:{version:1,assets:[
  {id:'hero',role:'header',media_type:'image/png',loading:'bundled',size:png.length,width:1,height:1,digest:{algorithm:'sha-256',value:digest},data},
  {id:'logo',role:'avatar',media_type:'image/png',loading:'bundled',size:png.length,width:1,height:1,digest:{algorithm:'sha-256',value:digest},data}]}};

it('omits bundled header/image data, keeping their digests, and leaves other assets alone',()=>{
  const message={messageId:id,body};
  const referenced=referenceImages(message) as unknown as {body:typeof body};
  expect(referenced.body.assets.assets[0]).toEqual({id:'hero',role:'header',media_type:'image/png',loading:'bundled',size:png.length,width:1,height:1,digest:{algorithm:'sha-256',value:digest}});
  expect(referenced.body.assets.assets[1]).toHaveProperty('data',data);
  expect(message.body.assets.assets[0]).toHaveProperty('data',data);
  const text={messageId:id,body:{version:1,profile:'spt-1',blocks:[]}};expect(referenceImages(text)).toBe(text);
});

it('returns one image of a visible message by digest, through the message lookup',async()=>{
  const messaging=new AccountMessaging({} as never,{} as never,{} as never,{} as never,async()=>({}));
  const read=vi.spyOn(messaging,'read').mockResolvedValue({body} as never),sent=vi.spyOn(messaging,'sentMessage').mockResolvedValue({body} as never);
  const session={did,account_id:'a'} as AccountApiSession;
  expect(await messaging.image(session,sender,id,digest)).toEqual({mediaType:'image/png',bytes:png});
  expect(read).toHaveBeenCalledWith(session,sender,id);
  expect(await messaging.image(session,did,id,digest)).toMatchObject({mediaType:'image/png'});expect(sent).toHaveBeenCalledWith(session,id);
  expect(await messaging.image(session,sender,id,'B'.repeat(43))).toBeNull();
  expect(await messaging.image(session,sender,id,'not-a-digest')).toBeNull();
  read.mockResolvedValue(null);expect(await messaging.image(session,sender,id,digest)).toBeNull();
});

it('serves message images with a fixed type and no caching or sniffing, only with read scope',async()=>{
  const session={account_id:crypto.randomUUID(),did,scopes:['messages:read'],migration_state:null,serving_generation:1};
  const authenticate=vi.fn(async()=>session as typeof session|null),image=vi.fn();
  const app=createApp({publicOrigin:'https://example.com',hailServiceBase:'https://example.com/hail',providerId:'test'} as AppConfig,
    {jmap:new JmapMessages({} as never,'https://example.com'),accountApi:{accounts:{authenticate} as unknown as AccountApiRepository,grants:{} as GrantRepository,service:{} as GrantService,
      messaging:{image} as unknown as AccountMessaging},async checkReadiness(){return {ready:true};}});
  const path=`/api/v1/account/images/${sender}/${id}/${digest}`;
  image.mockResolvedValue({mediaType:'image/png',bytes:png});
  const response=await app.request(path);expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  expect(Object.fromEntries(['content-type','x-content-type-options','cache-control'].map(h=>[h,response.headers.get(h)]))).toEqual({'content-type':'image/png','x-content-type-options':'nosniff','cache-control':'private, no-store'});
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(image).toHaveBeenCalledWith(session,sender,id,digest);
  expect((await app.request(path+'?x=1')).status).toBe(400);
  image.mockResolvedValue(null);expect((await app.request(path)).status).toBe(404);
  session.scopes=[];expect((await app.request(path)).status).toBe(403);
  authenticate.mockResolvedValue(null);expect((await app.request(path)).status).toBe(401);
});

it('returns image references from read, sentMessage and inboxFeed only when asked',async()=>{
  const session={account_id:crypto.randomUUID(),did,credential_id:crypto.randomUUID(),serving_generation:1,scopes:['messages:read'],migration_state:null};
  const accounts={authenticate:vi.fn(async()=>session)} as unknown as AccountApiRepository;
  const message={messageId:id,sender,body};
  const messaging={read:async()=>message,sentMessage:async()=>message,inboxFeed:async()=>({messages:[message],next:null})} as unknown as AccountMessaging;
  const origin='https://example.com',app=createApp({publicOrigin:origin,providerId:'test',passkeys:{origin}} as AppConfig,
    {jmap:new JmapMessages({} as never,origin),accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,messaging},async checkReadiness(){return {ready:true};}});
  const view=async(args:Record<string,unknown>)=>{
    const response=await app.request('/jmap',{method:'POST',headers:{Cookie:'hail_session=fixture',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({
      using:['urn:ietf:params:jmap:core','https://racrproto.com/ns/jmap/account'],methodCalls:[['HailMailbox/view',{accountId:new JmapMessages({} as never,origin).accountId(session as never),...args},'t']]})});
    return ((await response.json()) as {methodResponses:[[string,any,string]]}).methodResponses[0];
  };
  const header=(result:any)=>result.body.assets.assets[0];
  expect(header((await view({view:'read',sender,messageId:id}))[1])).toHaveProperty('data',data);
  expect(header((await view({view:'read',sender,messageId:id,images:'inline'}))[1])).toHaveProperty('data',data);
  expect(header((await view({view:'read',sender,messageId:id,images:'reference'}))[1])).toEqual(expect.objectContaining({digest:{algorithm:'sha-256',value:digest}}));
  expect(header((await view({view:'read',sender,messageId:id,images:'reference'}))[1])).not.toHaveProperty('data');
  expect(header((await view({view:'sentMessage',messageId:id,images:'reference'}))[1])).toHaveProperty('digest.value',digest);
  expect(header((await view({view:'inboxFeed',images:'reference'}))[1].messages[0])).toHaveProperty('digest.value',digest);
  expect((await view({view:'read',sender,messageId:id,images:'other'}))[0]).toBe('error');
  expect((await view({view:'threads',sender,messageId:id,images:'reference'}))[0]).toBe('error');
});
