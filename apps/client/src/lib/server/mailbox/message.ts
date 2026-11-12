import {parseThread} from "$lib/threads.js";
import { canaryAccount, senderAvatars } from "$lib/server/canary.js";
import {senderSubscription} from "$lib/server/subscription.js";
import { messageId } from "$lib/server/message-id.js";
import { parseMessage } from "$lib/messages.js";
import { error,isRedirect,redirect } from "@sveltejs/kit";
import {AccountApiError} from "@racrproto/client-support/account-api";

export async function load({ params,cookies,url }: import("@sveltejs/kit").RequestEvent<Record<string,string>>) {
  const { account, client } = await canaryAccount(cookies,url);
  const managed = account.custodyProfile === "managed";
  // One provider request for the message, its thread and (managed accounts) the
  // sender's first page of subscriptions, instead of one round trip each. The
  // thread and subscription are optional: their failures leave the message readable.
  const [result, threadResult, grants] = await client.jmapBatch([
    ["HailMailbox/view",{view:"read",sender:params.sender,messageId:params.messageId}],
    ["HailMailbox/view",{view:"threads",sender:params.sender,messageId:params.messageId}],
    ...(managed ? [["HailGrant/list",{sender:params.sender}] as [string, Record<string, string>]] : []),
  ]);
  if (result instanceof AccountApiError) throw result;
  try {
    const message=parseMessage(result!);
    // The batched lookups were keyed by the requested identity; use them only for that message.
    const requested = message.sender === params.sender && message.messageId === params.messageId;
    if(message.sharedConversation&&!message.trashedAt)redirect(303,`/conversation/${encodeURIComponent(message.sender)}/${message.messageId}`);
    let subscription: Awaited<ReturnType<typeof senderSubscription>> = null, subscriptionUnavailable = false;
    if (message.kind !== "connection" && managed) {
      try {
        if (grants instanceof AccountApiError || !requested) throw grants;
        subscription = await senderSubscription(client, account.did, message.sender, grants);
      }
      catch {subscriptionUnavailable = true;}
    }
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    if(!message.trashedAt){try{if(threadResult instanceof AccountApiError||!requested)throw threadResult;thread=parseThread(threadResult);}catch{threadUnavailable=true;}}
    return {message,account,subscription,subscriptionUnavailable,thread,threadUnavailable,newReplyId:messageId(),newReplyUntil:Math.floor(Date.now()/1000)+7*86400,canReply:!message.trashedAt&&(message.connection?.active??message.replyAvailable),
      avatar:(await senderAvatars(client,new Set([message.sender]))).get(message.sender)??null};
  } catch (cause) {
    if(isRedirect(cause))throw cause;
    error(502, "The provider returned a message this GUI cannot safely render");
  }
}
