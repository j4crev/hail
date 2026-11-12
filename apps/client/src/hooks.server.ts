import {withAccountReads} from "$lib/server/account-reads.js";
import {withClientAddress} from "$lib/server/client-address.js";
import type { Handle } from "@sveltejs/kit";
import {isAccountPath,loginPath} from "$lib/auth-routing.js";
import {PROVIDER,isConfigured} from "$lib/server/canary.js";
import {env as publicEnv} from '$env/dynamic/public';
import {sequence} from '@sveltejs/kit/hooks';
import {sentryHandle,handleErrorWithSentry} from '@sentry/sveltekit';
import {sentryCsp,sentryOrigin} from '$lib/sentry.js';

const applicationHandle: Handle = async ({ event, resolve }) => {
  const connectionInbox = event.url.pathname === "/" && event.url.searchParams.get("view") === "connections" && !event.url.searchParams.has("next");
  if ((isAccountPath(event.url.pathname) || connectionInbox) && !isConfigured(event.cookies)) {
    return new Response(null,{status:303,headers:{location:loginPath(event.url),"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }
  const response = await withClientAddress(event.request, () => event.request.method === "GET" ? withAccountReads(() => resolve(event)) : resolve(event));
  const ingestOrigin=sentryOrigin(publicEnv.PUBLIC_SENTRY_DSN);
  const initialCsp=response.headers.get('content-security-policy');
  if(initialCsp&&PROVIDER){
    const mediaOrigin=new URL(PROVIDER).origin;
    response.headers.set('content-security-policy',initialCsp.replace(/(^|;)\s*img-src\s+([^;]+)/g,
      (_directive,separator,sources)=>`${separator} img-src ${sources} ${mediaOrigin}`));
  }
  const csp=response.headers.get('content-security-policy');
  if(ingestOrigin && csp) response.headers.set('content-security-policy',sentryCsp(csp,ingestOrigin));
  response.headers.set("cache-control","no-store");
  // Native same-origin POSTs need a non-null Origin for SvelteKit's CSRF check.
  response.headers.set("referrer-policy",(event.url.pathname.startsWith("/auth/") || (event.url.pathname === "/" && event.url.searchParams.has("next")))?"no-referrer":"same-origin");
  if (event.url.pathname === "/signup/recovery") {
    // Additional policy intersects SvelteKit's nonce-bearing policy. No API calls
    // or form submissions are needed while preview recovery material is unlocked.
    const policy = response.headers.get("content-security-policy");
    response.headers.set("content-security-policy", [policy, "connect-src 'none'; form-action 'none'; frame-ancestors 'none'"].filter(Boolean).join(", "));
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
  }
  if(event.url.pathname==="/signup"||event.url.pathname==="/signup/domain"){
    const policy=response.headers.get("content-security-policy");
    response.headers.set("content-security-policy",[policy,"connect-src 'self'; form-action 'none'; frame-ancestors 'none'"].filter(Boolean).join(", "));
    response.headers.set("cache-control","no-store");
    response.headers.set("referrer-policy","no-referrer");
  }
  if(event.url.pathname==="/account"||event.url.pathname==="/admin"||event.url.pathname==="/permissions"||event.url.pathname==="/connect"||event.url.pathname==="/connections"||event.url.pathname==="/settings/security"){
    response.headers.set("cache-control","no-store");response.headers.set("referrer-policy","no-referrer");
  }
  return response;
};

const instrumentedHandle=sequence(sentryHandle(),applicationHandle);
export const handle:Handle=input=>publicEnv.PUBLIC_SENTRY_DSN?instrumentedHandle(input):applicationHandle(input);
export const handleError=handleErrorWithSentry();
