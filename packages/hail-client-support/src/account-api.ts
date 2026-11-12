import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { decodeBase64Url, encodeBase64Url, inspectSignedPayload, fromDiagnosticJson, type DiagnosticJson, type HailGrant, type HailSenderProfile } from "@racrproto/codec";
import { privateFile } from "./private-files.js";
import { ClientError } from "./client-error.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "./managed-profile.js";

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_RESPONSE = 524_288;
export const ACCOUNT_API_SCOPES = ["account:read", "grants:read", "grants:write", "credentials:write", "messages:read", "messages:write", "account:write"] as const;
export type AccountApiScope = typeof ACCOUNT_API_SCOPES[number];
export function credentialScopes(value: unknown): AccountApiScope[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
    value.some(scope => !ACCOUNT_API_SCOPES.includes(scope))) throw new Error("Invalid credential scopes");
  return ACCOUNT_API_SCOPES.filter(scope => value.includes(scope));
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientError("RESPONSE_ERROR", "Provider API returned an invalid object");
  return value as JsonObject;
}

export class AccountApiError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number, readonly code = `HTTP_${status}`) {
    const advice = status === 401 ? "Select a valid credential or explicitly log in; expired/revoked access is terminal" :
      status === 403 ? "The selected credential lacks authority; do not escalate scopes" :
      status === 404 ? "The resource is unavailable to this account" :
      status === 409 ? "Retain the original artifacts; check account fences and conflicting state" :
      status === 429 || status === 503 ? "Retain artifacts and retry the same request after the indicated delay" : "Check the documented request contract";
    super(`Provider API returned HTTP ${status}. ${advice}`);
  }
}

export class AccountApiClient {
  private clientAddress:string|undefined;
  private jmapAccountId:Promise<string>|undefined;
  private constructor(private readonly provider: string, private readonly token: string,
    private readonly accountId: string,private readonly sessionOrigin?:string,private readonly transport=provider) {}

  /**
   * A trusted server acting for a browser (the web client) names the browser's
   * address so provider per-client limits apply to that user rather than to the
   * server itself. Invalid or absent addresses are ignored.
   */
  private withClientAddress(address:string|null|undefined):this{
    this.clientAddress=address&&isIP(address)?address:undefined;
    return this;
  }

  private credentialHeaders():Record<string,string>{
    return {...(this.sessionOrigin?{Cookie:`hail_session=${this.token}`,Origin:this.sessionOrigin}:this.token?{Authorization:`Bearer ${this.token}`}:{}),
      ...(this.clientAddress?{"X-Hail-Trusted-Client-IP":this.clientAddress}:{})};
  }

  /**
   * JMAP request that retries the provider's concurrency refusal: a 429 without
   * Retry-After is returned before any work starts, so repeating it is safe.
   * A 429 with Retry-After (a rate limit) is left to the caller.
   */
  private async jmapRequest(path:string,body?:JsonObject,maxResponse?:number):Promise<JsonObject>{
    for(let attempt=0;;attempt++){
      try{return await this.request(path,body,'',maxResponse);}
      catch(error){
        if(!(error instanceof AccountApiError)||error.status!==429||error.retryAfterSeconds!==undefined||attempt>=3)throw error;
        await new Promise(resolve=>setTimeout(resolve,150*2**attempt+Math.random()*100));
      }
    }
  }

  /** The JMAP account ID, read from the Session once per client. */
  private jmapAccount():Promise<string>{
    this.jmapAccountId??=this.jmapRequest('/.well-known/jmap').then(session=>{
      const accountId=object(session.primaryAccounts)['https://racrproto.com/ns/jmap/account'];
      if(typeof accountId!=='string')throw new AccountApiError(403);
      return accountId;
    }).catch(error=>{this.jmapAccountId=undefined;throw error;});
    return this.jmapAccountId;
  }

  static publicProvider(provider:string){
    const url=new URL(provider);
    if(url.protocol!=="https:"||url.origin!==provider||url.username||url.password||isIP(url.hostname)!==0||!/^[a-z0-9.-]+$/.test(url.hostname))throw new ClientError("USAGE_ERROR","Provider must be a canonical HTTPS DNS origin");
    return new AccountApiClient(provider,"","");
  }

