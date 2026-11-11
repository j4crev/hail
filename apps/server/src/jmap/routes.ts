import {JmapOperations,JmapOperationError} from './operations.js';
import {JmapCollections,COLLECTIONS,HAIL_ACCOUNT,canReadCollection,type Collection} from './collections.js';
import {JmapBlobs,MAX_UPLOAD_BYTES} from './blobs.js';
import {JmapDrafts,HAIL_DRAFTS,MAX_DRAFT_GET_BYTES,canReadDrafts} from './drafts.js';
import {createHash} from 'node:crypto';
import type {Hono,Context} from 'hono';
import {getCookie} from 'hono/cookie';
import type {AccountApiRepository,AccountApiSession} from '../accounts/repository.js';
import {accountRequestBytes,RequestBodyTimeout} from '../accounts/routes.js';
import {parseJsonWithoutDuplicateKeys} from '../discovery/strict-json.js';
import {clientAddress,FixedWindowRateLimit} from '../http/rate-limit.js';
import {withServingGeneration} from '../db/serving.js';
import {HAIL_MESSAGES,JMAP_CORE,JmapError,JmapMessages,MAX_OBJECTS,object,canMutateMessages,canDestroyMessages} from './messages.js';

const MAX_REQUEST=8*1024*1024,MAX_CALLS=16;
type Invocation=[string,Record<string,unknown>,string];
const problem=(status:number,type:string)=>Response.json({type:`urn:ietf:params:jmap:error:${type}`,status},
  {status,headers:{'Content-Type':'application/problem+json','Cache-Control':'no-store'}});
function resolvePath(value:unknown,segments:string[]):unknown {
  if(!segments.length)return value;
  const [part,...rest]=segments;
  if(part==='*'){
    if(!Array.isArray(value))throw new JmapError('invalidResultReference');
    return value.flatMap(item=>{const found=resolvePath(item,rest);return Array.isArray(found)?found:[found];});
  }
  if(value===null||typeof value!=='object'||!Object.hasOwn(value,part!))throw new JmapError('invalidResultReference');
  return resolvePath((value as Record<string,unknown>)[part!],rest);
}
function references(args:Record<string,unknown>,responses:Invocation[]){
  const result:Record<string,unknown>=Object.assign(Object.create(null),args);
  for(const [key,value] of Object.entries(args)){
    if(!key.startsWith('#'))continue;
    if(!object(value)||Object.keys(value).sort().join(',')!=='name,path,resultOf'||typeof value.resultOf!=='string'||
      typeof value.name!=='string'||typeof value.path!=='string'||!value.path.startsWith('/')||value.path.length>1024||Object.hasOwn(args,key.slice(1)))
      throw new JmapError('invalidResultReference');
    const response=responses.find(r=>r[2]===value.resultOf);
    if(!response||response[0]!==value.name)throw new JmapError('invalidResultReference');
    const segments=value.path.slice(1).split('/').map(s=>{
      if(/~(?:[^01]|$)/.test(s))throw new JmapError('invalidResultReference');return s.replaceAll('~1','/').replaceAll('~0','~');
    });
    if(segments.length>32)throw new JmapError('invalidResultReference');
    result[key.slice(1)]=resolvePath(response[1],segments);delete result[key];
  }
  return result;
}

