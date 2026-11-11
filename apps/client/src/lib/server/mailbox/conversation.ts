import {canaryAccount,senderAvatars} from '$lib/server/canary.js';
import {parseConversation} from '$lib/connection-threads.js';
import {parseMessage,parseSentMessage} from '$lib/messages.js';
import {messageId} from '$lib/server/message-id.js';
export async function load({params,cookies,url}: import("@sveltejs/kit").RequestEvent<Record<string,string>>) {
  const {client,account}=await canaryAccount(cookies,url);
  const thread=parseConversation(await client.jmap("HailMailbox/view",{view:"connectionThread",sender:params.sender,messageId:params.messageId}));
  const selected=thread.selected;
  const raw=await client.jmap("HailMailbox/view",{view:selected.sent?"sentMessage":"read",...(selected.sent?{}:{sender:selected.sender}),messageId:selected.messageId});
  const message=selected.sent?parseSentMessage(raw):parseMessage(raw);
  const avatars=await senderAvatars(client,new Set(thread.messages.filter(m=>!m.sent).map(m=>m.sender)));
  return {account,thread,message,avatars:Object.fromEntries(avatars),root:params,newReplyId:messageId()};
}
