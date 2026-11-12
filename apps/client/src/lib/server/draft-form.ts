import {BUNDLED_IMAGE_LIMITS,encodeBase64Url} from '@racrproto/codec';
import {parseDraftContent} from '@racrproto/client-support/drafts';
export async function draftForm(form:FormData){
  const field=(name:string)=>{const v=form.get(name);return typeof v==='string'?v:'';};
  if(field('audience')==='connections'&&form.has('builder'))throw new Error('The block builder is available for subscriber publications only.');
  const file=form.get('header');
  if(file instanceof File&&file.size>0&&(!(BUNDLED_IMAGE_LIMITS.message.mediaTypes as readonly string[]).includes(file.type)||file.size>BUNDLED_IMAGE_LIMITS.message.bytes))throw new Error('Choose a PNG or JPEG up to 512 KiB.');
  const header=file instanceof File&&file.size>0?encodeBase64Url(new Uint8Array(await file.arrayBuffer())):field('savedHeader')||null;
  return parseDraftContent({... (field('builder')?{builder:JSON.parse(field('builder'))}:{}),audience:field('audience'),category:field('category'),connections:form.getAll('connection'),title:field('title'),text:field('text'),alt:field('alt'),caption:field('caption'),allowReply:field('allowReply')==='yes',header,
    forward:field('forwardSender')||field('forwardMessage')?{sender:field('forwardSender'),messageId:field('forwardMessage')}:null});
}
