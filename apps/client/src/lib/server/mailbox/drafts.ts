import {canaryAccount} from '$lib/server/canary.js';
import {listDrafts} from '../jmap-drafts.js';
export async function load({cookies,url}: import("@sveltejs/kit").RequestEvent){
  const {account,client}=await canaryAccount(cookies,url),after=url.searchParams.get('after');
  const [result,preferences]=await Promise.all([listDrafts(client,after),client.jmap('HailMailbox/view',{view:'settings'})]);
  return {account,...result,paged:after!==null,trashEnabled:preferences.trashEnabled!==false};
}
