import {canaryAccount} from "$lib/server/canary.js";
import {parseConversationPreferences} from "$lib/conversation-preferences.js";
import {parseInboundEmail} from "$lib/inbound-email.js";
export async function load({cookies, url, setHeaders}) {
  setHeaders({"cache-control":"no-store"});
  const {account,client} = await canaryAccount(cookies, url);
  const [preferences,conversations,inboundEmail]=await Promise.all([
    client.jmap("HailMailbox/view",{view:"settings"}),
    client.jmap("HailRelationship/conversationPreferences").then(parseConversationPreferences),
    // Optional: a provider without the email bridge, or an older one, simply has no setting.
    client.jmap("HailEmailAlias/get",{summary:true}).then(parseInboundEmail).catch(()=>({available:false as const})),
  ]);
  return {account,trashEnabled:preferences.trashEnabled!==false,allowIntroductions:conversations.allowIntroductions,inboundEmail};
}
