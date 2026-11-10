import {readFile} from 'node:fs/promises';
import {verify} from 'node:crypto';
import {expect,it} from 'vitest';
import {Tagged} from 'cborg';
import {decodePayload,encodeDeterministic,decodeDeterministic,inspectSignedPayload} from '../src/index.js';
import {ADMISSION,PREIMAGE,cbor,parse,verifyCandidate,publicKey,type CandidateKind} from './rfc9995-candidates.js';
const vectors=JSON.parse(await readFile(new URL('../../../spec/vectors/experimental-rfc9995.json',import.meta.url),'utf8')) as {publicKeyHex:string;records:{id:string;kind:CandidateKind;kid:string;preimageHex:string;wireHex:string;signatureInputHex:string}[]};
const pub=publicKey(vectors.publicKeyHex);
const raw=(hex:string)=>new Uint8Array(Buffer.from(hex,'hex'));
for(const v of vectors.records){
 const wire=raw(v.wireHex),preimage=raw(v.preimageHex);
 const tagged=()=>parse(wire,67_109_888) as Tagged;
 it('independently authenticates exact preimage without body retrieval: '+v.id,()=>{
  expect(verifyCandidate(v.kind,wire,pub,v.kid)).toEqual(preimage);
  const [p,,d]=tagged().value as Uint8Array[];
  expect(Buffer.from(cbor(['Signature1',p,new Uint8Array(),d])).toString('hex')).toBe(v.signatureInputHex);
  if(v.kind==='body'||v.kind==='descriptor')expect(()=>inspectSignedPayload('hail.envelope',wire)).toThrow();
 });
 it('rejects signature, hash, key and profile substitution: '+v.id,()=>{
  for(const index of [2,3]){
   const t=tagged(),parts=t.value as Uint8Array[];parts[index]![0]!^=1;
   expect(()=>verifyCandidate(v.kind,cbor(t),pub,v.kid)).toThrow();
  }
  for(const [label,value] of [[3,'application/hail-envelope+cbor'],[258,-44],[259,'application/json'],[260,'https://attacker.example/body']] as const){
   const t=tagged(),parts=t.value as unknown[],h=parse(parts[0] as Uint8Array) as Map<number,unknown>;
   h.set(label,value);parts[0]=cbor(h);
   expect(()=>verifyCandidate(v.kind,cbor(t),pub,v.kid)).toThrow();
  }
  expect(()=>verifyCandidate(v.kind,wire,pub,v.kid+'-other')).toThrow();
  expect(()=>verifyCandidate(v.kind,wire,publicKey('00'.repeat(32)),v.kid)).toThrow();
 });
 it('rejects changed metadata or exact manifest bytes: '+v.id,()=>{
  if(v.kind==='body'||v.kind==='descriptor'){
   const original=decodePayload('hail.envelope',preimage);
   // Every admission field is bound, including nested body credentials and
   // authorization, membership, reply and availability structures.
   for(const field of Object.keys(original)){
    const t=tagged(),parts=t.value as unknown[];
    if(v.kind==='body'){
     const h=parse(parts[0] as Uint8Array) as Map<number|string,unknown>;
     const metadata=decodeDeterministic(h.get(ADMISSION) as Uint8Array) as Record<string,unknown>;
     delete metadata[field];h.set(ADMISSION,encodeDeterministic(metadata as never));parts[0]=cbor(h);
    }else{
     const changed={...original} as Record<string,unknown>;delete changed[field];
     (parts[1] as Map<string,unknown>).set(PREIMAGE,encodeDeterministic(changed as never));
    }
    expect(()=>verifyCandidate(v.kind,cbor(t),pub,v.kid),field).toThrow();
   }
  }else{
   for(const changed of [Buffer.concat([preimage,Buffer.from('\n')]),...['did','transferId','destinationServiceBase'].map(field=>{
    const manifest=JSON.parse(Buffer.from(preimage).toString());manifest[field]='substituted';return Buffer.from(JSON.stringify(manifest));
   })]){
    const t=tagged(),parts=t.value as unknown[];
    (parts[1] as Map<string,unknown>).set(PREIMAGE,changed);
    expect(()=>verifyCandidate(v.kind,cbor(t),pub,v.kid)).toThrow('preimage mismatch');
   }
  }
 });
}
it('rejects malformed, noncanonical and oversized candidate carriers',()=>{
 const v=vectors.records[0]!;
 for(const wire of [new Uint8Array(),new Uint8Array(17_409),Buffer.concat([raw(v.wireHex),Buffer.from([0])]),raw(v.wireHex).subarray(1)]){
  expect(()=>verifyCandidate(v.kind,wire,pub,v.kid)).toThrow();
 }
});
it('generic signature verification is possible without preimage, but is never admission',()=>{
 const v=vectors.records.find(v=>v.kind==='descriptor')!;
 const t=parse(raw(v.wireHex)) as Tagged,parts=t.value as unknown[];
 parts[1]=new Map();
 expect(verify(null,cbor(['Signature1',parts[0],new Uint8Array(),parts[2]]),pub,parts[3] as Uint8Array)).toBe(true);
 expect(()=>verifyCandidate(v.kind,cbor(t),pub,v.kid)).toThrow();
 expect(()=>verifyCandidate(v.kind,new Uint8Array(17_409),pub,v.kid)).toThrow('encoded value is too large');
});
