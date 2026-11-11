import type {SQL} from 'bun';
import {draftIdPattern,parseDraftContent} from '@racrproto/client-support/drafts';
import {validateAttachmentBytes} from '../bodies/attachments.js';
export const DRAFT_TABLES=['account_message_preferences','account_message_drafts'] as const;
type Row=Record<string,unknown>;
export async function collectDraftHistory(sql:SQL,account:string){
  return {
    account_message_preferences:(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM account_message_preferences t WHERE account_id=${account}`).map(r=>r.row),
    account_message_drafts:(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM account_message_drafts t WHERE account_id=${account} ORDER BY id`).map(r=>r.row),
  };
}
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
export function validateDraftHistory(manifest:{accountId:string;tables:Record<string,Row[]>}){
  const t=manifest.tables,prefs=t.account_message_preferences!,drafts=t.account_message_drafts!;
  if(prefs.length>1)throw Error('Duplicate mailbox preferences');
  for(const row of prefs)if(Object.keys(row).sort().join(',')!=='account_id,show_header_images,start_screen,theme,trash_enabled'||row.account_id!==manifest.accountId||
    typeof row.trash_enabled!=='boolean'||![null,'system','light','dark'].includes(row.theme as null|string)||
    row.show_header_images!==null&&typeof row.show_header_images!=='boolean'||!['feed','inbox'].includes(String(row.start_screen)))throw Error('Invalid mailbox preferences');
  const ids=new Set<string>();
  for(const row of drafts){
    if(Object.keys(row).sort().join(',')!=='account_id,content,id,revision,trashed_at,updated_at'||row.account_id!==manifest.accountId||
      typeof row.id!=='string'||!draftIdPattern.test(row.id)||ids.has(row.id)||!Number.isInteger(row.revision)||Number(row.revision)<1||Number(row.revision)>2147483647||
      !date(row.updated_at)||row.trashed_at!==null&&!date(row.trashed_at))throw Error('Invalid draft history');
    ids.add(row.id);const content=parseDraftContent(row.content);
    if(Buffer.byteLength(JSON.stringify(content))>400000)throw Error('Draft history exceeds content limit');
    if(t.sent_envelopes!.some(sent=>sent.message_id===row.id))throw Error('Draft history reuses a sent message ID');
    for(const file of content.attachments??[]){
      const digest=Buffer.from(file.digest.value,'base64url'),hex='\\x'+digest.toString('hex');
      const blob=t.attachment_blobs!.find(b=>b.digest===hex);
      if(!blob||!t.attachment_uploads!.some(upload=>upload.account_id===manifest.accountId&&upload.digest===hex))throw Error('Draft history lacks an owned attachment upload');
      validateAttachmentBytes({...file,digest:{algorithm:'sha-256',value:digest}},Buffer.from(String(blob.bytes).slice(2),'hex'));
    }
  }
}
