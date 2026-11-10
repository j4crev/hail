import {signHashEnvelope,verifyHashEnvelope,inspectHashEnvelope,createWebCryptoSigner,createWebCryptoVerifier} from '@racrproto/codec';
import {ed25519PublicKeyFromDidKey} from '../identity/did-key.js';
const contentType=(version:number)=>{
 if(version!==7&&version!==8)throw new Error('Superseded snapshot version');
 return `application/hail-${version===7?'portable':'managed'}-snapshot+json;version=${version}`;
};
export async function signSnapshot(bytes:Uint8Array,version:number,did:string,key:CryptoKey){
 // The JSON artifact carries the exact preimage separately; signature holds one
 // complete RFC 9995 COSE_Sign1 with its digest payload, not a second signature.
 return signHashEnvelope(bytes,contentType(version),createWebCryptoSigner(did+'#hail-messaging',key),67_108_864,true);
}
export function inspectSnapshotSignature(signature:Uint8Array,bytes:Uint8Array,version:number,did:string){
 if(signature.length>1024)throw new Error('Snapshot hash signature exceeds limit');
 const inspected=inspectHashEnvelope(signature,contentType(version),67_108_864,bytes);
 if(inspected.keyId!==did+'#hail-messaging')throw new Error('Wrong snapshot signer role');
 return inspected;
}
export async function verifySnapshotSignature(signature:Uint8Array,bytes:Uint8Array,version:number,did:string,publicKey:string){
 inspectSnapshotSignature(signature,bytes,version,did);
 await verifyHashEnvelope(signature,contentType(version),createWebCryptoVerifier(async kid=>{
  if(kid!==did+'#hail-messaging')throw new Error('Wrong snapshot signer role');
  return ed25519PublicKeyFromDidKey(publicKey);
 }),67_108_864,bytes);
}