export function registerJmapRoutes(app:Hono,accounts:AccountApiRepository,messages:JmapMessages,origin:string,browserOrigin=origin,drafts?:JmapDrafts,blobs?:JmapBlobs,collections?:JmapCollections,operations?:JmapOperations){
  const rate=new FixedWindowRateLimit(),active=new Map<string,number>(),uploads=new Map<string,number>(),approvalRate=new FixedWindowRateLimit();let processing=0;
  function sessionObject(session:AccountApiSession){
    const accountId=messages.accountId(session),read=session.scopes.includes('messages:read');
    const writable=canMutateMessages(session),destroyable=canDestroyMessages(session),draftRead=!!drafts&&canReadDrafts(session);
    const capabilities={maxSizeUpload:blobs?MAX_UPLOAD_BYTES:0,maxConcurrentUpload:2,maxSizeRequest:MAX_REQUEST,maxConcurrentRequests:4,
      maxCallsInRequest:MAX_CALLS,maxObjectsInGet:MAX_OBJECTS,maxObjectsInSet:MAX_OBJECTS,collationAlgorithms:[]};
    const document={capabilities:{...((collections||operations)?{[HAIL_ACCOUNT]:{version:1,types:COLLECTIONS}}:{}),[JMAP_CORE]:capabilities,[HAIL_MESSAGES]:{version:1,mutableProperties:['isRead','isInTrash'],canDestroy:true},...(drafts?{[HAIL_DRAFTS]:{version:1,mutableProperties:['content','isInTrash'],canCreate:true,canDestroy:true,maxGetBytes:MAX_DRAFT_GET_BYTES}}:{})},
      accounts:{[accountId]:{name:session.canonical_address,isPersonal:true,isReadOnly:!destroyable,accountCapabilities:{...((collections||operations)?{[HAIL_ACCOUNT]:{types:COLLECTIONS.filter(c=>canReadCollection(session,c))}}:{}),...(read?{[HAIL_MESSAGES]:{mutableProperties:writable?['isRead','isInTrash']:[],canDestroy:destroyable},...(draftRead?{[HAIL_DRAFTS]:{readOnly:!writable}}:{})}:{})}}},
      primaryAccounts:{...((collections||operations)?{[HAIL_ACCOUNT]:accountId}:{}),...(read?{[HAIL_MESSAGES]:accountId,...(draftRead?{[HAIL_DRAFTS]:accountId}:{})}:{})},username:session.canonical_address,
      apiUrl:`${origin}/jmap`,downloadUrl:`${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      uploadUrl:`${origin}/jmap/upload/{accountId}`,eventSourceUrl:`${origin}/jmap/events?types={types}&closeafter={closeafter}&ping={ping}`};
    return {...document,state:createHash('sha256').update(JSON.stringify(document)).digest('base64url')};
  }
  app.use('/jmap/*',async(context,next)=>{context.header('Cache-Control','no-store');await next();});
  const handle=async(context:Context):Promise<Response>=>{
    context.header('Cache-Control','no-store');context.header('Vary','Authorization, Cookie');
    const retry=rate.take(clientAddress(context.req.raw),120);
    if(retry!==null){const response=problem(429,'limit');response.headers.set('Retry-After',String(retry));return response;}
    let session:AccountApiSession|null;
    try{session=await accounts.authenticate(context.req.header('Authorization'),getCookie(context,'hail_session'));}
    catch{return problem(503,'serverUnavailable');}
    if(!session){const response=problem(401,'unauthorized');response.headers.set('WWW-Authenticate','Bearer realm="hail-jmap"');return response;}
    if(context.req.header('Origin')!==undefined&&context.req.header('Origin')!==browserOrigin)return problem(403,'forbidden');
    if(getCookie(context,'hail_session')&&context.req.method!=='GET'&&context.req.header('Origin')!==browserOrigin)return problem(403,'forbidden');
    const count=active.get(session.account_id)??0;
    if(processing>=32||count>=4)return problem(429,'limit');
    active.set(session.account_id,count+1);processing++;
    try{return await withServingGeneration(session.account_id,session.serving_generation??1,async()=>{
      const path=context.req.path,sessionData=sessionObject(session);
      if(path==='/.well-known/jmap')return context.req.method==='GET'?context.json(sessionData):problem(405,'unknownMethod');
      if(path.startsWith('/jmap/download/')){
        if(context.req.method!=='GET')return problem(405,'unknownMethod');
        if(!session.scopes.includes('messages:read')&&!session.scopes.includes('messages:write'))return problem(403,'forbidden');
        if(context.req.param('accountId')!==messages.accountId(session))return problem(404,'notFound');
        const found=(await collections?.blob(session,context.req.param('blobId')??''))??(blobs?await blobs.get(session,context.req.param('blobId')??''):session.scopes.includes('messages:read')?await messages.blob(session,context.req.param('blobId')??''):null);if(!found)return problem(404,'notFound');
        const name=context.req.param('name')??'message.cbor';
        if(name.length>255)return problem(400,'invalidArguments');
        const type=context.req.query('type')??found.type;
        if(type.length>255||!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(type))return problem(400,'invalidArguments');
        return new Response(Uint8Array.from(found.bytes),{headers:{'Content-Type':type,'Content-Length':String(found.bytes.length),
          'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,
          'Content-Security-Policy':"sandbox; default-src 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
      }
      if(path.startsWith('/jmap/upload/')){
        if(!blobs||!session.scopes.includes('messages:write')||session.migration_state)return problem(403,'forbidden');
        if(context.req.method!=='POST')return problem(405,'unknownMethod');
        if(context.req.param('accountId')!==messages.accountId(session))return problem(404,'notFound');
        if(context.req.header('Content-Encoding'))return problem(415,'invalidArguments');
        const uploading=uploads.get(session.account_id)??0;if(uploading>=2)return problem(429,'limit');
        uploads.set(session.account_id,uploading+1);
        try{const data=await accountRequestBytes(context.req.raw,MAX_UPLOAD_BYTES,60_000);if(!data)return problem(413,'tooLarge');
          return context.json(await blobs.upload(session,data,context.req.header('Content-Type')??'application/octet-stream'));}
        catch(error){if(error instanceof JmapError)return problem(error.type==='overQuota'?413:error.type==='invalidArguments'?400:403,error.type);throw error;}
        finally{const remaining=(uploads.get(session.account_id)??1)-1;if(remaining)uploads.set(session.account_id,remaining);else uploads.delete(session.account_id);}
      }
      if(path==='/jmap/events')return problem(501,'unsupportedCapability');
      if(path!=='/jmap'||context.req.method!=='POST')return problem(405,'unknownMethod');
      if(new URL(context.req.url).search)return problem(400,'invalidArguments');
      if(context.req.header('Content-Type')?.split(';')[0]?.trim()!=='application/json'||context.req.header('Content-Encoding'))return problem(415,'notJSON');
      const bytes=await accountRequestBytes(context.req.raw,MAX_REQUEST,10_000);if(!bytes)return problem(413,'limit');
      let input:unknown;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return problem(400,'notJSON');}
      if(!object(input)||
        !Array.isArray(input.using)||input.using.some(c=>typeof c!=='string')||!Array.isArray(input.methodCalls)||
        input.methodCalls.some(call=>!Array.isArray(call)||call.length!==3||typeof call[0]!=='string'||!object(call[1])||typeof call[2]!=='string'||call[2].length>255)||
        input.createdIds!==undefined&&(!object(input.createdIds)||Object.entries(input.createdIds).some(([k,v])=>! /^[A-Za-z0-9_-]{1,255}$/.test(k)||typeof v!=='string'||! /^[A-Za-z0-9_-]{1,255}$/.test(v))))return problem(400,'notRequest');
      if(input.methodCalls.length>MAX_CALLS)return problem(400,'limit');
      if(!input.using.includes(JMAP_CORE)||input.using.some(c=>c!==JMAP_CORE&&c!==HAIL_MESSAGES&&(!drafts||c!==HAIL_DRAFTS)&&(!(collections||operations)||c!==HAIL_ACCOUNT)))return problem(400,'unknownCapability');
      const responses:Invocation[]=[];
      const createdIds:Record<string,string>=Object.assign(Object.create(null),input.createdIds??{});
      const remember=(result:Record<string,unknown>)=>{if(object(result.created))for(const [key,value] of Object.entries(result.created))
        if(object(value)&&typeof value.id==='string')createdIds[key]=value.id;};
      const creationId=(value:unknown)=>typeof value==='string'&&value.startsWith('#')?(createdIds[value.slice(1)]??value):value;
      for(const [name,raw,callId] of input.methodCalls as Invocation[]){
        try{
          const args=references(raw,responses);
          if(name==='Core/echo'){responses.push([name,args,callId]);continue;}
          // Resolve only fields typed as JMAP IDs, never arbitrary message text.
          for(const key of ['ids','destroy','blobIds'])if(Array.isArray(args[key]))args[key]=args[key].map(creationId);
          if(object(args.update))args.update=Object.fromEntries(Object.entries(args.update).map(([key,value])=>[String(creationId(key)),value]));
          if(name==='Blob/copy'){if(!blobs)throw new JmapError('unknownMethod');responses.push([name,await blobs.copy(session,args),callId]);continue;}
          const [type,operation]=name.split('/');
          if(collections&&COLLECTIONS.includes(type as Collection)&&['get','query','changes','queryChanges','set'].includes(operation??'')){
            if(!input.using.includes(HAIL_ACCOUNT))throw new JmapError('unknownMethod');
            if(args.accountId!==messages.accountId(session))throw new JmapError('accountNotFound');
            if(!canReadCollection(session,type as Collection))throw new JmapError('accountNotSupportedByMethod');
            const result=operation==='get'?await collections.get(session,type as Collection,args):operation==='query'?await collections.query(session,type as Collection,args):
              operation==='changes'?await collections.changes(session,type as Collection,args):operation==='set'&&type==='HailSent'?await collections.setSent(session,args):null;
            if(!result)throw new JmapError(operation==='queryChanges'?'cannotCalculateChanges':'unknownMethod');
            remember(result);responses.push([name,result,callId]);continue;
          }
          if(operations&&input.using.includes(HAIL_ACCOUNT)&&/^(HailMailbox|HailSubmission|HailGrant|HailRelationship|HailAttachment)\//.test(name)){
            if(args.accountId!==messages.accountId(session))throw new JmapError('accountNotFound');
            if(/^HailGrant\/(reviewApproval|prepareApproval|commitApproval|approvalStatus)$/.test(name)&&approvalRate.take(clientAddress(context.req.raw),30)!==null)throw new JmapOperationError('rateLimit',429,'Wait before retrying permission requests');
            responses.push([name,await operations.dispatch(session,name,args),callId]);continue;
          }
          if(name.startsWith('HailDraft/')){
            if(!drafts||!input.using.includes(HAIL_DRAFTS)||!['HailDraft/get','HailDraft/query','HailDraft/changes','HailDraft/queryChanges','HailDraft/set'].includes(name))throw new JmapError('unknownMethod');
            if(args.accountId!==messages.accountId(session))throw new JmapError('accountNotFound');
            if(!canReadDrafts(session))throw new JmapError('accountNotSupportedByMethod');
            if(name==='HailDraft/set'&&!canMutateMessages(session))throw new JmapError('forbidden');
            if(name==='HailDraft/queryChanges')throw new JmapError('cannotCalculateChanges');
            const result=name==='HailDraft/set'?await drafts.set(session,args):name==='HailDraft/get'?await drafts.get(session,args):name==='HailDraft/query'?await drafts.query(session,args):await drafts.changes(session,args);
            remember(result);responses.push([name,result,callId]);continue;
          }
          if(!input.using.includes(HAIL_MESSAGES)||!['HailMessage/get','HailMessage/query','HailMessage/changes','HailMessage/queryChanges','HailMessage/set'].includes(name))throw new JmapError('unknownMethod');
          if(args.accountId!==messages.accountId(session))throw new JmapError('accountNotFound');
          if(!session.scopes.includes('messages:read'))throw new JmapError('accountNotSupportedByMethod');
          if(name==='HailMessage/set'&&(!canDestroyMessages(session)||!canMutateMessages(session)&&(Object.keys(args.update??{}).length||Object.keys(args.create??{}).length)))throw new JmapError('forbidden');
          if(name==='HailMessage/queryChanges')throw new JmapError('cannotCalculateChanges');
          const result=name==='HailMessage/set'?await messages.set(session,args):name==='HailMessage/get'?await messages.get(session,args):name==='HailMessage/query'?await messages.query(session,args):await messages.changes(session,args);
          remember(result);responses.push([name,result,callId]);
        }catch(error){responses.push(['error',{type:error instanceof JmapError?error.type:'serverFail',...(error instanceof JmapOperationError?{httpStatus:error.httpStatus,description:error.description,...(error.code?{code:error.code}:{})}:{})},callId]);}
      }
      return context.json({methodResponses:responses,sessionState:sessionData.state,...(input.createdIds!==undefined?{createdIds}:{})});
    });}catch(error){return problem(error instanceof RequestBodyTimeout?408:503,'serverUnavailable');}
    finally{processing--;const remaining=(active.get(session.account_id)??1)-1;if(remaining)active.set(session.account_id,remaining);else active.delete(session.account_id);}
  };
  app.all('/.well-known/jmap',handle);
  app.all('/jmap',handle);
  app.all('/jmap/download/:accountId/:blobId/:name',handle);
  app.all('/jmap/upload/:accountId',handle);
  app.all('/jmap/events',handle);
}
