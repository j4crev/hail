import {readJmapJson} from './jmap.js';

const CORE='urn:ietf:params:jmap:core';
const TYPES=['HailMessage','HailDraft','HailSent','HailSubmission','HailGrant','HailRelationship'];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export interface PushDependencies {
  request:typeof fetch;
  notify:(title:string,options:NotificationOptions)=>Promise<void>;
}

// Push data is a hint, never content or a navigation target. Check the current
// browser session before showing a hint queued for a previous login/account.
export async function handlePush(value:unknown,deps:PushDependencies):Promise<void>{
  try{
    if(!object(value)||JSON.stringify(value).length>8192)return;
    const read=async(path:string,body?:unknown)=>{
      const response=await deps.request(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
        signal:AbortSignal.timeout(15_000),headers:{'X-Hail-Background':'true',...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw new Error('Push authorization unavailable');
      const data=await readJmapJson(response,65536);
      if(!object(data))throw new Error('Invalid push response');return data;
    };
    if(value['@type']==='PushVerification'){
      if(!exact(value,['@type','pushSubscriptionId','verificationCode'])||typeof value.pushSubscriptionId!=='string'||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.pushSubscriptionId)||
        typeof value.verificationCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.verificationCode))return;
      const id=value.pushSubscriptionId;
      const response=await read('/api/jmap',{using:[CORE],methodCalls:[['PushSubscription/set',{
        update:{[id]:{verificationCode:value.verificationCode}}
      },'verify-push']]});
      const calls=response.methodResponses;
      if(!Array.isArray(calls)||calls.length!==1||!Array.isArray(calls[0])||calls[0].length!==3||calls[0][0]!=='PushSubscription/set'||
        calls[0][2]!=='verify-push'||!object(calls[0][1])||!object(calls[0][1].updated)||!Object.hasOwn(calls[0][1].updated,id)||
        object(calls[0][1].notUpdated)&&Object.hasOwn(calls[0][1].notUpdated,id))return;
      await deps.notify('Hail',{body:'Notifications enabled.',tag:'hail-updates'});return;
    }
    if(value['@type']!=='StateChange'||!exact(value,['@type','changed'])||!object(value.changed))return;
    const entries=Object.entries(value.changed);
    if(entries.length!==1)return;
    const [accountId,states]=entries[0]!;
    if(!/^[A-Za-z0-9_-]{1,255}$/.test(accountId)||!object(states)||!Object.keys(states).length||
      Object.entries(states).some(([type,state])=>!TYPES.includes(type)||typeof state!=='string'||!state.length||state.length>1024))return;
    const session=await read('/api/jmap/session');
    if(!object(session.accounts)||!Object.hasOwn(session.accounts,accountId)||!object(session.accounts[accountId])||
      !object(session.primaryAccounts)||!Object.values(session.primaryAccounts).includes(accountId))return;
    await deps.notify('Hail',{body:'Your mailbox has updates.',tag:'hail-updates'});
  }catch{/* Expired login, denied notifications and network failures stay silent. */}
}
