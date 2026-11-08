import {formAttachments} from '$lib/server/attachments.js';
import {encodePayload} from "@racrproto/codec";
import {replyBody} from "$lib/reply.js";
import { canaryAccount } from "$lib/server/canary.js";
import { parseMessage,parseSentMessage } from "$lib/messages.js";
import { fail,isRedirect,redirect } from "@sveltejs/kit";

const respond=(all:boolean)=>async({params,request,cookies,url}:import("./$types").RequestEvent)=>{
  const form=await request.formData(),text=form.get("text"),id=form.get("messageId"),allowReply=form.get("allowReply")==="yes",replyUntil=Number(form.get("replyUntil"));
  if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)||
    (allowReply&&(!Number.isSafeInteger(replyUntil)||replyUntil<1))||typeof text!=="string"||!text.trim()||Buffer.byteLength(text)>65536)
    return fail(400,{error:"Enter a reply within the message limit.",messageId:undefined,replyUntil:undefined,allowReply,text:typeof text==="string"?text:""});
  try {
    const {client,account}=await canaryAccount(cookies,url);
    const ownSharedReply=all&&params.sender===account.did;
    const source=await client.request(ownSharedReply?`/sent/${encodeURIComponent(params.messageId)}`:`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`);
    const original=ownSharedReply?parseSentMessage(source):parseMessage(source);
    const body=replyBody(source,{sender:params.sender,messageId:params.messageId},text);
    if(encodePayload("hail.body.spt-2",body).length>1048576)
      return fail(400,{error:"This reply exceeds the message limit.",messageId:id,text,replyUntil,allowReply});
    const attachments=await formAttachments(form,client);
    const outbound=attachments.length?{...body,attachments}:body;
    if(all){
      const shared=original.sharedConversation;
      if(!shared||shared.state!=='active')return fail(409,{error:'Rejoin this conversation before replying to everyone.',messageId:id,text,replyUntil,allowReply});
      const result=await client.request('/connection-messages/reply-all',{publicationId:id,creator:shared.creator,conversationId:shared.conversationId,
        sender:original.sender,messageId:original.messageId,body:outbound});
      if(result.publicationId!==id)throw new Error('Provider acknowledged another reply');
      redirect(303,`/compose?audience=connections&publication=${id}`);
    }
    if(original.kind==="connection"&&!original.connection?.active)
      return fail(409,{error:"This connection is no longer active.",messageId:id,text,replyUntil,allowReply});
    const result=await client.request("/messages",{messageId:id,body:outbound,inReplyTo:{sender:original.sender,messageId:original.messageId},
      ...(original.kind==="connection"?{connectionId:original.connection!.id,connectionEpoch:original.connection!.epoch,recipientDid:original.sender}:
        {replyTo:original.messageId,...(allowReply?{replyUntil}:{})})});
    if(result.messageId!==id)throw new Error("Provider acknowledged another message");
    redirect(303,`/sent/${id}`);
  } catch(error_) {if(isRedirect(error_))throw error_;return fail(502,{error:"The reply could not be confirmed. Check its sent status before trying again.",messageId:id,text,replyUntil,allowReply});}
};
export const actions={reply:respond(false),replyAll:respond(true)};
