import {EVENT_CAPABILITY} from './jmap-events.js';
import {readJmapJson} from './jmap.js';
import {mailboxCache} from './mailbox-cache.js';
const CORE='urn:ietf:params:jmap:core';
const MESSAGE='https://racrproto.com/ns/jmap/messages',DRAFT='https://racrproto.com/ns/jmap/drafts',ACCOUNT='https://racrproto.com/ns/jmap/account';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Each browser owns its cursor set. A lost cursor means refetching projections,
// never resetting server read state or drafts. No credentials/content persisted.
export class MailboxSync {
  private states=new Map<string,string>();
  private identity='';
  // The last Session read. It is read again only when a method response's
  // sessionState differs from it (RFC 8620 §3.4), not before every check.
  private session:Record<string,any>|null=null;
  eventsSupported=false;
  constructor(private transport:typeof fetch=fetch){}
  async poll():Promise<boolean>{
    // A failure may mean the Session changed (e.g. signed out); read it afresh next time.
    try{return await this.check();}catch(cause){this.session=null;throw cause;}
  }
  private async check():Promise<boolean>{
    const read=async(path:string,body?:unknown)=>{
      const response=await this.transport(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
        signal:AbortSignal.timeout(20_000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      if(!response.ok)throw new Error('Mailbox sync unavailable');
      return await readJmapJson(response,131072) as Record<string,any>;
    };
    for(let attempt=0;;attempt++){
      const session=this.session??await read('/api/jmap/session');
      if(!object(session)||!object(session.primaryAccounts)||!object(session.accounts)||typeof session.state!=='string')throw new Error('Invalid JMAP Session');
      this.session=session;
      const identity=JSON.stringify([session.username,session.primaryAccounts,session.state]);
      let changed=this.identity!==identity;
      const states=changed?new Map<string,string>():new Map(this.states);
      const selected:Array<[string,string,string]>=[];
      for(const [type,capability] of [['HailMessage',MESSAGE],['HailDraft',DRAFT],...['HailSent','HailSubmission','HailGrant','HailRelationship'].map(t=>[t,ACCOUNT])] as [string,string][]){
        const id=session.primaryAccounts[capability],cap=session.accounts[id]?.accountCapabilities?.[capability];
        if(typeof id==='string'&&object(cap)&&(capability!==ACCOUNT||Array.isArray(cap.types)&&cap.types.includes(type)))selected.push([type,capability,id]);
      }
      // All collections in as few requests as the provider allows (normally one),
      // tagged by type. Nothing is committed unless every collection succeeds.
      const limit=Number(session.capabilities?.[CORE]?.maxCallsInRequest),size=Number.isSafeInteger(limit)&&limit>0?limit:1;
      let sessionChanged=false;
      const invocations=new Map<string,unknown>();
      for(let start=0;start<selected.length;start+=size){
        const batch=selected.slice(start,start+size);
        const result=await read('/api/jmap',{using:[CORE,...new Set(batch.map(([,capability])=>capability))],methodCalls:batch.map(([type,,accountId])=>{
          const previous=states.get(type);
          return [type+(previous?'/changes':'/get'),{accountId,...(previous?{sinceState:previous,maxChanges:50}:{ids:[]})},type];
        })});
        if(!Array.isArray(result?.methodResponses)||result.methodResponses.length!==batch.length)throw new Error('Invalid sync response');
        if(typeof result.sessionState==='string'&&result.sessionState!==session.state)sessionChanged=true;
        batch.forEach(([type],index)=>invocations.set(type,result.methodResponses[index]));
      }
      // The account or its capabilities changed since the Session was read: these
      // answers may describe the wrong account. Read the Session again and start over.
      if(sessionChanged){this.session=null;if(attempt<1)continue;throw new Error('JMAP Session changed during sync');}
      for(const [type,,accountId] of selected){
        const previous=states.get(type),method=type+(previous?'/changes':'/get'),invocation=invocations.get(type);
        if(!Array.isArray(invocation)||invocation[2]!==type||!object(invocation[1]))throw new Error('Invalid sync response');
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
      this.eventsSupported=session.capabilities?.[EVENT_CAPABILITY]?.transport==='eventsource';
      if(changed)mailboxCache.clear();return changed;
    }
  }
}
