import {AccountApiError,type AccountApiClient} from '@racrproto/client-support/account-api';
import {validateJpegStructure,validatePngStructure} from '@racrproto/codec';
import {isRedirect} from '@sveltejs/kit';

const DID=/^did:plc:[a-z2-7]{24}$/,UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DIGEST=/^[A-Za-z0-9_-]{43}$/;
const unavailable=(status:number)=>new Response(null,{status,headers:{'cache-control':'private, no-store','referrer-policy':'no-referrer'}});

/**
 * A message image on this origin, so the browser can cache it: the URL names the
 * image's content digest, and messages are immutable, so a cached copy never goes
 * stale. Every miss re-authenticates with the provider. Bytes are verified against
 * the digest and must be structurally valid PNG/JPEG; they are served with a fixed
 * image type, nosniff and a sandbox CSP so they can never run as a document.
 * Logout clears the browser cache (Clear-Site-Data).
 */
export async function messageImageResponse(params:Record<string,string>,client:()=>Promise<Pick<AccountApiClient,'messageImage'>>){
  const {sender='',messageId='',digest=''}=params;
  if(!DID.test(sender)||!UUID.test(messageId)||!DIGEST.test(digest))return unavailable(404);
  let image:Awaited<ReturnType<AccountApiClient['messageImage']>>;
  try{image=await (await client()).messageImage(sender,messageId,digest);}
  catch(cause){
    if(isRedirect(cause))return unavailable(401);
    if(cause instanceof AccountApiError&&[401,403,429,503].includes(cause.status))return unavailable(cause.status);
    return unavailable(404);
  }
  try{(image.mediaType==='image/png'?validatePngStructure:validateJpegStructure)(image.bytes);}catch{return unavailable(404);}
  return new Response(Uint8Array.from(image.bytes),{headers:{
    'content-type':image.mediaType,'content-length':String(image.bytes.length),
    'cache-control':'private, max-age=2592000, immutable','x-content-type-options':'nosniff',
    'content-security-policy':"sandbox; default-src 'none'",'cross-origin-resource-policy':'same-origin','referrer-policy':'no-referrer'}});
}