  static signup(provider: string, token: string) {
    const url=new URL(provider);
    if(url.protocol!=="https:"||url.origin!==provider||url.username||url.password||url.search||url.hash||isIP(url.hostname)!==0||!/^[a-z0-9.-]+$/.test(url.hostname)||!/^racr_[A-Za-z0-9_-]{43}$/.test(token))throw new Error("Invalid signup origin or token");
    return new AccountApiClient(provider,token,"");
  }

  static fromSession(provider:string,token:string,origin=provider,transport=provider,clientAddress?:string|null){
    const url=new URL(provider);
    if(url.origin!==provider||url.username||url.password||url.search||url.hash||
      url.protocol!=="https:"&&!(url.protocol==="http:"&&url.hostname==="localhost")||
      !/^hails_[A-Za-z0-9_-]{43}$/.test(token))throw new Error("Invalid session origin or token");
    const originUrl=new URL(origin);
    if(originUrl.origin!==origin||originUrl.protocol!=="https:"&&!(originUrl.protocol==="http:"&&originUrl.hostname==="localhost"))
      throw new Error("Invalid session browser origin");
    // Explicit private Docker transport only; provider and passkey origins remain canonical.
    const transportUrl=new URL(transport);
    if(transportUrl.origin!==transport||transportUrl.protocol!=="https:"&&!(transportUrl.protocol==="http:"&&transportUrl.hostname==="localhost")&&transport!=="http://provider:3000")
      throw new Error("Invalid account API transport");
    return new AccountApiClient(provider,token,"",origin,transport).withClientAddress(clientAddress);
  }

