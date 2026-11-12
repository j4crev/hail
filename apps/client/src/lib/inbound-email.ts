import {startAuthentication} from '@simplewebauthn/browser';
import {approval,permissionRequest,recoverPermission,type Approval} from './permissions.js';

export interface InboundEmailOff {available:false}
export interface InboundEmailOn {
  available:true;domain:string;sender:{address:string;category:string};enabled:boolean;
  grant:{grantId:string;revision:number;digest:string}|null;
}
export type InboundEmail=InboundEmailOff|InboundEmailOn;
export interface EmailAlias {id:string;address:string;label:string;createdAt:string;lastReceivedAt:string|null;messageCount:number}

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));

export function parseInboundEmail(value:unknown):InboundEmail {
  if(!object(value))throw new Error('Invalid inbound email state');
  if(value.available===false)return {available:false};
  const {domain,sender,enabled,grant}=value;
  if(value.available!==true||typeof domain!=='string'||!/^[a-z0-9.-]{1,253}$/.test(domain)||!object(sender)||typeof sender.address!=='string'||
    typeof sender.category!=='string'||typeof enabled!=='boolean'||grant!==null&&(!object(grant)||!UUID.test(grant.grantId)||
    !Number.isSafeInteger(grant.revision)||typeof grant.digest!=='string')||enabled!==(grant!==null))throw new Error('Invalid inbound email state');
  return {available:true,domain,sender:{address:sender.address,category:sender.category},enabled,grant};
}

export function parseAliases(value:unknown):EmailAlias[] {
  if(!Array.isArray(value)||value.length>50)throw new Error('Invalid alias list');
  return value.map(alias=>{
    if(!object(alias)||!UUID.test(alias.id)||typeof alias.address!=='string'||typeof alias.label!=='string'||!date(alias.createdAt)||
      alias.lastReceivedAt!==null&&!date(alias.lastReceivedAt)||!Number.isSafeInteger(alias.messageCount)||alias.messageCount<0)throw new Error('Invalid alias');
    return {id:alias.id,address:alias.address,label:alias.label,createdAt:alias.createdAt,lastReceivedAt:alias.lastReceivedAt,messageCount:alias.messageCount};
  });
}

export class PasskeyCancelled extends Error {constructor(){super('Passkey confirmation wasn’t completed. Try again when you’re ready.');}}

/**
 * Turning inbound email on grants the provider's email bridge account its
 * category; turning it off revokes that Grant. Both are the ordinary
 * passkey-confirmed subscription changes, so they also appear in Subscriptions.
 */
export async function setInboundEmail(state:InboundEmailOn,enabled:boolean,did:string):Promise<void> {
  let draft:Record<string,unknown>;
  if(enabled){
    const review=await permissionRequest('review',{sender:state.sender.address});
    if(review?.address!==state.sender.address||!Array.isArray(review.categories)||!review.categories.some((c:{id?:unknown})=>c?.id===state.sender.category))
      throw new Error('Inbound email is unavailable right now. Try again later.');
    draft={requestId:crypto.randomUUID(),action:'allow',sender:review.address,senderDid:review.did,addressDigest:review.addressDigest,
      profileDigest:review.profileDigest,scope:{type:'categories',values:[state.sender.category]},expiresAt:null};
  }else{
    if(!state.grant)return;
    draft={requestId:crypto.randomUUID(),action:'revoke',...state.grant};
  }
  let prepared:Approval=approval(await permissionRequest('prepare',draft));
  if(prepared.permission.grantor!==did||prepared.action!==(enabled?'allow':'revoke'))throw new Error('Inbound email change does not match this account');
  if(!prepared.approved){
    let response;
    try{response=await startAuthentication({optionsJSON:prepared.options!});}catch{throw new PasskeyCancelled();}
    try{prepared=approval(await permissionRequest('commit',{requestId:prepared.requestId,response}));}catch{/* Recovered below. */}
  }
  // An interrupted commit may still have been saved; recovery finishes it without asking again.
  if(!prepared.result)prepared=await recoverPermission(prepared.requestId,did);
  if(!prepared.result)throw new Error('We couldn’t confirm the change. Refresh to check.');
}
