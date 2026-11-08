import {parseThread} from "$lib/threads.js";
import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";

export async function load({params,cookies,url}: import("@sveltejs/kit").RequestEvent<Record<string,string>>){
  const {client}=await canaryAccount(cookies,url);
  try{
    const message=parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`));
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    try{thread=parseThread(await client.request(`/threads/${encodeURIComponent(message.sender)}/${message.messageId}`));}catch{threadUnavailable=true;}
    return {message,thread,threadUnavailable};
  }
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}
