import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {decode,encode,Tagged,rfc8949EncodeOptions} from 'cborg';
import {inspectSignedPayload,verifySignedPayload,inspectHashEnvelope,HASH_ENVELOPE_PREIMAGE} from '../src/index.js';
const vectors=JSON.parse(readFileSync(new URL('../vectors/v0.json',import.meta.url),'utf8'));
const current=Buffer.from(vectors.positive.find((v:any)=>v.type==='hail.envelope').cose_sign1_hex,'hex');
const ct='application/hail-envelope+cbor';
function mutate(change:(a:any[])=>void){
 const t=decode(current,{useMaps:true,tags:Tagged.preserve(18)}) as Tagged;change(t.value as any[]);return encode(t,rfc8949EncodeOptions);
}
describe('production RFC 9995 envelope cutover',()=>{
 it('accepts only the protocol namespace, rejecting the old label and ambiguous maps',()=>{
  expect(HASH_ENVELOPE_PREIMAGE).toBe('https://racrproto.com/ns/racr/preimage');
  for(const label of ['https://haili.app/ns/racr/preimage','https://other.example/ns/racr/preimage']){
   expect(()=>inspectSignedPayload('hail.envelope',mutate(a=>a[1].set(label,a[1].get(HASH_ENVELOPE_PREIMAGE))))).toThrow();
   expect(()=>inspectSignedPayload('hail.envelope',mutate(a=>{a[1].set(label,a[1].get(HASH_ENVELOPE_PREIMAGE));a[1].delete(HASH_ENVELOPE_PREIMAGE);}))).toThrow();
  }
 });
 it('authenticates the descriptor before exposing metadata or invoking key verification',async()=>{
  const tampered=mutate(a=>{const p=a[1].get(HASH_ENVELOPE_PREIMAGE).slice();p[p.length-1]^=1;a[1].set(HASH_ENVELOPE_PREIMAGE,p);});
  const verifier={verify:vi.fn(async()=>true)};
  await expect(verifySignedPayload('hail.envelope',tampered,verifier)).rejects.toThrow(/digest/);
  expect(verifier.verify).not.toHaveBeenCalled();
 });
 it.each([
  (a:any[])=>a[1].clear(),
  (a:any[])=>a[1].set('unexpected',true),
  (a:any[])=>{const h=decode(a[0],{useMaps:true});h.set(3,ct);a[0]=encode(h,rfc8949EncodeOptions);},
  (a:any[])=>{const h=decode(a[0],{useMaps:true});h.set(260,'https://example.com/');a[0]=encode(h,rfc8949EncodeOptions);},
  (a:any[])=>{const h=decode(a[0],{useMaps:true});h.set(258,-44);a[0]=encode(h,rfc8949EncodeOptions);},
  (a:any[])=>{const h=decode(a[0],{useMaps:true});h.set(259,'application/hail-body+cbor');a[0]=encode(h,rfc8949EncodeOptions);},
  (a:any[])=>{const h=decode(a[0],{useMaps:true});h.set(4,new TextEncoder().encode(inspectSignedPayload('hail.envelope',current).keyId.replace('messaging','identity')));a[0]=encode(h,rfc8949EncodeOptions);},
 ])('rejects incomplete or ambiguous carrier %#',change=>{
  expect(()=>inspectSignedPayload('hail.envelope',mutate(change))).toThrow();
 });
 it('keeps envelope identity equal to the descriptor digest, with explicit bounds',()=>{
  const inspected=inspectSignedPayload('hail.envelope',current),hash=inspectHashEnvelope(current,ct,16384);
  expect(inspected.payloadBytes).toEqual(hash.preimage);
  expect(()=>inspectSignedPayload('hail.envelope',new Uint8Array(17409))).toThrow();
  expect(()=>inspectHashEnvelope(current,ct,100)).toThrow();
 });
});
