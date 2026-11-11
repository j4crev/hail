import type {SQL} from 'bun';
import type {AccountApiSession} from './repository.js';
import {UserGrantError} from '../grants/service.js';

export async function lockMessageAccount(tx:SQL,session:AccountApiSession){
  const accounts=await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did}
    AND onboarding_state='active' AND closed_at IS NULL FOR UPDATE`;
  if(!accounts.length)throw new UserGrantError(409,'Account is unavailable');
  await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
}
export async function setReadInTransaction(tx:SQL,session:AccountApiSession,sender:string,id:string,isRead:boolean){
  const rows=await tx`UPDATE delivered_messages SET is_read=${isRead}
    WHERE recipient_did=${session.did} AND sender_did=${sender} AND message_id=${id} AND trashed_at IS NULL RETURNING message_id`;
  return rows.length?{messageId:id,isRead}:null;
}
