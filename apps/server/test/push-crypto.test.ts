import Ajv from 'ajv';
import schema from '../../../spec/schemas/jmap-push-v1.json';
import vectors from '../../../spec/vectors/jmap-push.json';
import {createECDH,createDecipheriv,createPublicKey,hkdfSync,randomBytes,verify} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {encryptedPush,validatePushKeys,validateVapid,type VapidConfig} from '../src/jmap/push-crypto.js';
const b64=(b:Buffer)=>b.toString('base64url');
function fixture(){
  const sender=createECDH('prime256v1'),receiver=createECDH('prime256v1');sender.generateKeys();receiver.generateKeys();
  const config:VapidConfig={subject:'mailto:ops@example.com',publicKey:b64(sender.getPublicKey()),privateKey:Buffer.from(sender.getPrivateKey().toString('hex').padStart(64,'0'),'hex').toString('base64url')};
  const keys={p256dh:b64(receiver.getPublicKey()),auth:b64(randomBytes(16))};return {sender,receiver,config,keys};
}
describe('encrypted Web Push',()=>{
  it('independently decrypts RFC 8291 aes128gcm records and verifies the VAPID signature',async()=>{
    const {receiver,config,keys}=fixture(),payload={'@type':'StateChange',changed:{opaque_account:{HailMessage:'opaque_state'}}};
    const request=encryptedPush('https://push.example.com/delivery/device',keys,payload,config,120);
    expect(request.method).toBe('POST');expect(request.redirect).toBe('error');
    expect(Object.fromEntries(request.headers)).toMatchObject({'content-type':'application/octet-stream','content-encoding':'aes128gcm',ttl:'120',urgency:'normal'});
    expect([...request.headers.keys()].sort()).toEqual(['authorization','content-encoding','content-type','ttl','urgency']);
    const encrypted=Buffer.from(await request.arrayBuffer());expect(encrypted.includes(Buffer.from('opaque_account'))).toBe(false);
    const salt=encrypted.subarray(0,16),recordSize=encrypted.readUInt32BE(16),keyLength=encrypted[20]!;
    expect(recordSize).toBe(4096);expect(keyLength).toBe(65);
    const senderKey=encrypted.subarray(21,21+keyLength),shared=receiver.computeSecret(senderKey);
    const ikm=Buffer.from(hkdfSync('sha256',shared,Buffer.from(keys.auth,'base64url'),Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),senderKey]),32));
    const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
    const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
    const record=encrypted.subarray(21+keyLength),decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(record.subarray(-16));
    const plaintext=Buffer.concat([decipher.update(record.subarray(0,-16)),decipher.final()]);
    expect(plaintext.at(-1)).toBe(2);expect(JSON.parse(plaintext.subarray(0,-1).toString())).toEqual(payload);
    const auth=/^vapid t=([^,]+), k=(.+)$/.exec(request.headers.get('authorization')!)!;expect(auth).not.toBeNull();expect(auth[2]).toBe(config.publicKey);
    const [header,claims,signature]=auth[1]!.split('.');
    expect(JSON.parse(Buffer.from(header!,'base64url').toString())).toMatchObject({typ:'JWT',alg:'ES256'});
    const jwt=JSON.parse(Buffer.from(claims!,'base64url').toString()),now=Math.floor(Date.now()/1000);
    expect(jwt.aud).toBe('https://push.example.com');expect(jwt.sub).toBe(config.subject);expect(jwt.exp).toBeGreaterThan(now);expect(jwt.exp).toBeLessThanOrEqual(now+86400);
    const point=Buffer.from(config.publicKey,'base64url'),publicKey=createPublicKey({key:{kty:'EC',crv:'P-256',x:b64(point.subarray(1,33)),y:b64(point.subarray(33))},format:'jwk'});
    expect(verify('sha256',Buffer.from(header+'.'+claims),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature!,'base64url'))).toBe(true);
    const second=Buffer.from(await encryptedPush(request.url,keys,payload,config,120).arrayBuffer());expect(second.equals(encrypted)).toBe(false);
  });
  it('rejects malformed keys, mismatched VAPID keys, unsafe subjects and unbounded payloads',()=>{
    const {config,keys}=fixture();expect(validatePushKeys(keys)).toEqual(keys);expect(validateVapid(config)).toEqual(config);
    for(const value of [null,{}, {...keys,auth:keys.auth+'='},{...keys,extra:1},{...keys,p256dh:b64(Buffer.alloc(65,4))},{...keys,auth:b64(randomBytes(15))}])expect(()=>validatePushKeys(value)).toThrow();
    expect(()=>validateVapid({...config,publicKey:fixture().config.publicKey})).toThrow('Invalid VAPID key pair');
    for(const subject of ['http://example.com','https://user:pass@example.com','https://example.com/#fragment','mailto:not-an-address','mailto:ops@example.com?body=secret'])expect(()=>validateVapid({...config,subject})).toThrow();
    for(const ttl of [-1,301,1.2,NaN])expect(()=>encryptedPush('https://push.example.com/path',keys,{},config,ttl)).toThrow('TTL');
    expect(()=>encryptedPush('https://push.example.com/path',keys,'x'.repeat(4000),config,0)).toThrow('limit');
    for(const endpoint of ['http://push.example.com','https://name:secret@push.example.com','https://push.example.com/#fragment'])expect(()=>encryptedPush(endpoint,keys,{},config,0)).toThrow('endpoint');
  });
});

it("validates push conformance objects",()=>{const validate=new Ajv({allErrors:true}).compile(schema);for(const value of vectors.valid)expect(validate(value),JSON.stringify(validate.errors)).toBe(true);for(const value of vectors.invalid)expect(validate(value)).toBe(false);});
