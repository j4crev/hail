export class JmapRequestError extends Error {constructor(readonly status:number,message:string){super(message);}}
// Fixed same-origin JSON bridge routes bind requests to the configured provider;
// never send the browser session to URLs obtained from discovery responses.
const CORE='urn:ietf:params:jmap:core',MESSAGES='https://racrproto.com/ns/jmap/messages';
const failure=()=>new Error('The change could not be confirmed. Refresh and try again.');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export async function readJmapJson(response:Response,maximum:number):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)throw failure();
  let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>maximum)throw failure();text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  return JSON.parse(text);
}
async function request(path:string,body?:unknown,maximum=262144){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new JmapRequestError(response.status,'The request could not be confirmed. Refresh and try again.');
  const result:unknown=await readJmapJson(response,maximum);if(!object(result))throw failure();return result;
}
async function call(name:string,args:Record<string,unknown>,capability=MESSAGES){
  const response=await request('/api/jmap',{using:[CORE,capability],methodCalls:[[name,args,'read-state']]},name.startsWith('HailGrant/')?65536:name.startsWith('HailRelationship/')?131072:40*1024*1024);
  const calls=response.methodResponses;
  if(Array.isArray(calls)&&calls.length===1&&calls[0]?.[0]==='error'&&object(calls[0][1])){const e=calls[0][1];throw new JmapRequestError(typeof e.httpStatus==='number'?e.httpStatus:e.type==='stateMismatch'?409:e.type==='forbidden'?403:e.type==='notFound'?404:e.type==='rateLimit'?429:['serverFail','serverUnavailable'].includes(String(e.type))?503:400,typeof e.description==='string'?e.description:'The request could not be confirmed. Refresh and try again.');}
  if(!Array.isArray(calls)||calls.length!==1||!Array.isArray(calls[0])||calls[0].length!==3||calls[0][0]!==name||calls[0][2]!=='read-state'||!object(calls[0][1]))throw failure();
  const result=calls[0][1];if(result.accountId!==args.accountId)throw failure();return result;
}
async function mutateMessage(sender:string,messageId:string,patch:Record<string,boolean>|null,inTrash:boolean|undefined,ifTrashEnabled?:boolean){
  if(!/^did:plc:[a-z2-7]{24}$/.test(sender)||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(messageId))throw failure();
  const session=await request('/api/jmap/session');
  const accountId=object(session.primaryAccounts)?session.primaryAccounts[MESSAGES]:null;
  if(typeof accountId!=='string'||! /^[A-Za-z0-9_-]{1,255}$/.test(accountId)||!object(session.accounts))throw failure();
  const account=session.accounts[accountId];
  if(!object(account)||account.isReadOnly!==false||!object(account.accountCapabilities))throw failure();
  const capability=account.accountCapabilities[MESSAGES];
  if(!object(capability)||!Array.isArray(capability.mutableProperties))throw failure();
  const mutable=capability.mutableProperties;
  if(patch?Object.keys(patch).some(key=>!mutable.includes(key)):capability.canDestroy!==true)throw failure();
  // Current feed URLs identify protocol messages. Resolve their mailbox record
  // through the JMAP query filter; the write itself uses its opaque ID and state.
  const query=await call('HailMessage/query',{accountId,filter:{sender,messageId,...(inTrash===undefined?{}:{inTrash})},limit:2});
  if(!Array.isArray(query.ids)||query.ids.length!==1||typeof query.ids[0]!=='string'||! /^[A-Za-z0-9_-]{1,255}$/.test(query.ids[0])||typeof query.queryState!=='string')throw failure();
  const id=query.ids[0];
  const result=await call('HailMessage/set',{accountId,ifInState:query.queryState,...(patch?{update:{[id]:patch}}:{destroy:[id]}),...(ifTrashEnabled===undefined?{}:{ifTrashEnabled})});
  // Never retry a stale write automatically: doing so could overwrite a newer
  // decision from another device. The UI reports the error and can refresh.
  if(result.oldState!==query.queryState||typeof result.newState!=='string')throw failure();
  if(patch?(!object(result.updated)||!Object.hasOwn(result.updated,id)||result.notUpdated!==null):(!Array.isArray(result.destroyed)||!result.destroyed.includes(id)||result.notDestroyed!==null))throw failure();
}

export async function setMessageRead(sender:string,messageId:string,isRead:boolean){
  if(typeof isRead!=='boolean')throw failure();
  return mutateMessage(sender,messageId,{isRead},false);
}
export async function removeReceivedMessage(sender:string,messageId:string,trashEnabled:boolean){
  if(typeof trashEnabled!=='boolean')throw failure();
  return mutateMessage(sender,messageId,trashEnabled?{isInTrash:true}:null,undefined,trashEnabled);
}
export async function restoreReceivedMessage(sender:string,messageId:string){
  return mutateMessage(sender,messageId,{isInTrash:false},true,true);
}

export async function mutateDraft(draftId:string,restore:boolean,trashEnabled:boolean){
  const capability='https://racrproto.com/ns/jmap/drafts',session=await request('/api/jmap/session');
  const accountId=object(session.primaryAccounts)?session.primaryAccounts[capability]:null;
  if(typeof accountId!=='string')throw failure();
  const query=await call('HailDraft/query',{accountId,filter:{draftId,inTrash:restore},limit:2},capability);
  if(!Array.isArray(query.ids)||query.ids.length!==1||typeof query.ids[0]!=='string'||typeof query.queryState!=='string')throw failure();
  const id=query.ids[0],patch=restore?{isInTrash:false}:trashEnabled?{isInTrash:true}:null;
  const result=await call('HailDraft/set',{accountId,ifInState:query.queryState,ifTrashEnabled:trashEnabled,...(patch?{update:{[id]:patch}}:{destroy:[id]})},capability);
  if(result.oldState!==query.queryState||typeof result.newState!=='string'||(patch?(!object(result.updated)||!Object.hasOwn(result.updated,id)||result.notUpdated!==null):(!Array.isArray(result.destroyed)||!result.destroyed.includes(id)||result.notDestroyed!==null)))throw failure();
}

export async function accountOperation(name:string,args:Record<string,unknown>={}){
  const capability='https://racrproto.com/ns/jmap/account',session=await request('/api/jmap/session');
  const accountId=object(session.primaryAccounts)?session.primaryAccounts[capability]:null;
  if(typeof accountId!=='string')throw failure();
  return call(name,{...args,accountId},capability);
}
