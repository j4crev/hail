import {error,redirect} from '@sveltejs/kit';
import {PROVIDER,ORIGIN,API_ORIGIN,canaryAccount} from './canary.js';
import {AccountApiClient} from '@racrproto/client-support/account-api';

export async function redirectMedia(client:AccountApiClient,path:string):Promise<never>{
  let location:string;
  try{
    const result=await client.request('/media-ticket',{path});
    if(typeof result.url!=='string')throw new Error('Missing media URL');
    const url=new URL(result.url);
    if(url.origin!==new URL(PROVIDER).origin||!/^\/api\/v1\/media\/[A-Za-z0-9_-]{43}$/.test(url.pathname)||url.search||url.hash||url.username||url.password)
      throw new Error('Invalid media URL');
    location=url.href;
  }catch{error(404,'Media unavailable');}
  redirect(303,location);
}

// Ticket issuance itself authenticates the session; avoid an extra account read
// for every image in a mailbox page.
export async function mediaClient(cookies:{get(name:string):string|undefined},url:URL){
  const token=cookies.get('hail_session');
  return token?AccountApiClient.fromSession(PROVIDER,token,ORIGIN,API_ORIGIN):(await canaryAccount(cookies,url)).client;
}
