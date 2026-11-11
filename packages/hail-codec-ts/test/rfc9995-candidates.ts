// Evaluation only. Not exported by the codec or accepted by production ingress.
import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {encode,decode,Tagged,rfc8949EncodeOptions} from 'cborg';
import {decodePayload,encodePayload,encodeDeterministic,decodeDeterministic,type HailEnvelope,type HailValue} from '../src/index.js';
import {assertCborResourceLimits} from '../src/scan.js';
export const ADMISSION='https://haili.app/ns/racr/experimental-admission';
export const PREIMAGE='https://haili.app/ns/racr/experimental-preimage';
export type CandidateKind='body'|'descriptor'|'portable'|'managed';
export const contentType=(kind:CandidateKind)=>kind==='body'?'application/hail-body+cbor':kind==='descriptor'?'application/hail-envelope+cbor':`application/hail-${kind}-snapshot+json;version=${kind==='portable'?7:8}`;
export const cbor=(value:unknown)=>encode(value,rfc8949EncodeOptions);
export const hash=(bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest());
export const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex');
const equal=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const bytes=(value:unknown):Uint8Array=>{if(!(value instanceof Uint8Array))throw Error('expected bytes');return value;};
const fail=()=>{throw Error('invalid candidate profile');};
export function parse(bytes:Uint8Array,maximumBytes=16_384):unknown {
 assertCborResourceLimits(bytes,{maximumBytes,maximumDepth:8,maximumItems:256,maximumArrayLength:8,maximumMapEntries:8,maximumTextBytes:1024,maximumByteStringLength:maximumBytes},{allowedTags:new Set([18])});
 const value=decode(bytes,{useMaps:true,strict:true,allowIndefinite:false,allowUndefined:false,allowNaN:false,allowInfinity:false,allowBigInt:false,rejectDuplicateMapKeys:true,tags:Tagged.preserve(18)});
 if(!equal(cbor(value),bytes))throw Error('noncanonical candidate');
 return value;
}
export function makeCandidate(kind:CandidateKind,preimage:Uint8Array,kid:string,key:KeyObject){
 const protectedMap=new Map<number|string,unknown>([[1,-19],[4,new TextEncoder().encode(kid)],[258,-16],[259,contentType(kind)]]);
 const unprotected=new Map<string,Uint8Array>();
 let digest:Uint8Array=hash(preimage);
 if(kind==='body'){
  const envelope=decodePayload('hail.envelope',preimage);
  digest=envelope.body.digest.value;
  const metadata=structuredClone(envelope) as unknown as Record<string,HailValue>;
  delete (metadata.body as Record<string,HailValue>).digest;
  protectedMap.set(2,[ADMISSION]);protectedMap.set(ADMISSION,encodeDeterministic(metadata));
 }else unprotected.set(PREIMAGE,preimage);
 const protectedBytes=cbor(protectedMap),signatureInput=cbor(['Signature1',protectedBytes,new Uint8Array(),digest]);
 const signature=new Uint8Array(sign(null,signatureInput,key));
 return {wire:cbor(new Tagged(18,[protectedBytes,unprotected,digest,signature])),signatureInput,protectedBytes,digest};
}
// The trusted key and expected kind are caller inputs, never learned from a peer's header.
export function verifyCandidate(kind:CandidateKind,wire:Uint8Array,publicKey:KeyObject,expectedKid:string):Uint8Array {
 const maximum=kind==='portable'||kind==='managed'?67_109_888:17_408;
 const tagged=parse(wire,maximum);
 if(!(tagged instanceof Tagged)||tagged.tag!==18||!Array.isArray(tagged.value)||tagged.value.length!==4)return fail();
 const [p,u,d,s]=tagged.value as unknown[],protectedBytes=bytes(p),digest=bytes(d),signature=bytes(s);
 const headers=parse(protectedBytes,kind==='body'?16_384:1024);
 if(!(headers instanceof Map)||!(u instanceof Map)||digest.length!==32||signature.length!==64)return fail();
 const expectedKeys=kind==='body'?[1,2,4,258,259,ADMISSION]:[1,4,258,259];
 if(headers.size!==expectedKeys.length||expectedKeys.some(k=>!headers.has(k))||headers.get(1)!==-19||headers.get(258)!==-16||headers.get(259)!==contentType(kind))return fail();
 if(!equal(bytes(headers.get(4)),new TextEncoder().encode(expectedKid)))return fail();
 if(!verify(null,cbor(['Signature1',protectedBytes,new Uint8Array(),digest]),publicKey,signature))throw Error('invalid signature');
 let preimage:Uint8Array;
 if(kind==='body'){
  if(u.size!==0||JSON.stringify(headers.get(2))!==JSON.stringify([ADMISSION]))return fail();
  const metadata=decodeDeterministic(bytes(headers.get(ADMISSION))) as Record<string,HailValue>;
  const body=metadata.body;
  if(!body||Array.isArray(body)||typeof body!=='object'||body instanceof Uint8Array||'digest' in body)return fail();
  (body as Record<string,HailValue>).digest={algorithm:'sha-256',value:digest};
  preimage=encodePayload('hail.envelope',metadata as unknown as HailEnvelope);
 }else{
  if(u.size!==1||!u.has(PREIMAGE))return fail();
  preimage=bytes(u.get(PREIMAGE));
  if(preimage.length>(kind==='descriptor'?16_384:67_108_864))return fail();
  if(!equal(hash(preimage),digest))throw Error('preimage mismatch');
 }
 if(kind==='body'||kind==='descriptor'){
  const envelope=decodePayload('hail.envelope',preimage);
  if(expectedKid!==envelope.from+'#hail-messaging')return fail();
 }else{
  // Only linkage for the experiment: production snapshot schema, custody and
  // live cutover gates remain mandatory and are not implemented by this helper.
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(preimage));
  if(manifest.version!==(kind==='portable'?7:8)||expectedKid!==manifest.did+'#hail-messaging')return fail();
 }
 return preimage;
}
export function publicKey(rawHex:string){return createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(rawHex,'hex')])});}
