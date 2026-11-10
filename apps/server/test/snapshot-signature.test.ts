import {describe,it,expect} from 'vitest';
import {base58btc} from 'multiformats/bases/base58';
import {signSnapshot,verifySnapshotSignature} from '../src/migration/snapshot-signature.js';
const did='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
describe('RFC 9995 snapshot signatures',()=>{
 it.each([7,8])('binds exact manifest bytes, version, signer and transfer context (%s)',async version=>{
  const key=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const publicBytes=new Uint8Array(await crypto.subtle.exportKey('raw',key.publicKey));
  const publicKey='did:key:'+base58btc.encode(Uint8Array.from([0xed,1,...publicBytes]));
  const manifest={did,transferId:'test',destinationServiceBase:'https://destination.example/hail'};
  const bytes=new TextEncoder().encode(JSON.stringify(manifest));
  const sig=await signSnapshot(bytes,version,did,key.privateKey);
  await verifySnapshotSignature(sig,bytes,version,did,publicKey);
  const other=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const otherPublic='did:key:'+base58btc.encode(Uint8Array.from([0xed,1,...new Uint8Array(await crypto.subtle.exportKey('raw',other.publicKey))]));
  await expect(verifySnapshotSignature(sig,bytes,version,did,otherPublic)).rejects.toThrow(/signature/);
  for(const changed of [JSON.stringify(manifest)+'\n',JSON.stringify({...manifest,transferId:'other'}),JSON.stringify({...manifest,destinationServiceBase:'https://other.example/hail'})]){
   await expect(verifySnapshotSignature(sig,new TextEncoder().encode(changed),version,did,publicKey)).rejects.toThrow();
  }
  await expect(verifySnapshotSignature(sig,bytes,version===7?8:7,did,publicKey)).rejects.toThrow();
  await expect(verifySnapshotSignature(sig,bytes,version,did+'b',publicKey)).rejects.toThrow();
  await expect(verifySnapshotSignature(new Uint8Array(64),bytes,version,did,publicKey)).rejects.toThrow();
  const corrupted=sig.slice();corrupted[corrupted.length-1]=(corrupted[corrupted.length-1]??0)^1;
  await expect(verifySnapshotSignature(corrupted,bytes,version,did,publicKey)).rejects.toThrow(/signature/);
 });
});
