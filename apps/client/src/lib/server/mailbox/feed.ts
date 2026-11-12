import {listSummary} from './summary.js';
import {redirect} from "@sveltejs/kit";
import {registration} from "$lib/server/registration.js";
import {returnPath} from "$lib/auth-routing.js";
import { canaryAccount, isConfigured, senderAvatars } from "$lib/server/canary.js";
import { parseInboxFeed } from "$lib/messages.js";

export async function load({url,cookies,fetch,setHeaders}: import("@sveltejs/kit").RequestEvent) {
  if (url.searchParams.has("next")) {setHeaders({"cache-control":"no-store"});return {configured:false as const,returnTo:returnPath(url.searchParams.get("next")),registration:await registration(fetch)};}
  const view=url.searchParams.get("view")==="connections"?"connections":"subscriptions";
  if (!isConfigured(cookies)&&view!=="connections") {setHeaders({"cache-control":"no-store"});return { configured: false as const,returnTo:"/",registration:await registration(fetch) };}
  const { account, client } = await canaryAccount(cookies,url);
  if (!url.searchParams.has("view")) {
    setHeaders({"cache-control":"no-store"});
    const preferences = await client.jmap("HailMailbox/view",{view:"settings"});
    if (preferences.startScreen === "inbox") {
      const destination = new URL(url);
      destination.searchParams.set("view", "connections");
      redirect(307, destination.pathname + destination.search);
    }
  }
  const after=url.searchParams.get("after"),page=parseInboxFeed(await client.jmap("HailMailbox/view",{view:view==="connections"?"connectionInbox":"inboxFeed",...(view==="connections"?{}:{channel:view,images:"reference"}),after},2_000_000),view!=="connections");
  const avatars=await senderAvatars(client,new Set(page.messages.map(message=>message.sender)));
  return {configured:true as const,account,view,paged:after!==null,next:page.next,messages:page.messages.map(message=>({...listSummary(message), avatar:avatars.get(message.sender)??null}))};
}
