import {redirectMedia,mediaClient} from '$lib/server/media.js';
import {error} from '@sveltejs/kit';
export async function GET({cookies,url,params,setHeaders}){
  if(!/^did:plc:[a-z2-7]{24}$/.test(params.did))error(404,'Avatar unavailable');
  setHeaders({'cache-control':'private, no-store','referrer-policy':'no-referrer'});
  const client=await mediaClient(cookies,url);
  return redirectMedia(client,`/api/v1/account/senders/${encodeURIComponent(params.did)}/avatar/image`);
}
