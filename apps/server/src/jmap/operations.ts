import {decodeBase64Url,encodeBase64Url,inspectSignedPayload,toDiagnosticJson,fromDiagnosticJson,HailCodecError,type DiagnosticJson,type HailGrantScope} from '@racrproto/codec';
import type {AuthenticationResponseJSON} from '@simplewebauthn/server';
import type {AccountApiRepository,AccountApiSession,AccountApiScope} from '../accounts/repository.js';
import {GrantConflictError,type GrantRepository} from '../grants/repository.js';
import {UserGrantError,type GrantService} from '../grants/service.js';
import type {AccountMessaging} from '../accounts/messaging.js';
import type {AccountPublications} from '../accounts/publications.js';
import {ConnectionError,type AccountConnections} from '../accounts/connections.js';
import {PermissionError,type GrantPermissions} from '../accounts/permissions.js';
import {PasskeyError} from '../accounts/passkeys.js';
import {JmapError,argumentsOnly,object} from './common.js';
import type {JmapBlobs} from './blobs.js';
import {EmailBridgeError} from '../bridge/aliases.js';
import type {EmailAliasOperations} from '../bridge/operations.js';

export interface JmapOperationDependencies {
 accounts:AccountApiRepository;grants:GrantRepository;service:GrantService;
 messaging?:AccountMessaging;publications?:AccountPublications;connections?:AccountConnections;permissions?:GrantPermissions;blobs?:JmapBlobs;
 /** Present only when the provider offers the inbound email bridge. */
 emailAliases?:EmailAliasOperations;
}
const DID=/^did:plc:[a-z2-7]{24}$/;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** Only public domain errors are carried to clients; internal exceptions remain serverFail. */
export class JmapOperationError extends JmapError {
 constructor(type:string,readonly httpStatus:number,readonly description:string,readonly code?:string){super(type);}
}
const fail=(type:string,status:number,description=type,code?:string):never=>{throw new JmapOperationError(type,status,description,code);};
const scope=(s:AccountApiSession,value:AccountApiScope)=>{if(!s.scopes.includes(value))fail('forbidden',403,'The credential lacks the required scope','MISSING_SCOPE');};
const active=(s:AccountApiSession)=>{if(s.migration_state)fail('stateMismatch',409,'The account is fenced for migration');};
const browser=(s:AccountApiSession)=>{if(!s.passkey_credential_id)fail('forbidden',403,'This operation requires a browser session','PASSKEY_REQUIRED');};
const bearer=(s:AccountApiSession)=>{if(s.passkey_credential_id)fail('forbidden',403,'This operation requires an API credential');};
const required=(a:Record<string,unknown>,key:string,pattern?:RegExp)=>{
 const value=a[key];if(typeof value!=='string'||value.length>2048||pattern&&!pattern.test(value))throw new JmapError('invalidArguments');return value;
};
const optional=(a:Record<string,unknown>,key:string,pattern?:RegExp)=>a[key]==null?null:required(a,key,pattern);
const bool=(a:Record<string,unknown>,key:string,defaultValue=false)=>{if(a[key]===undefined)return defaultValue;if(typeof a[key]!=='boolean')throw new JmapError('invalidArguments');return a[key];};
const input=(a:Record<string,unknown>,max=65536)=>{if(!object(a.input))throw new JmapError('invalidArguments');if(Buffer.byteLength(JSON.stringify(a.input))>max)throw new JmapError('requestTooLarge');return a.input;};
const found=<T>(value:T|null|undefined):T=>{if(value==null)throw new JmapError('notFound');return value;};
const need=<T>(value:T|undefined):T=>{if(value===undefined)throw new JmapError('serverUnavailable');return value;};
function signed(value:unknown,max:number){
 if(typeof value!=='string'||value.length>Math.ceil(max*4/3))throw new JmapError('invalidArguments');
 try{const bytes=decodeBase64Url(value);if(bytes.length>max||encodeBase64Url(bytes)!==value)throw Error();return bytes;}
 catch{throw new JmapError('invalidArguments');}
}
const batchKind=(value:unknown):'category'|'connections'=>{if(value!=='category'&&value!=='connections')throw new JmapError('invalidArguments');return value;};
const receipt=(saved:Awaited<ReturnType<GrantService['revoke']>>)=>({grantId:saved.payload.grant_id,revision:saved.payload.revision,status:saved.payload.status,digest:encodeBase64Url(saved.digest),publication:'durable'});

