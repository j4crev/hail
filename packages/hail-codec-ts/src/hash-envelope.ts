import {sha256} from '@noble/hashes/sha2.js';
import {encode,decode,Tagged,rfc8949EncodeOptions} from 'cborg';
import {assertCborResourceLimits} from './scan.js';
import {HailCodecError} from './errors.js';
import type {HailSigner,HailVerifier} from './types.js';

export const HASH_ENVELOPE_PREIMAGE='https://haili.app/ns/racr/preimage';
export const ENVELOPE_DESCRIPTOR_MAX_BYTES=16_384;
export const ENVELOPE_REPRESENTATION_MAX_BYTES=17_408;
const cbor=(v:unknown)=>Uint8Array.from(encode(v,rfc8949EncodeOptions));
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function invalid(message:string):never{throw new HailCodecError('invalid-cose',message);}
export function hashEnvelopeProtected(contentType:string,keyId:string):Uint8Array {
 return cbor(new Map<number,unknown>([[1,-19],[4,new TextEncoder().encode(keyId)],[258,-16],[259,contentType]]));
}
export function hashEnvelopeSignatureInput(digest:Uint8Array,contentType:string,keyId:string):Uint8Array {
 if(digest.length!==32)invalid('hash envelope digest must be 32 bytes');
 return cbor(['Signature1',hashEnvelopeProtected(contentType,keyId),new Uint8Array(),digest]);
}
export function encodeHashEnvelope(preimage:Uint8Array,signature:Uint8Array,contentType:string,keyId:string,externalPreimage=false):Uint8Array {
 if(signature.length!==64)invalid('hash envelope signature must be 64 bytes');
 return cbor(new Tagged(18,[hashEnvelopeProtected(contentType,keyId),externalPreimage?new Map():new Map([[HASH_ENVELOPE_PREIMAGE,preimage]]),sha256(preimage),signature]));
}
export function inspectHashEnvelope(representation:Uint8Array,contentType:string,maximumPreimageBytes:number,externalPreimage?:Uint8Array){
 if(representation.length>maximumPreimageBytes+1024)throw new HailCodecError('resource-limit','hash envelope exceeds byte budget');
 const raw=Uint8Array.from(representation);
 const parse=(bytes:Uint8Array,maximumBytes:number,tags=false):unknown=>{
  assertCborResourceLimits(bytes,{maximumBytes,maximumDepth:8,maximumItems:256,maximumArrayLength:8,maximumMapEntries:8,maximumTextBytes:1024,maximumByteStringLength:maximumBytes},{allowedTags:new Set(tags?[18]:[])});
  let v:unknown;
  try{v=decode(bytes,{useMaps:true,strict:true,allowIndefinite:false,allowUndefined:false,allowNaN:false,allowInfinity:false,allowBigInt:false,rejectDuplicateMapKeys:true,...(tags?{tags:Tagged.preserve(18)}:{})});}
  catch{invalid('malformed hash envelope CBOR');}
  if(!equal(cbor(v),bytes))throw new HailCodecError('non-deterministic-cbor','hash envelope must be deterministic');
  return v;
 };
 const tagged=parse(raw,maximumPreimageBytes+1024,true);
 if(!(tagged instanceof Tagged)||tagged.tag!==18||!Array.isArray(tagged.value)||tagged.value.length!==4)invalid('tagged hash COSE_Sign1 required');
 const [p,u,d,s]=tagged.value as unknown[];
 if(!(p instanceof Uint8Array)||!(u instanceof Map)||!(d instanceof Uint8Array)||d.length!==32||!(s instanceof Uint8Array)||s.length!==64)invalid('invalid hash envelope components');
 const h=parse(p,1024);
 if(!(h instanceof Map)||h.size!==4||h.get(1)!==-19||h.get(258)!==-16||h.get(259)!==contentType||!(h.get(4) instanceof Uint8Array))invalid('wrong hash envelope protected profile');
 let keyId:string;
 try{keyId=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(h.get(4));}catch{invalid('invalid hash envelope kid');}
 const preimage=externalPreimage??u.get(HASH_ENVELOPE_PREIMAGE);
 if(u.size!==(externalPreimage?0:1)||!(preimage instanceof Uint8Array)||preimage.length<1||preimage.length>maximumPreimageBytes)invalid('missing or oversized hash envelope preimage');
 if(!equal(sha256(preimage),d))invalid('hash envelope preimage digest mismatch');
 return {keyId,preimage:preimage.slice(),digest:d.slice(),signature:s.slice(),protectedBytes:p.slice(),representationBytes:raw};
}
export async function signHashEnvelope(preimage:Uint8Array,contentType:string,signer:HailSigner,maximumPreimageBytes:number,externalPreimage=false){
 if(preimage.length<1||preimage.length>maximumPreimageBytes)throw new HailCodecError('resource-limit','hash envelope preimage exceeds byte budget');
 const signature=await signer.sign(hashEnvelopeSignatureInput(sha256(preimage),contentType,signer.keyId));
 const wire=encodeHashEnvelope(preimage,signature,contentType,signer.keyId,externalPreimage);
 inspectHashEnvelope(wire,contentType,maximumPreimageBytes,externalPreimage?preimage:undefined);
 return wire;
}
export async function verifyHashEnvelope(representation:Uint8Array,contentType:string,verifier:HailVerifier,maximumPreimageBytes:number,externalPreimage?:Uint8Array){
 const parsed=inspectHashEnvelope(representation,contentType,maximumPreimageBytes,externalPreimage);
 if(!await verifier.verify(hashEnvelopeSignatureInput(parsed.digest,contentType,parsed.keyId),parsed.signature,parsed.keyId))throw new HailCodecError('invalid-signature','hash envelope signature verification failed');
 return parsed;
}
