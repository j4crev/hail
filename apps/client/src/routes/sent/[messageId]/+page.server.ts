import {fail,isRedirect,redirect} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";


export const actions={retry:async({params,cookies,url})=>{
  try{const {client}=await canaryAccount(cookies,url),message=parseSentMessage(await client.jmap("HailMailbox/view",{view:"sentMessage",messageId:params.messageId}));
    if(message.state!=="indeterminate")return fail(409,{error:"Only a message without an authenticated receipt can be retried."});
    await client.jmap("HailSubmission/retry",{id:params.messageId});redirect(303,`/sent/${params.messageId}`);
  }catch(error_){if(isRedirect(error_))throw error_;return fail(502,{error:"Submission retry failed. Wait before trying again."});}
}};
