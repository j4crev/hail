import {createHash} from "node:crypto";
import type {VerifiedHailObject,HailConversation} from "@racrproto/codec";
import type {SQL} from "bun";
import type {PlcResolutionEvidence} from "../plc/resolver.js";
import type {AccountApiSession} from "./repository.js";
import {ConnectionError} from "./connection-error.js";
import {connectionMessageAllowed,type ConnectionMessageAuthorization} from "./connection-authorization.js";
import {conversationIntroductionAllowed} from "./conversation-preferences.js";

export interface ConversationIdentity {creator:string;conversationId:string;}
type Owner=Pick<AccountApiSession,"account_id"|"did">;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function conversationIdentity(input:Record<string,unknown>):ConversationIdentity {
  if(typeof input.creator!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(input.creator)||typeof input.conversationId!=="string"||!idPattern.test(input.conversationId))
    throw new ConnectionError(400,"Invalid conversation identity.");
  return {creator:input.creator,conversationId:input.conversationId};
}
async function clock(tx:SQL){return new Date((await tx<{now:Date}[]>`SELECT clock_timestamp() AS now`)[0]!.now);}

// Call admission only with a signature verified against fresh creator authority
// and an independently checked current coordinator snapshot. This function owns
// the final local policy/connection check under the account disconnect barrier.
export async function admitConversation(tx:SQL,owner:Owner,descriptor:VerifiedHailObject<HailConversation>,
  proof:{signingKey:string;evidence:PlcResolutionEvidence;connection?:ConnectionMessageAuthorization}){
  const d=descriptor.payload,identity={creator:d.from,conversationId:d.conversation_id};
  if(descriptor.type!=="hail.conversation"||!d.participants.includes(owner.did))return false;
  if(owner.did!==d.from){
    if(!proof.connection||!await connectionMessageAllowed(tx,owner.did,d.from,proof.connection,true)||
      !await conversationIntroductionAllowed(tx,owner.account_id,proof.connection.connection_id,proof.connection.epoch))return false;
  }
  await lockOwner(tx,owner);
  const digest=hash(descriptor.representationBytes);
  const previous=(await tx<{descriptor_hash:Uint8Array}[]>`SELECT descriptor_hash FROM conversation_descriptors
    WHERE creator_did=${d.from} AND conversation_id=${d.conversation_id}`)[0];
  if(previous&&!same(previous.descriptor_hash,digest))throw new ConnectionError(409,"Conversation descriptor conflicts with its original roster.");
  const now=await clock(tx);
  if(d.created_at>now.getTime()/1000+300||d.admission_until+300<now.getTime()/1000)return false;
  if(!previous){
    // Bind JSON as text before PostgreSQL expands it: Bun 1.4.0's array helper
    // persists extra quotes, and direct jsonb parameters re-encode JSON strings.
    await tx`INSERT INTO conversation_descriptors(creator_did,conversation_id,descriptor_hash,descriptor_cose,participants,created_at,admission_until,signing_key,signing_evidence)
      VALUES(${d.from},${d.conversation_id},${digest},${descriptor.representationBytes},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(d.participants)}::text::jsonb)),${new Date(d.created_at*1000)},${new Date(d.admission_until*1000)},${proof.signingKey},${JSON.stringify(proof.evidence)}::jsonb)
      ON CONFLICT(creator_did,conversation_id) DO NOTHING`;
    const winner=(await tx<{descriptor_hash:Uint8Array}[]>`SELECT descriptor_hash FROM conversation_descriptors WHERE creator_did=${d.from} AND conversation_id=${d.conversation_id}`)[0]!;
    if(!same(winner.descriptor_hash,digest))throw new ConnectionError(409,"Conversation descriptor conflict.");
  }
  await tx`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state)
    VALUES(${owner.account_id},${d.from},${d.conversation_id},'active') ON CONFLICT DO NOTHING`;
  return (await conversationState(tx,owner,identity))?.state==="active";
}

export async function lockOwner(tx:SQL,owner:Owner){
  if(!(await tx`SELECT id FROM provider_accounts WHERE id=${owner.account_id} AND did=${owner.did}
    AND onboarding_state='active' AND activation_verification_mode='public' AND closed_at IS NULL FOR UPDATE`).length)
    throw new ConnectionError(409,"Current account is unavailable.");
  await tx`SELECT hail_assert_unfenced_account(${owner.account_id}::uuid)`;
}

export async function conversationState(tx:SQL,owner:Owner,identity:ConversationIdentity){
  const row=(await tx<{state:string;expires_at:Date;participants:string[];descriptor_hash:Uint8Array}[]>`
    SELECT CASE WHEN m.state='left' THEN 'left' WHEN m.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS state,
      m.expires_at,d.participants,d.descriptor_hash
    FROM conversation_memberships m JOIN conversation_descriptors d USING(creator_did,conversation_id)
    WHERE m.account_id=${owner.account_id} AND m.creator_did=${identity.creator} AND m.conversation_id=${identity.conversationId}`)[0];
  return row?{...identity,state:row.state as "active"|"expired"|"left",expiresAt:row.expires_at.toISOString(),participants:row.participants,
    descriptorHash:row.descriptor_hash}:null;
}

