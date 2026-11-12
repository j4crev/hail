import {expect,it,vi} from 'vitest';
import {AccountApiError} from '@racrproto/client-support/account-api';
import {messageImageResponse} from './server/message-image.js';
import vectors from '../../../../spec/vectors/attachment-images.json';

const jpeg=Uint8Array.from(vectors.records.find(record=>record.id==='baseline.jpg')!.fileHex.match(/../g)!,byte=>parseInt(byte,16));
const params={sender:'did:plc:'+'s'.repeat(24),messageId:'01890a5d-ac96-7b4c-8b4a-123456789abc',digest:'D'.repeat(43)};

it('serves a verified image privately cacheable, typed and sandboxed',async()=>{
  const messageImage=vi.fn(async()=>({mediaType:'image/jpeg' as const,bytes:jpeg}));
  const response=await messageImageResponse(params,async()=>({messageImage}));
  expect(response.status).toBe(200);expect(messageImage).toHaveBeenCalledWith(params.sender,params.messageId,params.digest);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
  expect(Object.fromEntries(['content-type','cache-control','x-content-type-options','content-security-policy','cross-origin-resource-policy'].map(h=>[h,response.headers.get(h)]))).toEqual({
    'content-type':'image/jpeg','cache-control':'private, max-age=2592000, immutable','x-content-type-options':'nosniff',
    'content-security-policy':"sandbox; default-src 'none'",'cross-origin-resource-policy':'same-origin'});
});

it('never caches a refusal and rejects bytes that are not the claimed image type',async()=>{
  const check=async(response:Response,status:number)=>{expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toBe('private, no-store');};
  const never=vi.fn();
  await check(await messageImageResponse({...params,digest:'../x'},never),404);
  await check(await messageImageResponse({...params,sender:'sent-message'},never),404);
  expect(never).not.toHaveBeenCalled();
  await check(await messageImageResponse(params,async()=>({messageImage:async()=>({mediaType:'image/png' as const,bytes:jpeg})})),404);
  for(const status of [401,403,429,503])await check(await messageImageResponse(params,async()=>({messageImage:async()=>{throw new AccountApiError(status);}})),status);
  await check(await messageImageResponse(params,async()=>({messageImage:async()=>{throw new AccountApiError(404);}})),404);
});
