import {parseThread} from "$lib/threads.js";
import { canaryAccount, senderAvatars } from "$lib/server/canary.js";
import {senderSubscription} from "$lib/server/subscription.js";
import { messageId } from "$lib/server/message-id.js";
import { parseMessage } from "$lib/messages.js";
import { error,isRedirect,redirect } from "@sveltejs/kit";

export async function load({ params,cookies,url }: import("@sveltejs/kit").RequestEvent<Record<string,string>>) {
  const { account, client } = await canaryAccount(cookies,url);
  const result = await client.jmap("HailMailbox/view",{view:"read",sender:params.sender,messageId:params.messageId});
  try {
    const message=parseMessage(result);
    if(message.sharedConversation&&!message.trashedAt)redirect(303,`/conversation/${encodeURIComponent(message.sender)}/${message.messageId}`);
    let subscription: Awaited<ReturnType<typeof senderSubscription>> = null, subscriptionUnavailable = false;
    if (message.kind !== "connection" && account.custodyProfile === "managed") {
      try {subscription = await senderSubscription(client, account.did, message.sender);}
      catch {subscriptionUnavailable = true;}
    }
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    if(!message.trashedAt){try{thread=parseThread(await client.jmap("HailMailbox/view",{view:"threads",sender:message.sender,messageId:message.messageId}));}catch{threadUnavailable=true;}}
    return {message,account,subscription,subscriptionUnavailable,thread,threadUnavailable,newReplyId:messageId(),newReplyUntil:Math.floor(Date.now()/1000)+7*86400,canReply:!message.trashedAt&&(message.connection?.active??message.replyAvailable),
      avatar:(await senderAvatars(client,new Set([message.sender]))).get(message.sender)??null};
  } catch (cause) {
    if(isRedirect(cause))throw cause;
    error(502, "The provider returned a message this GUI cannot safely render");
  }
}