export async function conversationMessageAllowed(tx:SQL,ownerDid:string,senderDid:string,identity:ConversationIdentity,descriptorHash:Uint8Array,lock=false){
  const owner=(await tx<{id:string}[]>`SELECT id FROM provider_accounts WHERE did=${ownerDid} AND onboarding_state='active'
    AND activation_verification_mode='public' AND closed_at IS NULL`)[0];
  if(!owner||ownerDid===senderDid)return false;
  if(lock)await lockOwner(tx,{account_id:owner.id,did:ownerDid});
  const rows=await tx`SELECT 1 FROM conversation_memberships m JOIN conversation_descriptors d USING(creator_did,conversation_id)
    WHERE m.account_id=${owner.id} AND m.creator_did=${identity.creator} AND m.conversation_id=${identity.conversationId}
      AND d.descriptor_hash=${descriptorHash} AND ${senderDid}=ANY(d.participants) AND ${ownerDid}=ANY(d.participants)
      AND m.state='active' AND m.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences WHERE account_id=${owner.id})`;
  return rows.length>0;
}

// Leaving and expiry revoke authority without removing saved mailbox history.
export async function changeConversationMembership(tx:SQL,owner:Owner,identity:ConversationIdentity,action:"reply"|"leave"|"rejoin"){
  await lockOwner(tx,owner);
  const current=await conversationState(tx,owner,identity);
  if(!current)throw new ConnectionError(404,"Conversation unavailable.");
  const now=await clock(tx);
  if(action==="rejoin"&&(current.state!=="left"||Date.parse(current.expiresAt)<=now.getTime()))
    throw new ConnectionError(409,"Only unexpired participation you left can be rejoined. Start a new conversation after expiry.");
  if(action==="reply"&&current.state!=="active")
    throw new ConnectionError(409,"Participation is inactive. Start a new conversation after expiry.");
  if(action==="leave")await tx`UPDATE conversation_memberships SET state='left',left_at=COALESCE(left_at,clock_timestamp())
    WHERE account_id=${owner.account_id} AND creator_did=${identity.creator} AND conversation_id=${identity.conversationId}`;
  else {
    const changed=action==="rejoin"
      ?await tx`UPDATE conversation_memberships SET state='active',left_at=NULL
        WHERE account_id=${owner.account_id} AND creator_did=${identity.creator} AND conversation_id=${identity.conversationId}
          AND state='left' AND expires_at>clock_timestamp() RETURNING account_id`
      :await tx`UPDATE conversation_memberships SET last_activity_at=clock_timestamp(),expires_at=clock_timestamp()+interval '90 days'
        WHERE account_id=${owner.account_id} AND creator_did=${identity.creator} AND conversation_id=${identity.conversationId}
          AND state='active' AND expires_at>clock_timestamp() RETURNING account_id`;
    if(!changed.length)throw new ConnectionError(409,"Participation expired. Start a new conversation.");
  }
  return conversationState(tx,owner,identity);
}

// Compact permission rows remain while saved envelopes/outboxes reference them.
// Cleanup never deletes delivered messages or bodies.
export async function pruneConversationState(sql:SQL){
  const owners=await sql<{account_id:string;did:string}[]>`SELECT DISTINCT m.account_id,a.did FROM conversation_memberships m
    JOIN provider_accounts a ON a.id=m.account_id WHERE a.onboarding_state='active' AND a.closed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      AND ((m.expires_at<clock_timestamp() OR m.state='left')
          AND EXISTS(SELECT 1 FROM conversation_descriptors d WHERE d.creator_did=m.creator_did AND d.conversation_id=m.conversation_id AND d.admission_until<clock_timestamp()-interval '5 minutes')
          AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.sender_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.local_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM connection_message_batches b WHERE b.account_id=m.account_id AND b.conversation_context IS NOT NULL)) LIMIT 20`;
  for(const owner of owners)await sql.begin(async tx=>{
    await lockOwner(tx,owner);
    await tx`DELETE FROM conversation_memberships m USING conversation_descriptors d
      WHERE m.account_id=${owner.account_id} AND m.creator_did=d.creator_did AND m.conversation_id=d.conversation_id
        AND (m.state='left' OR m.expires_at<clock_timestamp()) AND d.admission_until<clock_timestamp()-interval '5 minutes'
        AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.sender_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.local_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM connection_message_batches b WHERE b.account_id=m.account_id AND b.conversation_context IS NOT NULL)`;
  });
  await sql`DELETE FROM conversation_descriptors d WHERE (d.creator_did,d.conversation_id) IN(
    SELECT creator_did,conversation_id FROM conversation_descriptors c WHERE c.admission_until<clock_timestamp()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM conversation_memberships m WHERE m.creator_did=c.creator_did AND m.conversation_id=c.conversation_id)
      AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.conversation_creator=c.creator_did AND e.conversation_id=c.conversation_id)
      AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.conversation_creator=c.creator_did AND e.conversation_id=c.conversation_id) LIMIT 100)`;
}
