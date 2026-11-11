import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseRetrievalSignature,signRetrievalRequest} from '../src/http/retrieval-signature.js';
const recipient=`did:plc:${'b'.repeat(24)}`,token=Buffer.alloc(32,7).toString('base64url'),nonce=Buffer.alloc(32,8).toString('base64url');
const request=()=>new Request(`https://sender.example/hail/bodies/${Buffer.alloc(32,9).toString('base64url')}`,{headers:{Authorization:`Bearer ${token}`}});
const seed=Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex');
const pkcs8=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]);
const nodeKey=createPrivateKey({key:pkcs8,format:'der',type:'pkcs8'});
const privateKey=crypto.subtle.importKey('pkcs8',pkcs8,'Ed25519',false,['sign']);
const parameters=`("@method" "@target-uri" "authorization");created=1800000000;expires=1800000060;nonce="${nonce}";keyid="${recipient}#hail-messaging";alg="ed25519";tag="hail-retrieval-v1"`;
const expectedBase=`"@method": GET\n"@target-uri": ${request().url}\n"authorization": Bearer ${token}\n"@signature-params": ${parameters}`;
describe('RFC 9421 canonical retrieval profile',()=>{
  it('matches independently assembled signature-base bytes and Node Ed25519',async()=>{
    const signed=await signRetrievalRequest(request(),recipient,await privateKey,1800000000,nonce);
    const vector=await Bun.file(new URL('../../../spec/vectors/retrieval-signature.json',import.meta.url)).json();
    expect(vector.signatureBase).toBe(expectedBase);
    expect(vector.signature).toBe(signed.headers.get('signature'));
    expect(vector.signatureInput).toBe(signed.headers.get('signature-input'));
    expect(signed.headers.get('signature-input')).toBe(`hail=${parameters}`);
    const expected=sign(null,Buffer.from(expectedBase),nodeKey);
    expect(signed.headers.get('signature')).toBe(`hail=:${expected.toString('base64')}:`);
    const parsed=parseRetrievalSignature(signed,recipient,signed.url,1800000000)!;
    expect(new TextDecoder().decode(parsed.bytes)).toBe(expectedBase);
    expect(verify(null,parsed.bytes,createPublicKey(nodeKey),parsed.signature)).toBe(true);
  });
  it('enforces the exact covered components, parameters and canonical structured fields',async()=>{
    const signed=await signRetrievalRequest(request(),recipient,await privateKey,1800000000,nonce);
    for(const change of [
      (v:string)=>v+', '+v,
      (v:string)=>v+';created=1800000000',
      (v:string)=>v.replace('"authorization"','"accept"'),
      (v:string)=>v.replace('"@method"','"@method";req'),
      (v:string)=>v.replace('ed25519','rsa-pss-sha512'),
      (v:string)=>v.replace('expires=1800000060','expires=1800000600'),
      (v:string)=>v.replace('hail-retrieval-v1','different-protocol'),
      (v:string)=>v+';extra="unknown"',
    ]){
      const r=new Request(signed);r.headers.set('signature-input',change(signed.headers.get('signature-input')!));
      expect(parseRetrievalSignature(r,recipient,r.url,1800000000)).toBeNull();
    }
    const duplicate=new Request(signed);duplicate.headers.append('signature',signed.headers.get('signature')!);
    expect(parseRetrievalSignature(duplicate,recipient,duplicate.url,1800000000)).toBeNull();
  });
  it('accepts only the defined clock window and binds target and token changes',async()=>{
    const signed=await signRetrievalRequest(request(),recipient,await privateKey,1800000000,nonce);
    for(const now of [1799999969,1800000091]) expect(parseRetrievalSignature(signed,recipient,signed.url,now)).toBeNull();
    for(const now of [1799999970,1800000090]) expect(parseRetrievalSignature(signed,recipient,signed.url,now)).not.toBeNull();
    const changed=new Request(signed);changed.headers.set('authorization',`Bearer ${Buffer.alloc(32,1).toString('base64url')}`);
    for(const r of [changed,new Request(signed.url+'/attachments/'+Buffer.alloc(32,1).toString('base64url'),signed)]){
      const proof=parseRetrievalSignature(r,recipient,r.url,1800000000)!;
      expect(verify(null,proof.bytes,createPublicKey(nodeKey),proof.signature)).toBe(false);
    }
  });
});
