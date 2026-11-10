// Deterministic evaluation artifacts, never production credentials or formats.
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {decodePayload} from '../src/index.js';
import {makeCandidate,verifyCandidate,hex} from '../test/rfc9995-candidates.js';
const root=new URL('../../../',import.meta.url);
const load=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const seed=Buffer.alloc(32,99),key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed])});
const pub=createPublicKey(key),publicKeyHex=pub.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
const records=[];
// Compare candidates with current production fixtures; no old-format readers.
for(const filename of ['v0.json','connections-draft.json','threads-v3.json','conversations-v1.json']){
 const source='packages/hail-codec-ts/vectors/'+filename,vectors=await load(source);
 for(const v of vectors.positive.filter((v:{type:string})=>v.type==='hail.envelope')){
  const descriptor=Buffer.from(v.payload_hex,'hex'),envelope=decodePayload('hail.envelope',descriptor),kid=envelope.from+'#hail-messaging';
  for(const kind of ['body','descriptor'] as const){
   const candidate=makeCandidate(kind,descriptor,kid,key);
   verifyCandidate(kind,candidate.wire,pub,kid);
   records.push({id:kind+'-'+v.id,kind,kid,source,sourceId:v.id,
    preimageHex:hex(descriptor),wireHex:hex(candidate.wire),signatureInputHex:hex(candidate.signatureInput),
    currentWireBytes:Buffer.from(v.cose_sign1_hex,'hex').length,candidateWireBytes:candidate.wire.length,protectedBytes:candidate.protectedBytes.length});
  }
 }
}
for(const kind of ['portable','managed'] as const){
 const path='spec/vectors/'+kind+'-history.json',v=await load(path),raw=Buffer.from(v.manifestBase64,'base64url');
 const kid=JSON.parse(raw.toString()).did+'#hail-messaging',candidate=makeCandidate(kind,raw,kid,key);
 verifyCandidate(kind,candidate.wire,pub,kid);
 records.push({id:kind+'-snapshot',kind,kid,source:path,preimageHex:hex(raw),wireHex:hex(candidate.wire),signatureInputHex:hex(candidate.signatureInput),
  currentWireBytes:Buffer.byteLength(JSON.stringify({type:`hail.${kind}-migration-transfer`,version:kind==='portable'?7:8,manifest:v.manifestBase64,digest:Buffer.from(v.digestHex,'hex').toString('base64url'),signature:Buffer.from(v.signatureHex,'hex').toString('base64url'),sourceMessagingPublicKey:v.sourceMessagingPublicKey})),candidateWireBytes:candidate.wire.length,protectedBytes:candidate.protectedBytes.length,
  rawManifestBytes:raw.length,currentSignatureBytes:Buffer.from(v.signatureHex,'hex').length,currentDigestBytes:32});
}
await writeFile(new URL('spec/vectors/experimental-rfc9995.json',root),JSON.stringify({status:'experimental; not accepted by production; keys are public test material',seedHex:hex(seed),publicKeyHex,records},null,2)+'\n');
for(const r of records)console.log(`${r.id}: current=${r.currentWireBytes??'see snapshot carrier'} candidate=${r.candidateWireBytes} protected=${r.protectedBytes}`);
