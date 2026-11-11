import {createECDH,ECDH,timingSafeEqual} from 'node:crypto';
import {generateRequestDetails} from 'web-push';

export interface VapidConfig {subject:string;publicKey:string;privateKey:string}
export interface PushKeys {p256dh:string;auth:string}
function bytes(value:unknown,length:number):Buffer {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid push key');
  const decoded=Buffer.from(value,'base64url');
  if(decoded.length!==length||decoded.toString('base64url')!==value)throw new Error('Invalid push key');
  return decoded;
}
function publicPoint(value:unknown):Buffer {
  const point=bytes(value,65);
  if(point[0]!==4)throw new Error('Invalid push public key');
  try{ECDH.convertKey(point,'prime256v1');}catch{throw new Error('Invalid push public key');}
  return point;
}
export function validateVapid(config:VapidConfig):VapidConfig {
  if(!config||typeof config.subject!=='string'||config.subject.length>2048)throw new Error('Invalid VAPID subject');
  let subject:URL;try{subject=new URL(config.subject);}catch{throw new Error('Invalid VAPID subject');}
  if(subject.username||subject.password||subject.hash||
    !(subject.protocol==='https:'&&subject.hostname||subject.protocol==='mailto:'&&!subject.search&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject.pathname)))throw new Error('Invalid VAPID subject');
  const publicKey=publicPoint(config.publicKey),privateKey=bytes(config.privateKey,32),curve=createECDH('prime256v1');
  try{curve.setPrivateKey(privateKey);if(!timingSafeEqual(curve.getPublicKey(),publicKey))throw new Error('Key mismatch');}
  catch{throw new Error('Invalid VAPID key pair');}finally{privateKey.fill(0);}
  return {...config};
}
export function validatePushKeys(value:unknown):PushKeys {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='auth,p256dh')throw new Error('Invalid push keys');
  const keys=value as PushKeys;publicPoint(keys.p256dh);bytes(keys.auth,16);
  return {p256dh:keys.p256dh,auth:keys.auth};
}
/** Generate ciphertext only. Sending must use the provider's SSRF-safe transport. */
export function encryptedPush(url:string,keys:PushKeys,payload:unknown,config:VapidConfig,ttl:number):Request {
  validateVapid(config);validatePushKeys(keys);
  const endpoint=new URL(url);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw new Error('Invalid push endpoint');
  if(!Number.isInteger(ttl)||ttl<0||ttl>300)throw new Error('Invalid push TTL');
  const body=JSON.stringify(payload);
  if(body===undefined||Buffer.byteLength(body)>3072)throw new Error('Push payload exceeds limit');
  const details=generateRequestDetails({endpoint:url,keys},body,{TTL:ttl,urgency:'normal',contentEncoding:'aes128gcm',vapidDetails:config});
  const headers=new Headers();
  const allowed=new Set(['authorization','content-encoding','content-type','ttl','urgency']);
  for(const [name,value] of Object.entries(details.headers))if(allowed.has(name.toLowerCase()))headers.set(name,String(value));
  // Refuse legacy GCM destinations where the library omits VAPID.
  if(!headers.get('authorization')?.startsWith('vapid ')||headers.get('content-encoding')!=='aes128gcm'||!details.body)throw new Error('Encrypted VAPID push required');
  return new Request(url,{method:'POST',headers,body:Uint8Array.from(details.body),signal:AbortSignal.timeout(10_000),redirect:'error'});
}
