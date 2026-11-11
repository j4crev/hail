import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {validateDraftHistory} from '../src/migration/draft-history.js';
const account='00000000-0000-4000-8000-000000000001',id='019a0000-0000-7000-8000-000000000001';
function fixture(){
  const bytes=Buffer.from('draft file'),digest=createHash('sha256').update(bytes).digest(),hex='\\x'+digest.toString('hex');
  return {accountId:account,tables:{account_message_preferences:[{account_id:account,trash_enabled:true,theme:null,show_header_images:null,start_screen:'feed'}],
    account_message_drafts:[{account_id:account,id,revision:3,updated_at:'2026-11-01T12:00:00Z',trashed_at:null as string|null,
      content:{audience:'connections',connections:[],category:'',title:'',text:'Unfinished',alt:'',caption:'',allowReply:false,header:null,forward:null,
        attachments:[{filename:'draft.txt',media_type:'text/plain',size:bytes.length,digest:{algorithm:'sha-256',value:digest.toString('base64url')}}]}}],
    sent_envelopes:[] as Record<string,unknown>[],attachment_uploads:[{account_id:account,digest:hex,created_at:'2026-11-01T12:00:00Z'}],attachment_blobs:[{digest:hex,bytes:'\\x'+bytes.toString('hex')}]}};
}
it('retains valid incomplete drafts and original Trash timestamps',()=>{
  const value=fixture();validateDraftHistory(value);value.tables.account_message_drafts[0]!.trashed_at='2026-10-01T12:00:00Z';
  const before=JSON.stringify(value);validateDraftHistory(value);expect(JSON.stringify(value)).toBe(before);
});
for(const [name,mutate] of Object.entries({
  foreign:(v:ReturnType<typeof fixture>)=>{v.tables.account_message_drafts[0]!.account_id='other';},
  duplicate:(v:ReturnType<typeof fixture>)=>{v.tables.account_message_drafts.push(v.tables.account_message_drafts[0]!);},
  malformedContent:(v:ReturnType<typeof fixture>)=>{v.tables.account_message_drafts[0]!.content.audience='invalid';},
  timestamp:(v:ReturnType<typeof fixture>)=>{v.tables.account_message_drafts[0]!.updated_at='2026-11-01';},
  missingUpload:(v:ReturnType<typeof fixture>)=>{v.tables.attachment_uploads=[];},
  foreignUpload:(v:ReturnType<typeof fixture>)=>{v.tables.attachment_uploads[0]!.account_id='other';},
  missingBytes:(v:ReturnType<typeof fixture>)=>{v.tables.attachment_blobs=[];},
  corruptBytes:(v:ReturnType<typeof fixture>)=>{v.tables.attachment_blobs[0]!.bytes='\\x0000';},
  sentCollision:(v:ReturnType<typeof fixture>)=>{v.tables.sent_envelopes.push({message_id:id});},
  duplicatePreferences:(v:ReturnType<typeof fixture>)=>{v.tables.account_message_preferences.push(v.tables.account_message_preferences[0]!);},
}))it('rejects draft history '+name,()=>{const value=fixture();mutate(value);expect(()=>validateDraftHistory(value)).toThrow();});