  static async fromCredentialFile(path: string, selection: { provider?: string | undefined; accountId?: string | undefined;
    transport?:string|undefined; clientAddress?:string|null|undefined } = {}): Promise<AccountApiClient> {
    const record = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(path, 16_384))));
    if (record.type !== "racr.api-credential" || record.version !== 1 ||
      typeof record.provider !== "string" || typeof record.token !== "string" ||
      !/^racr_[A-Za-z0-9_-]{43}$/.test(record.token) || typeof record.accountId !== "string" || !UUID.test(record.accountId)) {
      throw new Error("Invalid racr credential file");
    }
    const url = new URL(record.provider);
    if (url.protocol !== "https:" || url.origin !== record.provider || url.username || url.password ||
      url.search || url.hash || isIP(url.hostname) !== 0 || !/^[a-z0-9.-]+$/.test(url.hostname)) {
      throw new Error("Credential provider must be a canonical HTTPS DNS origin");
    }
    if (selection.provider !== undefined && selection.provider !== record.provider ||
      selection.accountId !== undefined && selection.accountId !== record.accountId) {
      throw new ClientError("SELECTION_MISMATCH", "Selected provider/account does not match the private credential; select a matching credential file");
    }
    const transport=selection.transport??record.provider,transportUrl=new URL(transport);
    if(transportUrl.origin!==transport||transportUrl.protocol!=="https:"&&!(transportUrl.protocol==="http:"&&transportUrl.hostname==="localhost")&&transport!=="http://provider:3000")
      throw new Error("Invalid account API transport");
    return new AccountApiClient(record.provider, record.token, record.accountId,undefined,transport).withClientAddress(selection.clientAddress);
  }

  async jmap(name:string,args:JsonObject={},maxResponse=40*1024*1024):Promise<JsonObject>{
    const [result]=await this.jmapBatch([[name,args]],maxResponse);
    if(result instanceof AccountApiError)throw result;
    return result!;
  }

  /**
   * Several account methods in one JMAP request: one provider round trip and one
   * authentication instead of one per method. The provider runs them in order.
   * Each entry is that method's result, or its AccountApiError; a malformed
   * response or transport failure rejects the whole batch.
   */
  async jmapBatch(calls:Array<[name:string,args?:JsonObject]>,maxResponse=40*1024*1024):Promise<Array<JsonObject|AccountApiError>>{
    if(calls.length<1||calls.length>16)throw new ClientError('USAGE_ERROR','A JMAP batch has 1 to 16 methods');
    const capability='https://racrproto.com/ns/jmap/account';
    const accountId=await this.jmapAccount();
    const response=await this.jmapRequest('/jmap',{using:['urn:ietf:params:jmap:core',capability],
      methodCalls:calls.map(([name,args],index)=>[name,{...args,accountId},calls.length===1?'account':'account'+index])},maxResponse);
    const responses=response.methodResponses;
    if(!Array.isArray(responses)||responses.length!==calls.length)throw new ClientError('RESPONSE_ERROR','Invalid JMAP response');
    return calls.map(([name],index)=>{
      const call=responses[index];
      if(!Array.isArray(call)||call[2]!==(calls.length===1?'account':'account'+index))throw new ClientError('RESPONSE_ERROR','Invalid JMAP response');
      const result=object(call[1]);
      if(call[0]==='error')return new AccountApiError(typeof result.httpStatus==='number'?result.httpStatus:result.type==='stateMismatch'?409:result.type==='forbidden'?403:result.type==='notFound'?404:result.type==='rateLimit'?429:['serverFail','serverUnavailable'].includes(String(result.type))?503:400,undefined,typeof result.code==='string'?result.code:'JMAP_'+String(result.type));
      if(call[0]!==name||result.accountId!==accountId)throw new ClientError('RESPONSE_ERROR','Invalid JMAP account response');
      return result;
    });
  }

  /** Starts reading the JMAP Session now so a later method call need not wait for it. */
  prepareJmap():void{void this.jmapAccount().catch(()=>{});}

  async uploadAttachment(filename:string,bytes:Uint8Array):Promise<JsonObject>{
    if(bytes.length<1||bytes.length>25*1024*1024)throw new Error('Invalid attachment size');
    const accountId=await this.jmapAccount();
    const response=await fetch(`${this.transport}/jmap/upload/${encodeURIComponent(accountId)}`,{
      method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60_000),
      headers:{...this.credentialHeaders(),
        'Content-Type':'application/octet-stream','Accept-Encoding':'identity'},body:Uint8Array.from(bytes)});
    if(!response.ok){await response.body?.cancel();throw new AccountApiError(response.status);}
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing upload response');
    let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;
      if(size>16384)throw new Error('Upload response too large');text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const uploaded=object(JSON.parse(text));
    if(uploaded.accountId!==accountId||typeof uploaded.blobId!=='string'||uploaded.size!==bytes.length)throw new Error('Invalid upload response');
    return this.jmap('HailAttachment/import',{filename,blobId:uploaded.blobId});
  }

  async attachment(path:string):Promise<Response>{
    if(!/^\/attachments\/[^/]+\/[^/]+\/[A-Za-z0-9_-]{43}(?:\?index=(?:[0-9]|1[0-9]))?$/.test(path))throw new Error('Invalid attachment path');
    const response=await fetch(`${this.transport}/api/v1/account${path}`,{redirect:'error',signal:AbortSignal.timeout(60_000),headers:{
      ...this.credentialHeaders(),
      'Accept-Encoding':'identity'}});
    if(!response.ok){await response.body?.cancel();throw new AccountApiError(response.status);}
    const length=Number(response.headers.get('Content-Length'));
    if(!Number.isSafeInteger(length)||length<1||length>25*1024*1024||response.headers.has('Content-Encoding')){await response.body?.cancel();throw new Error('Invalid attachment response');}
    if(!['application/pdf','text/plain','image/png','image/jpeg','image/webp'].includes(response.headers.get('Content-Type')??'')||!response.headers.get('Content-Disposition')?.startsWith('attachment;')){
      await response.body?.cancel();throw new Error('Invalid attachment download headers');
    }
    let received=0;
    const bounded=response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform(chunk,controller){received+=chunk.length;if(received>length)throw new Error('Attachment response exceeds declared length');controller.enqueue(chunk);},
      flush(){if(received!==length)throw new Error('Attachment response interrupted');}
    }));
    if(!bounded)throw new Error('Missing attachment bytes');
    return new Response(bounded,{headers:response.headers});
  }

  async request(path: string, bytes?: Uint8Array | JsonObject, namespace = "/api/v1/account",maxResponse=namespace==="/api/v1/account"&&path.startsWith("/connection-threads/")?192*1024*1024:namespace==="/api/v1/account"&&/^\/(?:inbox|sent|conversations)(?:\/|$)/.test(path)?40*1024*1024:MAX_RESPONSE, signal?: AbortSignal): Promise<JsonObject> {
    const headers: Record<string, string> = { ...this.credentialHeaders(),
      Accept: "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-store" };
    if (bytes) headers["Content-Type"] = bytes instanceof Uint8Array ? 'application/cose; cose-type="cose-sign1"' : "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.transport}${namespace}${path}`, {
        method: bytes ? bytes instanceof Uint8Array ? "PUT" : "POST" : "GET", headers, redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), ...(bytes ? { body: bytes instanceof Uint8Array ? Uint8Array.from(bytes) : JSON.stringify(bytes) } : {}),
      });
    } catch { throw new ClientError("TRANSPORT_ERROR", "Provider API transport failed; check connectivity/HTTPS trust and retain exact retry artifacts"); }
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      let seconds: number | undefined;
      if (retry !== null) {
        const delay = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        if (Number.isFinite(delay) && delay >= 0) seconds = Math.min(delay, 300);
      }
      void response.body?.cancel(); throw new AccountApiError(response.status, seconds, (()=>{
        const code=response.headers.get("Hail-Error-Code");
        const statuses:Record<string,number>={CREDENTIAL_EXPIRED:401,CREDENTIAL_REVOKED:401,MISSING_SCOPE:403,PASSKEY_REQUIRED:403,APPROVAL_EXPIRED:410};
        return code&&statuses[code]===response.status?code:`HTTP_${response.status}`;
      })());
    }
    const length = response.headers.get("Content-Length");
    if (response.headers.get("Content-Type") !== "application/json" || response.headers.has("Content-Encoding") ||
      response.headers.has("Location") || length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponse)) {
      void response.body?.cancel();
      throw new ClientError("RESPONSE_ERROR", "Provider API returned an invalid response representation");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ClientError("RESPONSE_ERROR", "Provider API returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maxResponse) throw new ClientError("RESPONSE_ERROR", "Provider API response exceeded its limit");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ClientError) throw error;
      throw new ClientError("TRANSPORT_ERROR", "Provider response was interrupted; retain exact retry artifacts");
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all))); }
    catch { throw new ClientError("RESPONSE_ERROR", "Provider API returned invalid JSON"); }
  }

  /**
   * One bundled image of a visible message, by the digest a presentation view
   * returned for it. The bytes are verified against that digest.
   */
  async messageImage(sender:string,messageId:string,digest:string):Promise<{mediaType:"image/png"|"image/jpeg";bytes:Uint8Array}>{
    if(!/^did:plc:[a-z2-7]{24}$/.test(sender)||!UUID.test(messageId)||!/^[A-Za-z0-9_-]{43}$/.test(digest))throw new ClientError("USAGE_ERROR","Invalid message image reference");
    let response:Response;
    try{
      response=await fetch(`${this.transport}/api/v1/account/images/${encodeURIComponent(sender)}/${messageId}/${digest}`,{
        method:"GET",redirect:"error",credentials:"omit",signal:AbortSignal.timeout(20_000),
        headers:{...this.credentialHeaders(),Accept:"image/png, image/jpeg","Accept-Encoding":"identity","Cache-Control":"no-store"}});
    }catch{throw new ClientError("TRANSPORT_ERROR","Provider API transport failed; check connectivity/HTTPS trust and retain exact retry artifacts");}
    if(!response.ok){
      const retry=response.headers.get("Retry-After");
      void response.body?.cancel();throw new AccountApiError(response.status,retry!==null&&/^\d+$/.test(retry)?Math.min(Number(retry),300):undefined);
    }
    const mediaType=response.headers.get("Content-Type"),length=Number(response.headers.get("Content-Length"));
    if(mediaType!=="image/png"&&mediaType!=="image/jpeg"||response.headers.has("Content-Encoding")||!Number.isSafeInteger(length)||length<1||length>524_288){
      void response.body?.cancel();throw new ClientError("RESPONSE_ERROR","Provider returned an invalid image representation");
    }
    const bytes=new Uint8Array(await response.arrayBuffer());
    const actual=encodeBase64Url(new Uint8Array(createHash("sha256").update(bytes).digest()));
    if(bytes.length!==length||actual!==digest)throw new ClientError("RESPONSE_ERROR","Provider image bytes do not match their digest");
    return {mediaType,bytes};
  }

  async account() {
    const result = await this.request("");
    const publicKey = (value: unknown) => value === null || typeof value === "string" &&
      value.length <= 256 && /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value);
    if (result.type !== "racr.account" || result.version !== 1 || result.provider !== this.provider ||
      typeof result.accountId!=="string"||(this.accountId!==""?result.accountId!==this.accountId:
        this.sessionOrigin!==undefined&&!UUID.test(result.accountId))||
      typeof result.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(result.did) ||
      (result.addressReleased!==undefined&&typeof result.addressReleased!=="boolean") ||
      typeof result.address !== "string" || result.address.length > 254 ||
      ![null, "fenced", "exported", "retired"].includes(result.migrationState as null | string) ||
      !["owner-controlled", "managed", "custodial-poc", "unknown"].includes(result.custodyProfile as string) ||
      (result.custodyProfile === "managed" && ["strict-public-v1", "reduced-assurance-alpha-v1"].includes(result.monitorVerificationMode as string) &&
        result.managedProfileVersion !== MANAGED_CUSTODY_PROFILE_VERSION) ||
      (result.monitorVerificationMode === "reduced-assurance-alpha-v1" && result.custodyProfile !== "managed") ||
      (result.custodyProfile !== "managed" && result.managedProfileVersion !== null && result.managedProfileVersion !== undefined) ||
      (result.managedProfileVersion !== undefined && result.managedProfileVersion !== null &&
        result.managedProfileVersion !== MANAGED_CUSTODY_PROFILE_VERSION) ||
      !publicKey(result.identityPublicKey) || !publicKey(result.ownerRecoveryPublicKey) ||
      ![null, "independent", "poc-local", "strict-public-v1", "reduced-assurance-alpha-v1"].includes(result.monitorVerificationMode as null | string) ||
       !Array.isArray(result.scopes) || !result.scopes.every(scope => ACCOUNT_API_SCOPES.includes(scope))) {
      throw new ClientError("RESPONSE_ERROR", "Provider account does not match the credential or API contract");
    }
    let credential: { credentialId: string; expiresAt: string } | null = null;
    if (result.credential !== undefined) {
      const metadata = object(result.credential);
      if (typeof metadata.credentialId !== "string" || !UUID.test(metadata.credentialId) ||
        typeof metadata.expiresAt !== "string" || !Number.isFinite(Date.parse(metadata.expiresAt))) {
        throw new ClientError("RESPONSE_ERROR", "Provider returned invalid current credential metadata");
      }
      credential = { credentialId: metadata.credentialId, expiresAt: metadata.expiresAt };
    }
    return { providerOperator:result.providerOperator===true, provider: this.provider, accountId: result.accountId, did: result.did, address: result.address, addressReleased:result.addressReleased===true,
      migrationState: result.migrationState, custodyProfile: result.custodyProfile, scopes: result.scopes,
      monitorVerificationMode: result.monitorVerificationMode, identityPublicKey: result.identityPublicKey,
      ownerRecoveryPublicKey: result.ownerRecoveryPublicKey, managedProfileVersion: result.managedProfileVersion ?? null, credential };
  }

  async grant(id: string): Promise<{ representation: Uint8Array; payload: HailGrant; localRole: "grantor" | "grantee"; digest: string }> {
    if (!GRANT_ID.test(id)) throw new Error("Grant ID must be a canonical UUIDv7");
    const result = await this.jmap("HailGrant/read",{grantId:id});
    if (result.type !== "racr.grant" || result.version !== 1 ||
      typeof result.cose !== "string" || result.cose.length > 349_528 || typeof result.digest !== "string" ||
      !["grantor", "grantee"].includes(result.localRole as string)) throw new ClientError("RESPONSE_ERROR", "Invalid provider Grant response");
    const representation = decodeBase64Url(result.cose);
    const payload = inspectSignedPayload("hail.grant", representation).payload;
    const digest = encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if (payload.grant_id !== id || digest !== result.digest) throw new ClientError("RESPONSE_ERROR", "Provider Grant bytes or ID do not match");
    return { representation, payload, localRole: result.localRole as "grantor" | "grantee", digest };
  }

  async submit(representation: Uint8Array) {
    if (representation.length > 262_144) throw new Error("Signed Grant exceeds its limit");
    const payload = inspectSignedPayload("hail.grant", representation).payload;
    const result = await this.jmap("HailGrant/submit",{grantId:payload.grant_id,cose:encodeBase64Url(representation)});
    const digest = encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if (result.grantId !== payload.grant_id || result.revision !== payload.revision || result.status !== payload.status ||
      result.digest !== digest || result.publication !== "durable") throw new ClientError("RESPONSE_ERROR", "Provider did not acknowledge the exact signed Grant");
    return { grantId: payload.grant_id, revision: payload.revision, status: payload.status, digest, publication: "durable" };
  }

  async profile():Promise<{representation:Uint8Array;payload:HailSenderProfile;digest:string}>{
    return this.profileResponse(await this.request("/profile"));
  }

  async senderProfile(did:string):Promise<{representation:Uint8Array;payload:HailSenderProfile;digest:string}>{
    if(!/^did:plc:[a-z2-7]{24}$/.test(did))throw new Error("Sender DID must be canonical");
    const result=await this.request(`/senders/${encodeURIComponent(did)}/profile`);
    if(result.type!=="racr.verified-sender-profile"||result.version!==1||result.did!==did)
      throw new ClientError("RESPONSE_ERROR","Invalid verified Sender Profile response");
    const profile=this.profileResponse(result,"racr.verified-sender-profile");
    if(profile.payload.did!==did)throw new ClientError("RESPONSE_ERROR","Verified Sender Profile names another DID");
    return profile;
  }

  async saveProfile(definition:JsonObject,expectedRevision:number){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error("Expected Sender Profile revision must be non-negative");
    return this.profileResponse(await this.request("/profile",{definition,expectedRevision}));
  }

  private profileResponse(result:JsonObject,responseType="racr.sender-profile"){
    if(result.type!==responseType||result.version!==1||typeof result.cose!=="string"||
      result.cose.length>349_528||typeof result.digest!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(result.digest)||
      !Number.isSafeInteger(result.revision))throw new ClientError("RESPONSE_ERROR","Invalid provider Sender Profile response");
    const representation=decodeBase64Url(result.cose),payload=inspectSignedPayload("hail.sender-profile",representation).payload;
    const digest=encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if(payload.revision!==result.revision||digest!==result.digest)throw new ClientError("RESPONSE_ERROR","Provider Sender Profile bytes do not match");
    return {representation,payload,digest};
  }

  async propose(sender: string, category: string|string[] | null, expiresAt: number | null): Promise<HailGrant> {
    const result = await this.jmap("HailGrant/propose",{input:Array.isArray(category)?{sender,scope:{type:"categories",values:[...category].sort()},expiresAt}:{sender,category,expiresAt}});
    if (result.type !== "racr.grant-proposal" || result.version !== 1) throw new ClientError("RESPONSE_ERROR", "Invalid Grant proposal");
    return fromDiagnosticJson("hail.grant", result.grant as DiagnosticJson);
  }
}
