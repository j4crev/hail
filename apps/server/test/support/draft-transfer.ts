import contentVectors from '../../../../spec/vectors/provider-drafts.json';
import {randomUUID,createHash} from 'node:crypto';
import type {SQL} from 'bun';
import {expect} from 'vitest';
import {storeAttachment} from '../../src/bodies/attachments.js';
/** Synthetic owner data only; exact comparisons include original Trash deadlines. */
export async function draftTransferFixture(sql:SQL,account:string){
  const active=Bun.randomUUIDv7(),trashed=Bun.randomUUIDv7(),removed=Bun.randomUUIDv7(),fresh=Bun.randomUUIDv7();
  const bytes=new TextEncoder().encode('Unsent draft attachment '+randomUUID()),digest=new Uint8Array(createHash('sha256').update(bytes).digest());
  await storeAttachment(sql,digest,bytes);
  await sql`INSERT INTO attachment_uploads(account_id,digest) VALUES(${account},${digest})`;
  const content={audience:'connections',connections:[Bun.randomUUIDv7()],category:'',title:'Unfinished',text:'Keep these editable fields',alt:'',caption:'',header:null,forward:{sender:'did:plc:'+'a'.repeat(24),messageId:Bun.randomUUIDv7()},allowReply:false,
    attachments:[{filename:'draft.txt',media_type:'text/plain',size:bytes.length,digest:{algorithm:'sha-256',value:Buffer.from(digest).toString('base64url')}}]};
  await sql`INSERT INTO account_message_preferences(account_id,trash_enabled,theme,show_header_images,start_screen) VALUES(${account},true,'dark',false,'inbox')`;
  for(const id of [active,trashed,removed])await sql`INSERT INTO account_message_drafts(account_id,id,content,trashed_at)
    VALUES(${account},${id},${JSON.stringify(id===trashed?{...contentVectors.valid.find(v=>v.name==='builder-unfinished-header-description')!.content,attachments:content.attachments}:content)}::text::jsonb,CASE WHEN ${id===trashed} THEN clock_timestamp()-interval '2 days' ELSE NULL END)`;
  // Compare persisted rows, not runtime-specific SQL result metadata.
  const rows=async(db:SQL)=>Array.from(await db<{row:Record<string,unknown>}[]>`SELECT to_jsonb(d) AS row FROM account_message_drafts d WHERE account_id=${account} ORDER BY id`);
  let expected=await rows(sql);
  const assert=async(db:SQL)=>{
    expect(await rows(db)).toEqual(expected);
    expect((await db`SELECT trash_enabled,theme,show_header_images,start_screen FROM account_message_preferences WHERE account_id=${account}`)[0])
      .toEqual({trash_enabled:true,theme:'dark',show_header_images:false,start_screen:'inbox'});
    expect(Buffer.from((await db`SELECT b.bytes FROM attachment_uploads u JOIN attachment_blobs b USING(digest) WHERE u.account_id=${account} AND u.digest=${digest}`)[0]!.bytes)).toEqual(Buffer.from(bytes));
    expect(await db`SELECT 1 FROM sent_envelopes WHERE sender_account_id=${account} AND message_id IN (${active},${trashed},${removed},${fresh})`).toHaveLength(0);
  };
  return {assert,async editAtDestination(db:SQL){
    await assert(db);
    await db`UPDATE account_message_drafts SET content=${JSON.stringify({...content,text:'Edited at the destination'})}::text::jsonb,
      revision=revision+1,updated_at=clock_timestamp() WHERE account_id=${account} AND id=${active}`;
    await db`DELETE FROM account_message_drafts WHERE account_id=${account} AND id=${removed}`;
    await db`INSERT INTO account_message_drafts(account_id,id,content) VALUES(${account},${fresh},${JSON.stringify(content)}::text::jsonb)`;
    expected=await rows(db);
  }};
}
