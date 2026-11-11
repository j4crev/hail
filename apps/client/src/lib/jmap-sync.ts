import {readJmapJson} from './jmap.js';
import {mailboxCache} from './mailbox-cache.js';
const CORE='urn:ietf:params:jmap:core';
const MESSAGE='https://haili.app/ns/jmap/messages',DRAFT='https://haili.app/ns/jmap/drafts',ACCOUNT='https://haili.app/ns/jmap/account';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Each browser owns its cursor set. A lost cursor means refetching projections,
// never resetting server read state or drafts. No credentials/content persisted.
export class MailboxSync {
  private states=new Map<string,string>();
  private identity='';
  constructor(private transport:typeof fetch=fetch){}
  async poll():Promise<boolean>{
    const read=async(path:string,body?:unknown)=>{
      const response=await this.transport(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
        signal:AbortSignal.timeout(20_000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      if(!response.ok)throw new Error('Mailbox sync unavailable');
      return await readJmapJson(response,131072) as Record<string,any>;
    };
    const session=await read('/api/jmap/session');
    if(!object(session)||!object(session.primaryAccounts)||!object(session.accounts))throw new Error('Invalid JMAP Session');
    const identity=JSON.stringify([session.username,session.primaryAccounts,session.state]);
    let changed=this.identity!==identity;
    const states=changed?new Map<string,string>():new Map(this.states);
    const selected:Array<[string,string,string]>=[];
    for(const [type,capability] of [['HailMessage',MESSAGE],['HailDraft',DRAFT],...['HailSent','HailSubmission','HailGrant','HailRelationship'].map(t=>[t,ACCOUNT])] as [string,string][]){
      const id=session.primaryAccounts[capability],cap=session.accounts[id]?.accountCapabilities?.[capability];
      if(typeof id==='string'&&object(cap)&&(capability!==ACCOUNT||Array.isArray(cap.types)&&cap.types.includes(type)))selected.push([type,capability,id]);
    }
    for(const [type,capability,accountId] of selected){
      const previous=states.get(type),method=type+(previous?'/changes':'/get');
      const result=await read('/api/jmap',{using:[CORE,capability],methodCalls:[[method,{accountId,...(previous?{sinceState:previous,maxChanges:50}:{ids:[]})},'sync']]});
      const invocation=result?.methodResponses?.[0];
      if(!Array.isArray(result?.methodResponses)||result.methodResponses.length!==1||!Array.isArray(invocation)||invocation[2]!=='sync'||!object(invocation[1]))throw new Error('Invalid sync response');
      const data=invocation[1];
      if(invocation[0]==='error'){
        if(['cannotCalculateChanges','accountNotFound'].includes(data.type)){states.delete(type);changed=true;continue;}
        throw new Error('Mailbox sync refused');
      }
      const state=previous?data.newState:data.state;
      if(invocation[0]!==method||data.accountId!==accountId||typeof state!=='string'||state.length>1024||previous&&data.oldState!==previous)throw new Error('Invalid sync state');
      if(previous){
        if(!['created','updated','destroyed'].every(k=>Array.isArray(data[k]))||typeof data.hasMoreChanges!=='boolean')throw new Error('Invalid sync changes');
        if(data.created.length||data.updated.length||data.destroyed.length||data.hasMoreChanges)changed=true;
        // Projections reload as a whole; keep the paginated cursor so a later
        // poll still observes writes that raced with that reload.
      }
      states.set(type,state);
    }
    this.states=states;this.identity=identity;
    if(changed)mailboxCache.clear();return changed;
  }
}