/** Typed application operations. Domain services retain all identity/approval and retry checks. */
export class JmapOperations {
 constructor(private readonly deps:JmapOperationDependencies){}
 async dispatch(session:AccountApiSession,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
  const {accountId,...a}=args;
  try{
   const result=await this.run(session,name,a);
   return {accountId,...result};
  }catch(error){
   if(name==='HailSubmission/submit'&&object(a.input)&&['connections','replyAll'].includes(String(a.kind)))console.error(JSON.stringify({
    type:'hail.connection-batch',operation:name,outcome:'rejected',requestId:typeof a.input.publicationId==='string'&&ID.test(a.input.publicationId)?a.input.publicationId:undefined,
    errorType:error instanceof Error?error.constructor.name:'unknown',...(error instanceof UserGrantError?{status:error.status,reason:error.message}:{}),
    frames:error instanceof Error?error.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,6):undefined}));
   if(error instanceof JmapError)throw error;
   if(error instanceof HailCodecError)throw new JmapError('invalidArguments');
   if(error instanceof GrantConflictError)fail('stateMismatch',409,'Grant revision changed; review the retained intent');
   if(error instanceof UserGrantError||error instanceof ConnectionError||error instanceof PermissionError||error instanceof PasskeyError||error instanceof EmailBridgeError){
    const status=error.status;
    const type=status===400?'invalidArguments':status===403?'forbidden':status===404?'notFound':status===409?'stateMismatch':status===410?'notFound':status===413?'requestTooLarge':status===429?'rateLimit':'serverUnavailable';
    fail(type,status,error.message,error instanceof ConnectionError?error.code:status===410?'APPROVAL_EXPIRED':undefined);
   }
   throw error;
  }
 }
 private async run(s:AccountApiSession,name:string,a:Record<string,unknown>):Promise<object>{
  const d=this.deps;
  if(name==='HailEmailAlias/get'){
   argumentsOnly(a,['summary']);scope(s,'messages:read');
   if(!d.emailAliases)return {available:false};
   return d.emailAliases.get(s,bool(a,'summary'));
  }
  if(name==='HailEmailAlias/create'||name==='HailEmailAlias/destroy'){
   // Aliases are account configuration managed from the browser, like Trash and preferences.
   scope(s,'messages:write');browser(s);active(s);const aliases=need(d.emailAliases);
   if(name==='HailEmailAlias/create'){argumentsOnly(a,['label']);return aliases.create(s,a.label);}
   argumentsOnly(a,['ids']);return aliases.destroy(s.account_id,a.ids);
  }
  if(name==='HailAttachment/import'){
   argumentsOnly(a,['filename','blobId']);scope(s,'messages:write');active(s);
   const blob=found(await need(d.blobs).get(s,required(a,'blobId')));
   return need(d.messaging).attachments.upload(s,{filename:required(a,'filename'),data:encodeBase64Url(blob.bytes)});
  }
  if(name==='HailMailbox/view'){
   scope(s,'messages:read');const m=need(d.messaging),view=required(a,'view');
   const fields:Record<string,string[]>={inbox:['after'],inboxFeed:['after','channel','trash'],read:['sender','messageId'],sent:['after'],sentFeed:['after'],
    sentSends:['after','trash'],sentSend:['kind','messageId','trash'],sentMessage:['messageId'],threads:['sender','messageId'],connectionInbox:['after'],connectionThread:['sender','messageId','offset'],
    unreadCounts:[],conversations:['peer','after','trash'],settings:[],connectionAddress:['peer']};
   if(!fields[view])throw new JmapError('invalidArguments');argumentsOnly(a,['view',...fields[view]!]);
   const after=optional(a,'after'),trash=bool(a,'trash');
   if(view==='settings'||view==='inboxFeed'&&trash)browser(s);
   switch(view){
    case 'inbox':return m.inbox(s,after);
    case 'inboxFeed':{const channel=a.channel??'all';if(typeof channel!=='string'||!['all','subscriptions','connections'].includes(channel))throw new JmapError('invalidArguments');return m.inboxFeed(s,after,channel as 'all'|'subscriptions'|'connections',trash);}
    case 'read':return found(await m.read(s,required(a,'sender',DID),required(a,'messageId',ID)));
    case 'sent':return m.sent(s,after);
    case 'sentFeed':return m.sentFeed(s,after);
    case 'sentSends':return m.sentSends(s,after,undefined,trash);
    case 'sentSend':return found((await m.sentSends(s,null,{kind:required(a,'kind'),id:required(a,'messageId',ID)},trash)).messages[0]);
    case 'sentMessage':return found(await m.sentMessage(s,required(a,'messageId',ID)));
    case 'threads':return found(await m.thread(s,required(a,'sender',DID),required(a,'messageId',ID)));
    case 'connectionInbox':return m.connectionInbox(s,after);
    case 'connectionThread':return found(await m.connectionThread(s,required(a,'sender',DID),required(a,'messageId',ID),optional(a,'offset')));
    case 'unreadCounts':return m.unreadCounts(s);
    case 'conversations':{const peer=optional(a,'peer',DID);if(peer&&trash)throw new JmapError('invalidArguments');return m.conversations(s,peer,peer?'show':'list',after,trash);}
    case 'settings':return m.trash.settings(s);
    case 'connectionAddress':return d.accounts.connectionAddress(s,required(a,'peer',DID));
   }
  }
  if(name==='HailMailbox/conversationAction'){
   argumentsOnly(a,['peer','action']);scope(s,'messages:write');active(s);
   const action=required(a,'action');if(!['mark-read','mark-unread','trash','restore'].includes(action))throw new JmapError('invalidArguments');
   return need(d.messaging).conversations(s,required(a,'peer',DID),action,null,false);
  }
  if(['HailMailbox/clearSent','HailMailbox/restoreSent','HailMailbox/emptyTrash','HailMailbox/preferences'].includes(name)){
   scope(s,'messages:write');browser(s);active(s);const trash=need(d.messaging).trash;
   if(name==='HailMailbox/emptyTrash'){argumentsOnly(a,[]);return trash.empty(s);}
   argumentsOnly(a,['input']);const data=input(a,32768);
   if(name==='HailMailbox/clearSent'){argumentsOnly(data,['trashEnabled','messages']);return trash.clearSent(s,data.trashEnabled,data.messages);}
   if(name==='HailMailbox/restoreSent'){argumentsOnly(data,['kind','messageId']);return trash.restoreSent(s,data.kind,data.messageId);}
   if('trashEnabled' in data){argumentsOnly(data,['trashEnabled']);return trash.saveSettings(s,data.trashEnabled);}
   return trash.saveDisplaySettings(s,data);
  }
  if(name==='HailSubmission/submit'){
   argumentsOnly(a,['kind','input']);scope(s,'messages:write');active(s);const data=input(a,8*1024*1024);
   switch(a.kind){case 'message':return need(d.messaging).send(s,data);case 'category':return need(d.publications).create(s,data);
    case 'connections':return need(d.publications).createConnections(s,data);case 'replyAll':return need(d.publications).replyConversation(s,data);default:throw new JmapError('invalidArguments');}
  }
  if(name==='HailSubmission/retry'){
   argumentsOnly(a,['id']);scope(s,'messages:write');active(s);const m=need(d.messaging),id=required(a,'id',ID);
   found(await m.status(s,id));return m.submit(s.did,id);
  }
  if(name==='HailSubmission/status'){
   argumentsOnly(a,['kind','id']);scope(s,'messages:read');const id=required(a,'id',ID);
   return a.kind==='message'?found(await need(d.messaging).status(s,id)):found(await need(d.publications).status(s,id,batchKind(a.kind)));
  }
  if(name==='HailSubmission/cancel'){
   argumentsOnly(a,['kind','id']);scope(s,'messages:write');active(s);return found(await need(d.publications).cancel(s,required(a,'id',ID),batchKind(a.kind)));
  }
  if(name==='HailSubmission/recent'){argumentsOnly(a,['kind']);scope(s,'messages:read');return need(d.publications).recent(s,batchKind(a.kind));}
  if(name==='HailSubmission/audiences'){argumentsOnly(a,[]);scope(s,'grants:read');return need(d.publications).audiences(s);}
  if(name==='HailSubmission/targets'){argumentsOnly(a,[]);scope(s,'messages:read');browser(s);return need(d.publications).connectionTargets(s);}
  if(name==='HailGrant/list'){
   argumentsOnly(a,['after','sender']);scope(s,'grants:read');return d.accounts.listGrants(s,optional(a,'after',ID),optional(a,'sender',DID));
  }
  if(name==='HailGrant/read'){
   argumentsOnly(a,['grantId']);scope(s,'grants:read');const id=required(a,'grantId',ID),current=await d.grants.findCurrentByGrantId(id);
   const owned=current?.localAccountId===s.account_id?current:await d.grants.findReceivedForSender(id,s.did);
   if(!owned||owned.localAccountId!==s.account_id)throw new JmapError('notFound');
   return {type:'racr.grant',version:1,localRole:owned.localRole,digest:encodeBase64Url(owned.digest),cose:encodeBase64Url(owned.representation)};
  }
  if(name==='HailGrant/propose'||name==='HailGrant/managedCreate'){
   argumentsOnly(a,['input']);scope(s,'grants:write');active(s);const data=input(a,16384);
   argumentsOnly(data,['sender','category','scope','expiresAt']);const sender=required(data,'sender');
   if(data.scope===undefined?typeof data.category!=='string':data.category!==undefined||!object(data.scope))throw new JmapError('invalidArguments');
   if(data.expiresAt!==null&&!Number.isSafeInteger(data.expiresAt))throw new JmapError('invalidArguments');
   const options={scope:(data.scope??{type:'categories',values:[data.category]}) as Parameters<GrantService['prepareUserSignedGrant']>[2]['scope'],expiresAt:data.expiresAt as number|null};
   if(name==='HailGrant/managedCreate'){if(!await d.accounts.isManaged(s.account_id))throw new JmapError('forbidden');return receipt(await d.service.createOrReuse(s.did,sender,options));}
   return {type:'racr.grant-proposal',version:1,grant:toDiagnosticJson('hail.grant',await d.service.prepareUserSignedGrant(s.did,sender,options))};
  }
  if(name==='HailGrant/proposeUpdate'||name==='HailGrant/managedUpdate'){
   argumentsOnly(a,['grantId','input']);scope(s,'grants:write');active(s);
   const id=required(a,'grantId',ID),current=await d.grants.findCurrentByGrantId(id),data=input(a,16384);
   if(!current||current.localAccountId!==s.account_id||current.localRole!=='grantor')throw new JmapError('notFound');
   if(name==='HailGrant/managedUpdate'){
    if(!await d.accounts.isManaged(s.account_id))throw new JmapError('forbidden');
    argumentsOnly(data,['payload','signingKey']);const signingKey=required(data,'signingKey');
    const payload=fromDiagnosticJson('hail.grant',data.payload as DiagnosticJson);
    if(payload.grant_id!==id||payload.grantor!==s.did||payload.status!=='active')throw new JmapError('invalidArguments');
    const saved=await d.service.updateManaged(s.did,payload,signingKey);
    return {...receipt(saved),cose:encodeBase64Url(saved.representation)};
   }
   argumentsOnly(data,['scope','expiresAt','expectedRevision','expectedDigest','refreshConsent','sender']);
   if(!object(data.scope)||!Number.isSafeInteger(data.expectedRevision)||typeof data.expectedDigest!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(data.expectedDigest)||
     typeof data.refreshConsent!=='boolean'||data.expiresAt!==null&&!Number.isSafeInteger(data.expiresAt)||data.sender!==undefined&&typeof data.sender!=='string')throw new JmapError('invalidArguments');
   const proposed=await d.service.prepareUserSignedUpdate(s.did,id,{scope:data.scope as unknown as HailGrantScope,expiresAt:data.expiresAt as number|null,
    expectedRevision:data.expectedRevision as number,expectedDigest:decodeBase64Url(data.expectedDigest),refreshConsent:data.refreshConsent,
    ...(data.sender?{sender:data.sender as string}:{})});
   return {type:'racr.grant-proposal',version:1,grant:toDiagnosticJson('hail.grant',proposed)};
  }
  if(name==='HailGrant/managedRevoke'){
   argumentsOnly(a,['grantId']);scope(s,'grants:write');active(s);if(!await d.accounts.isManaged(s.account_id))throw new JmapError('forbidden');
   const id=required(a,'grantId',ID),current=await d.grants.findCurrentByGrantId(id);
   if(!current||current.localAccountId!==s.account_id||current.localRole!=='grantor')throw new JmapError('notFound');
   return receipt(await d.service.revoke(s.did,id));
  }
  if(name==='HailGrant/submit'){
   argumentsOnly(a,['grantId','cose']);scope(s,'grants:write');active(s);const id=required(a,'grantId',ID),bytes=signed(a.cose,262144);
   const current=await d.grants.findCurrentByGrantId(id);if(current&&(current.localAccountId!==s.account_id||current.localRole!=='grantor'))throw new JmapError('notFound');
   const payload=inspectSignedPayload('hail.grant',bytes).payload;if(payload.grant_id!==id)throw new JmapError('invalidArguments');
   return receipt(await d.service.acceptUserSignedGrant(s.did,payload.consent_context.grantee_address,bytes));
  }
  if(['HailGrant/reviewApproval','HailGrant/prepareApproval','HailGrant/commitApproval','HailGrant/approvalStatus'].includes(name)){
   browser(s);active(s);const permissions=need(d.permissions);
   if(name==='HailGrant/approvalStatus'){argumentsOnly(a,['requestId']);return permissions.status(s,required(a,'requestId',UUID));}
   argumentsOnly(a,['input']);const data=input(a);
   if(name==='HailGrant/reviewApproval')return permissions.review(s,data);
   if(name==='HailGrant/prepareApproval')return permissions.prepare(s,data);
   argumentsOnly(data,['requestId','response']);if(data.response!==undefined&&!object(data.response))throw new JmapError('invalidArguments');
   return permissions.commit(s,required(data,'requestId',UUID),data.response as AuthenticationResponseJSON|undefined);
  }
  if(name.startsWith('HailRelationship/')){
   const operation=name.slice('HailRelationship/'.length);
   if(!['credentialList','credentialInvitations','credentialRemove','credentialRevokeInvitation','list','status','conversationPreferences','conversationMembership','review','prepare','commit','seen'].includes(operation))throw new JmapError('unknownMethod');
   const c=need(d.connections);
   if(['credentialList','credentialInvitations','credentialRemove','credentialRevokeInvitation'].includes(operation)){
    bearer(s);const mutation=operation==='credentialRemove'||operation==='credentialRevokeInvitation';argumentsOnly(a,mutation?['connectionId']:[]);
    scope(s,mutation?'account:write':'account:read');if(mutation)active(s);
    return c.credentialConnections(s,mutation?required(a,'connectionId',UUID):undefined,operation==='credentialInvitations'||operation==='credentialRevokeInvitation');
   }
   if(operation==='list'){argumentsOnly(a,[]);browser(s);return c.list(s);}
   if(operation==='status'){argumentsOnly(a,['requestId']);return c.status(s,required(a,'requestId',UUID));}
   if(operation==='conversationPreferences'){
    argumentsOnly(a,['input']);if(a.input===undefined)return c.conversationPreferences(s);active(s);return c.conversationPreferences(s,input(a,4096));
   }
   if(operation==='conversationMembership'){argumentsOnly(a,['input']);return c.conversationMembership(s,input(a,4096));}
   if(!['review','prepare','commit','seen'].includes(operation))throw new JmapError('unknownMethod');
   argumentsOnly(a,['input']);const data=input(a,s.passkey_credential_id?65536:32768);active(s);
   if(operation==='review'||operation==='seen')browser(s);
   if(operation==='review')return c.review(s,data);
   if(operation==='seen')return c.seen(s,data);
   if(operation==='prepare')return c.prepare(s,data);
   argumentsOnly(data,['requestId','response','cose']);if(data.response!==undefined&&!object(data.response))throw new JmapError('invalidArguments');
   if(!s.passkey_credential_id&&(data.response!==undefined||data.cose===undefined))throw new JmapError('forbidden');
   return c.commit(s,required(data,'requestId',UUID),data.response as AuthenticationResponseJSON|undefined,data.cose===undefined?undefined:signed(data.cose,16384));
  }
  throw new JmapError('unknownMethod');
 }
}
