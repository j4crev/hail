import {mediaClient} from '$lib/server/media.js';
import {messageImageResponse} from '$lib/server/message-image.js';
export async function GET({cookies,url,params}){
  return messageImageResponse(params,()=>mediaClient(cookies,url));
}
