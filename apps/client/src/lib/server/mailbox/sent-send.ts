import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentSend} from "$lib/messages.js";

export async function load({params,cookies,url}: import("@sveltejs/kit").RequestEvent<Record<string,string>>){
  if(!["category","connections","message"].includes(params.kind))error(404,"Sent message not found");
  const {client}=await canaryAccount(cookies,url);
  return {trash:url.searchParams.get("trash")==="true",message:parseSentSend(await client.jmap("HailMailbox/view",{view:"sentSend",messageId:params.messageId,kind:params.kind,trash:url.searchParams.get("trash")==="true"},2_000_000))};
}
