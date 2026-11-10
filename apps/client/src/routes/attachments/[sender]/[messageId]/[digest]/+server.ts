import {redirectMedia,mediaClient} from '$lib/server/media.js';
export async function GET({cookies,url,params,setHeaders}){
  setHeaders({'cache-control':'private, no-store','referrer-policy':'no-referrer'});
  const client=await mediaClient(cookies,url);
  return redirectMedia(client,`/api/v1/account/attachments/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}/${encodeURIComponent(params.digest)}${url.search}`);
}
