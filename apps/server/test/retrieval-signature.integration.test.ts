import {uuidV7} from "../src/identity/uuid-v7.js";
import {encodePayload} from "@racrproto/codec";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {base58btc} from "multiformats/bases/base58";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {BodyRepository} from "../src/bodies/repository.js";
import {bodyFromText} from "../src/bodies/service.js";
import {registerBodyRoutes} from "../src/bodies/routes.js";
import {BodyRequestVerifier} from "../src/bodies/request-proof.js";
import {signRetrievalRequest} from "../src/http/retrieval-signature.js";
import {ProtectedResponseSchedule} from "../src/http/protected-schedule.js";
import type {HailDidResolver} from "../src/plc/resolver.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration('RFC 9421 retrieval enforcement',()=>{
  let db:ProviderDatabase,admin:SQL;
  const schema=`retrieval_${randomUUID().replaceAll('-','')}`,origin='https://sender.example';
  const recipient=`did:plc:${'b'.repeat(24)}`,sender=`did:plc:${'a'.repeat(24)}`;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${randomUUID()},${randomUUID()},'sender@example.com',${sender},'active',now(),${randomBytes(32)},'public')`;
  });
  afterAll(async()=>{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();});
  async function key(){
    const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
    return {...pair,didKey:`did:key:${base58btc.encode(new Uint8Array([0xed,1,...new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))]))}`};
  }
  async function fixture(attachment=false){
    const pair=await key(),bodies=new BodyRepository(db.sql),data=Buffer.from(randomUUID()),fileDigest=createHash('sha256').update(data).digest();
    let bytes=bodyFromText(randomUUID());
    if(attachment){
      const account=(await db.sql`SELECT id FROM provider_accounts WHERE did=${sender}`)[0]!.id;
      await db.sql`INSERT INTO attachment_blobs(digest,bytes) VALUES(${fileDigest},${data})`;
      await db.sql`INSERT INTO attachment_uploads(account_id,digest) VALUES(${account},${fileDigest})`;
      bytes=encodePayload('hail.body.spt-1',{version:1,profile:'spt-1',blocks:[],attachments:[{filename:'fixture.txt',media_type:'text/plain',size:data.length,digest:{algorithm:'sha-256',value:fileDigest}}]});
    }
    const body=await bodies.publish(sender,bytes),token=randomBytes(32);
    const now=Math.floor(Date.now()/1000);
    await bodies.authorize({senderDid:sender,recipientDid:recipient,messageId:uuidV7(),digest:body.digest,token,availableUntil:now+30*86400,expiresAt:now+31*86400});
    let currentKey=pair.didKey;
    const resolve=vi.fn(async(did:string)=>({did,messagingDidKey:currentKey,identityDidKey:currentKey,serviceBase:'https://recipient.example/hail',evidence:{document:{},data:{},log:[]}}));
    const resolver:HailDidResolver={resolve,resolveForAuthentication:resolve};
    const verifier=new BodyRequestVerifier(db.sql,resolver,origin),app=new Hono();
    registerBodyRoutes(app,bodies,verifier,new ProtectedResponseSchedule({minimumResponseMs:100,processingDeadlineMs:10000,maxInFlight:128,maxPerSource:128}));
    const url=`${origin}/hail/bodies/${Buffer.from(body.digest).toString('base64url')}`;
    const request=()=>new Request(url,{headers:{Authorization:`Bearer ${token.toString('base64url')}`}});
    return {pair,bodies,bytes,body,token,data,fileDigest,resolve,resolver,verifier,app,url,request,
      signed:()=>signRetrievalRequest(request(),recipient,pair.privateKey),rotate:(value:string)=>{currentKey=value;}};
  }
  it('requires both proofs and rejects bad tokens before DID lookup',async()=>{
    const f=await fixture();
    const missing=await f.app.request(f.request());expect(missing.status).toBe(404);expect(f.resolve).not.toHaveBeenCalled();
    const bad=new Request(f.url,{headers:{Authorization:`Bearer ${randomBytes(32).toString('base64url')}`}});
    const refused=await f.app.request(await signRetrievalRequest(bad,recipient,f.pair.privateKey));expect(refused.status).toBe(404);
    expect([...refused.headers]).toEqual([...missing.headers]);expect(await refused.text()).toBe(await missing.text());
    expect(f.resolve).not.toHaveBeenCalled();
    const good=await f.app.request(await f.signed());expect(good.status).toBe(200);
    expect(new Uint8Array(await good.arrayBuffer())).toEqual(Uint8Array.from(f.bytes));
    expect(good.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects wrong recipients, substituted targets, expired and future signatures',async()=>{
    const f=await fixture();
    const wrong=await signRetrievalRequest(f.request(),sender,f.pair.privateKey);
    expect((await f.app.request(wrong)).status).toBe(404);expect(f.resolve).not.toHaveBeenCalled();
    const foreign=await signRetrievalRequest(new Request(f.url.replace(origin,'https://other.example'),f.request()),recipient,f.pair.privateKey);
    expect((await f.app.request(new Request(f.url,foreign))).status).toBe(404);
    for(const offset of [-91,31]){
      const request=await signRetrievalRequest(f.request(),recipient,f.pair.privateKey,Math.floor(Date.now()/1000)+offset);
      expect((await f.app.request(request)).status).toBe(404);
    }
    const tampered=await f.signed();tampered.headers.set('Signature',`hail=:${randomBytes(64).toString('base64')}:`);
    expect((await f.app.request(tampered)).status).toBe(404);
  });
  it('atomically rejects replay across verifier instances and permits fresh retry',async()=>{
    const f=await fixture(),request=await f.signed(),other=new BodyRequestVerifier(db.sql,f.resolver,origin),signal=new AbortController().signal;
    const results=await Promise.all([f.verifier.verify(request,recipient,signal),other.verify(request,recipient,signal)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new BodyRequestVerifier(db.sql,f.resolver,origin).verify(request,recipient,signal)).toBe(false);
    expect((await f.app.request(await f.signed())).status).toBe(200);
    const c=await db.sql.reserve();try{
      await expect(c.unsafe(await Bun.file(new URL('../migrations/rollback/0111_body_request_nonces.sql',import.meta.url)).text())).rejects.toThrow('Unexpired retrieval nonces');
      await c.unsafe('ROLLBACK');
    }finally{c.release();}
  });
  it('rejects removed keys and requires a fresh signature for a changed sender origin',async()=>{
    const f=await fixture(),next=await key();f.rotate(next.didKey);
    expect((await f.app.request(await f.signed())).status).toBe(404);
    expect((await f.app.request(await signRetrievalRequest(f.request(),recipient,next.privateKey))).status).toBe(200);
    const target='https://new-sender.example',verifier=new BodyRequestVerifier(db.sql,f.resolver,target),signal=new AbortController().signal;
    expect(await verifier.verify(await signRetrievalRequest(f.request(),recipient,next.privateKey),recipient,signal)).toBe(false);
    const moved=new Request(f.url.replace(origin,target),f.request());
    expect(await verifier.verify(await signRetrievalRequest(moved,recipient,next.privateKey),recipient,signal)).toBe(true);
  });
  it('requires a separate target-bound signature and nonce for each attachment',async()=>{
    const f=await fixture(true),url=f.url+'/attachments/'+f.fileDigest.toString('base64url');
    const bodyRequest=await f.signed();
    expect((await f.app.request(new Request(url,bodyRequest))).status).toBe(404);
    const attachment=new Request(url,f.request());
    const signed=await signRetrievalRequest(attachment,recipient,f.pair.privateKey);
    const response=await f.app.request(signed);expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.data);
    expect((await f.app.request(signed)).status).toBe(404);
    expect((await f.app.request(await signRetrievalRequest(attachment,recipient,f.pair.privateKey))).status).toBe(200);
  });
  it('discloses unavailable committed bytes only after both proofs pass',async()=>{
    const f=await fixture();await db.sql`UPDATE detached_bodies SET body_bytes=${bodyFromText('corrupt stored representation')} WHERE digest=${f.body.digest}`;
    const unauthenticated=await f.app.request(f.request());expect(unauthenticated.status).toBe(404);
    const authenticated=await f.app.request(await f.signed());expect(authenticated.status).toBe(503);
    expect(authenticated.headers.get('retry-after')).toBe('30');
  });
});
