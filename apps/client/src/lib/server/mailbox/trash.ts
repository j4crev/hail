import {listSummary} from './summary.js';
import {listDrafts} from '../jmap-drafts.js';
import {canaryAccount,senderAvatars} from '$lib/server/canary.js';
import {messageImageSource,parseMessage,parseSentSends} from '$lib/messages.js';
export async function load({cookies,url}: import("@sveltejs/kit").RequestEvent){
  const {account,client}=await canaryAccount(cookies,url);
  const after=url.searchParams.get('after');
  const [result,preferences,sentResult,draftsResult]=await Promise.all([
    client.jmap('HailMailbox/view',{view:'inboxFeed',after,trash:true,images:'reference'},2_000_000),
    client.jmap('HailMailbox/view',{view:'settings'}),
    client.jmap('HailMailbox/view',{view:'sentSends',trash:true,after:url.searchParams.get('sentAfter')},2_000_000),
    listDrafts(client,url.searchParams.get('draftAfter'),true),
  ]);
  if(!Array.isArray(result.messages)||!(result.next===null||typeof result.next==='string'))throw new Error('Invalid Trash response');
  const messages=result.messages.map((row:any)=>{
    if(typeof row.trashedAt!=='string'||!Number.isFinite(Date.parse(row.trashedAt)))throw new Error('Invalid Trash date');
    const message=parseMessage(row,messageImageSource(String(row.sender),String(row.messageId)));return {...listSummary(message),trashedAt:row.trashedAt};
  });
  const avatars=await senderAvatars(client,new Set<string>(messages.map(message=>message.sender)));
  return {drafts:draftsResult,draftPaged:url.searchParams.has('draftAfter'),sent:parseSentSends(sentResult),sentPaged:url.searchParams.has('sentAfter'),account,trashEnabled:preferences.trashEnabled!==false,paged:after!==null,next:result.next,messages:messages.map(message=>({...message,avatar:avatars.get(message.sender)??null}))};
}
