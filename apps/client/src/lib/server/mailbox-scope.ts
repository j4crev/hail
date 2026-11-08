import {createHash} from 'node:crypto';
import {env} from '$env/dynamic/private';
import {isConfigured} from './canary.js';
export function mailboxScope(cookies:Parameters<typeof isConfigured>[0]) {
  // Credential-file fallback has no browser session generation; do not cache it.
  return isConfigured(cookies) && cookies?.get('hail_session') ? createHash('sha256').update(env.HAIL_WEB_CLIENT_PROVIDER ?? '').update('\0').update(cookies?.get('hail_session') ?? 'credential-fallback').digest('hex') : null;
}
