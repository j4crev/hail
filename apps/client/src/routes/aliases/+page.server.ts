import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseAliases,parseInboundEmail} from "$lib/inbound-email.js";

export async function load({cookies,url,setHeaders}){
  setHeaders({"cache-control":"no-store","referrer-policy":"no-referrer"});
  const {account,client}=await canaryAccount(cookies,url);
  const result=await client.jmap("HailEmailAlias/get",{}).catch(()=>({available:false}));
  const inboundEmail=parseInboundEmail(result);
  if(!inboundEmail.available)error(404,"Not found");
  return {account,inboundEmail,aliases:parseAliases((result as {aliases?:unknown}).aliases)};
}
