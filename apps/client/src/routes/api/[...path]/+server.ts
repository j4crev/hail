import {API_ORIGIN} from '$lib/server/canary.js';
import type {RequestHandler} from './$types';

// Browser API bridge: only structured JSON responses may reach the UI origin.
// Uploaded bytes, protocol bodies and media capabilities are never proxied here.
const proxy:RequestHandler=async({request,url,params,cookies})=>{
  const path=params.path;
  const jmapPath=path==='jmap/session'?'/.well-known/jmap':path==='jmap'?'/jmap':null;
  if(!jmapPath&&!/^v1\//.test(path)||/(?:^|\/)(?:media|media-ticket)(?:\/|$)/.test(path)||
    /^v1\/account\/attachments\//.test(path)||/\/avatar\/image$/.test(path))
    return new Response(null,{status:404});
  const headers=new Headers();
  for(const name of ['content-type','origin','accept','authorization']){const value=request.headers.get(name);if(value)headers.set(name,value);}
  // GUI ingress is private; Caddy overwrites this header from trusted tunnel metadata.
  const clientAddress=request.headers.get('X-Hail-Trusted-Client-IP');
  if(clientAddress)headers.set('X-Hail-Trusted-Client-IP',clientAddress);
  const session=cookies.get('hail_session');if(session)headers.set('Cookie',`hail_session=${session}`);
  const upstream=await fetch(`${API_ORIGIN}${jmapPath??`/api/${path}`}${url.search}`,{method:request.method,headers,
    ...(request.method==='GET'||request.method==='HEAD'?{}:{body:request.body,duplex:'half'}),redirect:'manual',signal:AbortSignal.timeout(60_000)});
  if(!/^application\/(?:json|problem\+json)(?:;|$)/i.test(upstream.headers.get('content-type')??'')){
    await upstream.body?.cancel();return new Response(null,{status:502});
  }
  const output=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff'});
  for(const name of ['content-type','hail-error-code','retry-after','www-authenticate']){const value=upstream.headers.get(name);if(value)output.set(name,value);}
  for(const cookie of upstream.headers.getSetCookie()){
    if(!cookie.startsWith('hail_session=')||/;\s*domain=/i.test(cookie))continue;
    output.append('set-cookie',cookie);
  }
  return new Response(upstream.body,{status:upstream.status,headers:output});
};
export const GET=proxy,POST=proxy,PUT=proxy,PATCH=proxy,DELETE=proxy,HEAD=proxy;
