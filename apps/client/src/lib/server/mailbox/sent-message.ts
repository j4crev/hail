import {parseThread} from "$lib/threads.js";
import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {messageImageSource,parseSentMessage} from "$lib/messages.js";
import {AccountApiError} from "@racrproto/client-support/account-api";

export async function load({params,cookies,url}: import("@sveltejs/kit").RequestEvent<Record<string,string>>){
  const {client,account}=await canaryAccount(cookies,url);
  // One provider request for the message and its (optional) thread.
  const [result,threadResult]=await client.jmapBatch([
    ["HailMailbox/view",{view:"sentMessage",messageId:params.messageId,images:"reference"}],
    ["HailMailbox/view",{view:"threads",sender:account.did,messageId:params.messageId}],
  ]);
  // A busy provider or missing message keeps its status (e.g. 503 with Retry-After).
  if(result instanceof AccountApiError)throw result;
  try{
    const message=parseSentMessage(result!,messageImageSource(account.did,params.messageId!));
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    try{if(threadResult instanceof AccountApiError||message.sender!==account.did||message.messageId!==params.messageId)throw threadResult;thread=parseThread(threadResult!);}catch{threadUnavailable=true;}
    return {message,thread,threadUnavailable};
  }
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}
