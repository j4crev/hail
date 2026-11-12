import {MediaTickets,isMediaPath} from './media-tickets.js';
import { CustomDomainAuthorityError } from "./custom-domain-authority.js";
import { decodeBase64Url, encodeBase64Url, encodeDeterministic, fromDiagnosticJson, HailCodecError, inspectSignedPayload, toDiagnosticJson, type DiagnosticJson } from "@racrproto/codec";
import type { Context, Hono } from "hono";
import { isCoseSign1MediaType } from "../http/media-type.js";
import { RECENT_PASSKEY_WINDOW_MS } from "./session-policy.js";
import { GrantConflictError, type GrantRepository } from "../grants/repository.js";
import { UserGrantError, type GrantService } from "../grants/service.js";
import { ALL_ACCOUNT_SCOPES, CredentialConflictError, type AccountApiRepository } from "./repository.js";
import type { AccountMessaging } from "./messaging.js";
import type {AccountPublications} from "./publications.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { BindingError, type AccountBinding } from "./binding.js";
import { AccountTransferError,type AccountTransfer } from "./transfer.js";
import {withServingGeneration} from "../db/serving.js";
import type { SameProviderCustodyTransition } from "./custody-transition.js";
import type { ManagedAccountTransfer } from "./managed-transfer.js";
import { parseSenderProfileDefinition, SenderProfileConflictError, type SenderProfileService } from "../profiles/service.js";
import type { SenderProfileStore, VerifiedSenderProfileStore } from "../profiles/store.js";
import type { SenderProfileVerifier } from "../profiles/verifier.js";
import {getCookie} from "hono/cookie";
import {clientAddress,FixedWindowRateLimit} from "../http/rate-limit.js";

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 262_144;
const MESSAGE_JSON_MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export class RequestBodyTimeout extends Error {}
export async function accountRequestBytes(request: Request,limit=MAX_BYTES,timeoutMs=0): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0,timedOut=false;
  const timer=timeoutMs?setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},timeoutMs):undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally{if(timer)clearTimeout(timer);}
  if(timedOut)throw new RequestBodyTimeout();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function registerAccountApiRoutes(app: Hono, accounts: AccountApiRepository,
  grants: GrantRepository, service: GrantService, provider: string, messaging?:AccountMessaging, binding?:AccountBinding,
  transfer?:AccountTransfer,custodyTransition?:SameProviderCustodyTransition,managedTransfer?:ManagedAccountTransfer,
  profiles?:SenderProfileService,profileVerifier?:Pick<SenderProfileVerifier,"verify">,sessionOrigin?:string,publications?:AccountPublications,
  avatarProfiles?:SenderProfileStore & VerifiedSenderProfileStore): void {
  const mediaTickets=new MediaTickets();
  app.get('/api/v1/media/:ticket',async context=>{
    context.header('Cache-Control','private, no-store');
    context.header('Referrer-Policy','no-referrer');
    const ticket=mediaTickets.read(context.req.param('ticket'));
    if(!ticket||new URL(context.req.url).search)return context.json({error:'Media unavailable'},404);
    const headers=new Headers({'X-Hail-Trusted-Client-IP':clientAddress(context.req.raw)});
    if(ticket.authorization)headers.set('Authorization',ticket.authorization);
    if(ticket.cookie)headers.set('Cookie',ticket.cookie);
    // Re-run normal session, scope, account-generation and resource authorization.
    const response=await app.request(new Request(new URL(ticket.path,provider),{headers}));
    const output=new Headers(response.headers);
    output.delete('Set-Cookie');output.set('Cache-Control','private, no-store');
    output.set('Referrer-Policy','no-referrer');output.set('Content-Security-Policy',"sandbox; default-src 'none'");
    return new Response(response.body,{status:response.status,headers:output});
  });
  const ingress=new FixedWindowRateLimit(),anonymous=new FixedWindowRateLimit(),authenticated=new FixedWindowRateLimit(),mediaIssuance=new FixedWindowRateLimit();
  const handle = async (context: Context, grantId: string | null, action?: string):Promise<Response> => {
    context.header("Cache-Control", "no-store");
    context.header("Vary", "Authorization, Cookie");
    const problem = (status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 503, code?:string) => {
      const title = ({ 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
        405: "Method Not Allowed", 409: "Conflict", 413: "Content Too Large", 415: "Unsupported Media Type",
        429: "Too Many Requests", 503: "Service Unavailable" } as const)[status];
      context.header("Content-Type", "application/problem+json");
      if(code)context.header("Hail-Error-Code",code);
      return context.json({ type: "about:blank", title, status, ...(code?{code}:{}) }, status, { "Content-Type": "application/problem+json" });
    };
    const client=clientAddress(context.req.raw),ingressRetry=ingress.take(client,600);
    if(ingressRetry!==null){context.header("Retry-After",String(ingressRetry));return problem(429);}
    try {
      const session = await accounts.authenticate(context.req.header("Authorization"),getCookie(context,"hail_session"));
      if (!session) {const retry=anonymous.take(client,120);if(retry!==null){context.header("Retry-After",String(retry));return problem(429);}
        context.header("WWW-Authenticate", 'Bearer realm="racr-account"'); return problem(401,await accounts.authenticationFailure?.(context.req.header("Authorization"))); }
      const retry=(action==='media-ticket'?mediaIssuance:authenticated).take(session.account_id,120);if(retry!==null){context.header("Retry-After",String(retry));return problem(429);}
      if(getCookie(context,"hail_session")&&context.req.method!=="GET"&&context.req.method!=="HEAD"&&
        context.req.header("Origin")!==sessionOrigin)return problem(403);
      return await withServingGeneration<Response>(session.account_id,session.serving_generation??1,async():Promise<Response>=>{
      const query = new URL(context.req.url).searchParams;
      if(action==='media-ticket'){
        if(context.req.method!=='POST')return problem(405);
        if(!session.scopes.includes('messages:read'))return problem(403,'MISSING_SCOPE');
        if(context.req.header('Content-Type')!=='application/json'||query.size)return problem(400);
        const bytes=await accountRequestBytes(context.req.raw,2048,5000);if(!bytes)return problem(413);
        let input:unknown;try{input=parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return problem(400);}
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!('path' in input)||typeof input.path!=='string'||!isMediaPath(input.path))return problem(400);
        const token=mediaTickets.issue(input.path,{authorization:context.req.header('Authorization'),
          ...(getCookie(context,'hail_session')?{cookie:`hail_session=${getCookie(context,'hail_session')}`}:{})});
        if(!token)return problem(503);
        return context.json({url:`${provider}/api/v1/media/${token}`,expiresIn:60});
      }
      if(action==='attachment-download'){
        if(!session.scopes.includes('messages:read'))return problem(403,'MISSING_SCOPE');
        if(!messaging)return problem(503);
        if([...query.keys()].some(k=>k!=='index'||query.getAll(k).length!==1)||query.has('index')&&!/^(?:[0-9]|1[0-9])$/.test(query.get('index')!))return problem(400);
        if(context.req.method!=='GET')return problem(405);
        const found=await messaging.attachment(session,context.req.param('sender')!,context.req.param('messageId')!,context.req.param('digest')!,query.has('index')?Number(query.get('index')):undefined);
        if(!found)return problem(404);
        return new Response(Uint8Array.from(found.bytes),{headers:{'Content-Type':found.file.media_type,'Content-Length':String(found.bytes.length),
          'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(found.file.filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,
          'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'private, no-store'}});
      }
      if(action==='message-image'){
        if(!session.scopes.includes('messages:read'))return problem(403,'MISSING_SCOPE');
        if(!messaging)return problem(503);
        if(query.size)return problem(400);
        if(context.req.method!=='GET')return problem(405);
        const found=await messaging.image(session,context.req.param('sender')!,context.req.param('messageId')!,context.req.param('digest')!);
        if(!found)return problem(404);
        return new Response(Uint8Array.from(found.bytes),{headers:{'Content-Type':found.mediaType,'Content-Length':String(found.bytes.length),
          'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'private, no-store'}});
      }
      if (query.size && action !== "credential") return problem(400);
      const method = context.req.method;
      if(action==="sender-avatar"||action==="sender-avatar-image"){
        if(!session.scopes.includes("messages:read"))return problem(403,"MISSING_SCOPE");
        if(method!=="GET")return problem(405);
        const did=grantId!;if(!/^did:plc:[a-z2-7]{24}$/.test(did))return problem(400);
        if(!avatarProfiles)return problem(503);
        // Presentation only: never put PLC/network verification on the page-load path.
        // Prefer the current local profile, including an explicitly removed avatar.
        const local=await avatarProfiles.findCurrentByDid(did);
        const profile=local?local.payload:(await avatarProfiles.getLatestVerifiedSenderProfile(did))?.profile;
        const asset=profile?.version===2?profile.assets?.assets.find(asset=>asset.role==="avatar"):undefined;
        if(action==="sender-avatar-image"){
          if(!asset)return problem(404);
          return new Response(Uint8Array.from(asset.data),{headers:{"Content-Type":"image/png","Cache-Control":"no-store",
            "Vary":"Authorization, Cookie","X-Content-Type-Options":"nosniff"}});
        }
        return context.json({did,avatar:asset?{data:encodeBase64Url(asset.data),width:asset.width,height:asset.height}:null});
      }
      if(action==="sender-profile"){
        if(!session.scopes.includes("messages:read"))return problem(403,"MISSING_SCOPE");
        if(method!=="GET")return problem(405);
        if(!profileVerifier)return problem(503);
        const did=grantId!;if(!/^did:plc:[a-z2-7]{24}$/.test(did))return problem(400);
        const verified=await profileVerifier.verify(did);
        return context.json({type:"racr.verified-sender-profile",version:1,did,revision:verified.profile.revision,digest:encodeBase64Url(verified.digest),
          cose:encodeBase64Url(verified.representation),profile:toDiagnosticJson("hail.sender-profile",verified.profile)});
      }
      if(action==="custody-review-owner"||action==="custody-prepare-owner"||action==="custody-prepare"||action==="custody-commit") {
        if(!session.scopes.includes("account:write"))return problem(403,"MISSING_SCOPE");
        if(!custodyTransition)return problem(503);
        if(action==="custody-prepare"||action==="custody-review-owner"||action==="custody-prepare-owner") {
          if(method!=="POST")return problem(405);
          if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
          const limit=action==="custody-prepare-owner"?8*1024*1024:1024;
          const bytes=await accountRequestBytes(context.req.raw,limit);if(!bytes)return problem(413);
          let input:unknown;try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return problem(400);}
          if(!input||typeof input!=="object"||Array.isArray(input))return problem(400);
          if(action==="custody-review-owner") {
            const value=input as Record<string,unknown>;
            if(Object.keys(value).length!==1||typeof value.newIdentityKey!=="string")return problem(400);
            const reviewed=await custodyTransition.reviewOwner(session.account_id,value.newIdentityKey);
            return context.json({...reviewed,binding:encodeBase64Url(encodeDeterministic(reviewed.binding as never)),
              activeGrants:reviewed.activeGrants.map(grant=>({grantId:grant.grantId,payload:encodeBase64Url(encodeDeterministic(grant.payload as never)),
                predecessorDigest:encodeBase64Url(grant.predecessorDigest),destinationServiceBase:grant.destinationServiceBase}))});
          }
          if(action==="custody-prepare-owner") {
            const value=input as Record<string,unknown>,grants=value.grants;
            if(Object.keys(value).length!==3||typeof value.newIdentityKey!=="string"||typeof value.binding!=="string"||!Array.isArray(grants)||
              grants.some(grant=>!grant||typeof grant!=="object"||Array.isArray(grant)||Object.keys(grant).length!==2||
                typeof (grant as Record<string,unknown>).grantId!=="string"||typeof (grant as Record<string,unknown>).cose!=="string"))return problem(400);
            const prepared=await custodyTransition.prepareOwner(session.account_id,value.newIdentityKey,decodeBase64Url(value.binding),
              (grants as {grantId:string;cose:string}[]).map(grant=>({grantId:grant.grantId,cose:decodeBase64Url(grant.cose)})));
            return context.json({...prepared,historyCheckpointDigest:encodeBase64Url(prepared.historyCheckpointDigest),
              bindingCose:encodeBase64Url(prepared.bindingCose),bindingDigest:encodeBase64Url(prepared.bindingDigest)});
          }
          if(Object.keys(input).length)return problem(400);
          const prepared=await custodyTransition.prepare(session.account_id);
          return context.json({...prepared,historyCheckpointDigest:encodeBase64Url(prepared.historyCheckpointDigest),
            bindingCose:encodeBase64Url(prepared.bindingCose),bindingDigest:encodeBase64Url(prepared.bindingDigest)});
        }
        if(method!=="POST")return problem(405);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
        const bytes=await accountRequestBytes(context.req.raw);if(!bytes||bytes.length>65536)return problem(413);
        let input:Record<string,unknown>;try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;}catch{return problem(400);}
        if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==4||
          Object.keys(input).some(key=>!["transitionId","operation","approval","signature"].includes(key))||
          typeof input.transitionId!=="string"||!UUID.test(input.transitionId)||typeof input.operation!=="string"||
          typeof input.approval!=="string"||typeof input.signature!=="string")return problem(400);
        try {const operation=decodeBase64Url(input.operation),approval=decodeBase64Url(input.approval),signature=decodeBase64Url(input.signature);
          if(encodeBase64Url(operation)!==input.operation||encodeBase64Url(approval)!==input.approval||encodeBase64Url(signature)!==input.signature)return problem(400);
          return context.json(await custodyTransition.commit(session.account_id,input.transitionId,operation,approval,signature));
        } catch(error) {if(error instanceof SyntaxError||error instanceof HailCodecError)return problem(400);throw error;}
      }
      if(action==="transfer-status"||action==="transfer-offer"||action==="transfer-cancel"||action==="transfer-export") {
        if(!session.scopes.includes(action==="transfer-status"?"account:read":"account:write"))return problem(403,"MISSING_SCOPE");
        if(!transfer)return problem(503);
        if(action==="transfer-status"){if(method!=="GET")return problem(405);return context.json(await transfer.status(session));}
        if(method!=="POST")return problem(405);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
        const bytes=await accountRequestBytes(context.req.raw);if(!bytes||bytes.length>16384)return problem(413);
        let input:Record<string,unknown>;try {input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid object");}catch{return problem(400);}
        return context.json(action==="transfer-offer"?await transfer.offer(session,input):action==="transfer-export"?await transfer.exportSnapshot(session,input):await transfer.cancel(session,input));
      }
      if(action==="managed-transfer-status"||action==="managed-transfer-offer"||action==="managed-transfer-export") {
        if(!session.scopes.includes(action==="managed-transfer-status"?"account:read":"account:write"))return problem(403,"MISSING_SCOPE");
        if(!managedTransfer)return problem(503);
        if(action==="managed-transfer-status"){
          if(method!=="GET")return problem(405);return context.json(await managedTransfer.status(session));
        }
        if(method!=="POST")return problem(405);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
        const bytes=await accountRequestBytes(context.req.raw);if(!bytes||bytes.length>16384)return problem(413);
        let input:Record<string,unknown>;try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid object");}catch{return problem(400);}
        return context.json(action==="managed-transfer-export"?await managedTransfer.exportSnapshot(session,input):await managedTransfer.offer(session,input));
      }
      if(action==="binding") {
        if(!session.scopes.includes(method==="GET"?"account:read":"account:write"))return problem(403,"MISSING_SCOPE");
        if(!binding)return problem(503);
        if(method==="GET")return context.json(await binding.show(session));
        if(method!=="POST")return problem(405);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
        const bytes=await accountRequestBytes(context.req.raw);if(!bytes||bytes.length>32768)return problem(413);
        let input:Record<string,unknown>;
        try {input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid object");}catch{return problem(400);}
        return context.json(await binding.publish(session,input));
      }
      if(action==="profile") {
        // Browser profile edits get a narrow, fresh-passkey capability rather
        // than account:write, which also authorizes unrelated account changes.
        const freshBrowserProfile = Boolean(getCookie(context,"hail_session") && session.passkey_credential_id &&
          session.passkey_verified_at && session.passkey_verified_at.getTime() > Date.now()-RECENT_PASSKEY_WINDOW_MS &&
          session.scopes.includes("account:read"));
        if(method==="GET" ? !session.scopes.includes("account:read") :
          !session.scopes.includes("account:write") && !(method==="POST" && freshBrowserProfile))return problem(403);
        if(!profiles)return problem(503);
        if(method==="GET"){
          const current=await profiles.getLatest(session.did);if(!current)return problem(404);
          return context.json({type:"racr.sender-profile",version:1,revision:current.revision,
            digest:encodeBase64Url(current.digest),cose:encodeBase64Url(current.cose),
            profile:toDiagnosticJson("hail.sender-profile",current.payload)});
        }
        if(method!=="POST")return problem(405);if(session.migration_state)return problem(409);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)return problem(415);
        const bytes=await accountRequestBytes(context.req.raw,65536);if(!bytes)return problem(413);
        let input:Record<string,unknown>,definition;
        try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==2||
            !Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw new Error("Invalid profile request");
          definition=parseSenderProfileDefinition(input.definition);
        }catch{return problem(400);}
        // Haili browser publishing keeps General fixed; protocol/API clients
        // with account:write retain support for arbitrary offered categories.
        if(!session.scopes.includes("account:write")){
          const general=definition.categories.filter(category=>category.id==="general");
          if(general.length!==1||general[0]!.label!=="General"||general[0]!.description!==undefined)return problem(400);
        }
        const saved=await profiles.createOrReuse(session.did,definition,Number(input.expectedRevision));
        return context.json({type:"racr.sender-profile",version:1,revision:saved.revision,
          digest:encodeBase64Url(saved.digest),cose:encodeBase64Url(saved.cose),
          profile:toDiagnosticJson("hail.sender-profile",saved.payload)});
      }
      if (!session.scopes.includes(action === "credential" ? "credentials:write" : "account:read")) return problem(403,"MISSING_SCOPE");
      if (action === "credential") {
        if (method === "GET") {
          const after = query.get("after");
          if ([...query.keys()].some(key => key !== "after") || query.getAll("after").length > 1 ||
            after !== null && !UUID.test(after)) return problem(400);
          return context.json(await accounts.listCredentials(session, after));
        }
        if (method !== "POST") return problem(405);
        if (query.size) return problem(400);
        if (session.migration_state) return problem(409);
        if (context.req.header("Content-Type") !== "application/json" || context.req.header("Content-Encoding") !== undefined) return problem(415);
        const bytes=await accountRequestBytes(context.req.raw);if(!bytes||bytes.length>16384)return problem(413);
        let input;
        try { input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>; }
        catch { return problem(400); }
        if (!input || typeof input !== "object" || Array.isArray(input)) return problem(400);
        if (Object.keys(input).length === 1 && typeof input.revoke === "string") {
          if (!UUID.test(input.revoke)) return problem(400);
          await accounts.revoke(input.revoke,session.account_id);return context.json({revoked:true});
        }
        if (Object.keys(input).some(key => !["token", "scopes"].includes(key))) return problem(400);
        if(typeof input.token!=="string" || !/^racr_[A-Za-z0-9_-]{43}$/.test(input.token))return problem(400);
        const scopes = input.scopes === undefined ? session.scopes : input.scopes;
        if (!Array.isArray(scopes) || !scopes.length || new Set(scopes).size !== scopes.length ||
          scopes.some(scope => !ALL_ACCOUNT_SCOPES.includes(scope))) return problem(400);
        if (scopes.some(scope => !session.scopes.includes(scope))) return problem(403);
        const credential=await accounts.issue(session.did,false,input.token,scopes);
        return context.json({type:"racr.api-credential",version:1,provider,...credential});
      }
      if(method!=="GET")return problem(405);
      return context.json(await accounts.describe(session,provider));
      });
    } catch (error) {
      if(error instanceof RequestBodyTimeout)return new Response(null,{status:408,headers:{'Cache-Control':'no-store'}});
      if (error instanceof UserGrantError) return problem(error.status);
      if (error instanceof BindingError || error instanceof CustomDomainAuthorityError) return problem(error.status);
      if (error instanceof AccountTransferError) return problem(error.status);
      if(error instanceof SenderProfileConflictError)return problem(409);
      if (error instanceof HailCodecError || error instanceof SyntaxError) return problem(400);
      if (error instanceof CredentialConflictError || error instanceof GrantConflictError || error instanceof Error &&
        ("code" in error && error.code === "55000" || "errno" in error && error.errno === "55000")) {
        return problem(409);
      }
      context.header("Retry-After", "30");
      return problem(503);
    }
  };
  app.all("/api/v1/account", context => handle(context, null));
  app.all("/api/v1/account/transfers",context=>handle(context,null,"transfer-status"));
  app.all("/api/v1/account/transfers/offer",context=>handle(context,null,"transfer-offer"));
  app.all("/api/v1/account/transfers/cancel",context=>handle(context,null,"transfer-cancel"));
  app.all("/api/v1/account/transfers/export",context=>handle(context,null,"transfer-export"));
  app.all("/api/v1/account/transfers/managed",context=>handle(context,null,"managed-transfer-status"));
  app.all("/api/v1/account/transfers/managed/offer",context=>handle(context,null,"managed-transfer-offer"));
  app.all("/api/v1/account/transfers/managed/export",context=>handle(context,null,"managed-transfer-export"));
  app.all("/api/v1/account/custody/managed",context=>handle(context,null,"custody-prepare"));
  app.all("/api/v1/account/custody/owner-controlled/review",context=>handle(context,null,"custody-review-owner"));
  app.all("/api/v1/account/custody/owner-controlled",context=>handle(context,null,"custody-prepare-owner"));
  app.all("/api/v1/account/custody/managed/commit",context=>handle(context,null,"custody-commit"));
  app.all("/api/v1/account/binding",context=>handle(context,null,"binding"));
  app.all("/api/v1/account/profile",context=>handle(context,null,"profile"));
  app.all("/api/v1/account/media-ticket",context=>handle(context,null,"media-ticket"));
  app.all("/api/v1/account/senders/:sender/avatar/image",context=>handle(context,context.req.param("sender"),"sender-avatar-image"));
  app.all("/api/v1/account/senders/:sender/avatar",context=>handle(context,context.req.param("sender"),"sender-avatar"));
  app.all("/api/v1/account/senders/:sender/profile",context=>handle(context,context.req.param("sender"),"sender-profile"));
  app.all('/api/v1/account/attachments/:sender/:messageId/:digest',context=>handle(context,null,'attachment-download'));
  app.all('/api/v1/account/images/:sender/:messageId/:digest',context=>handle(context,null,'message-image'));
  app.all("/api/v1/account/credentials", context => handle(context,null,"credential"));
}
