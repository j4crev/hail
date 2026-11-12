import type {OperatorStats} from "@racrproto/client-support/provider-contracts";
import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {AccountApiError} from "@racrproto/client-support/account-api";

type Invitation={id:string;email:string|null;created_at:string;expires_at:string;status:string;delivery:string};
type ServiceAccount={address:string;accountId:string;did:string|null;state:string;active:boolean;operator:boolean;passkeys:number};
type ServiceAccounts={accounts:ServiceAccount[];available:string[];recoveryKeySet:boolean};
export async function load({cookies,url}){
  const {account,client}=await canaryAccount(cookies,url);
  try{
    const result=await client.request("/invitations",undefined,"/api/v1/operator");
    if(!Array.isArray(result.invitations))error(502,"Invalid invitation list");
    const requested=url.searchParams.get("range")??"day";
    const range=["day","week","month"].includes(requested)?requested:"day";
    let stats:OperatorStats|null=null;
    try{stats=await client.request(`/stats?range=${range}`,undefined,"/api/v1/operator") as OperatorStats;}
    catch(cause){if(!(cause instanceof AccountApiError)||![429,503].includes(cause.status))throw cause;}
    const registration=await client.request("/registration",undefined,"/api/v1/operator");
    if(registration.mode!=="invite"&&registration.mode!=="public")error(502,"Invalid registration policy");
    let serviceAccounts:ServiceAccounts|null=null;
    try{
      const listed=await client.request("/service-accounts",undefined,"/api/v1/operator");
      if(Array.isArray(listed?.accounts)&&Array.isArray(listed?.available)&&typeof listed?.recoveryKeySet==="boolean")
        serviceAccounts=listed as ServiceAccounts;
    }catch(cause){if(!(cause instanceof AccountApiError)||![404,429,503].includes(cause.status))throw cause;}
    return {account,signupMode:registration.mode as "invite"|"public",invitations:result.invitations as Invitation[],stats,range,serviceAccounts};
  }catch(cause){
    if(cause instanceof AccountApiError){
      if(cause.status===403)error(403,"This account does not have provider operator access.");
      if(cause.status===404)error(404,"Provider invitations are not enabled on this server.");
    }
    throw cause;
  }
}
