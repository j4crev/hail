import {canaryAccount} from "$lib/server/canary.js";
import {parseSentSends} from "$lib/messages.js";

export async function load({url,cookies}: import("@sveltejs/kit").RequestEvent){
  const {account,client}=await canaryAccount(cookies,url),after=url.searchParams.get("after");
  const page=parseSentSends(await client.jmap("HailMailbox/view",{view:"sentSends",after},2_000_000));
  const preferences=await client.jmap("HailMailbox/view",{view:"settings"});
  return {trashEnabled:preferences.trashEnabled!==false,configured:true as const,account,paged:after!==null,next:page.next,messages:page.messages};
}
