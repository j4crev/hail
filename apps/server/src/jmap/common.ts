import {createHash} from 'node:crypto';
import type {AccountApiSession} from '../accounts/repository.js';
export const JMAP_CORE='urn:ietf:params:jmap:core';
export const HAIL_MESSAGES='https://haili.app/ns/jmap/messages';
export const MAX_OBJECTS=50;
export const canMutateMessages=(session:AccountApiSession)=>session.scopes.includes('messages:read')&&session.scopes.includes('messages:write')&&!!session.passkey_credential_id&&!session.migration_state;
export const canDestroyMessages=(session:AccountApiSession)=>session.scopes.includes('messages:read')&&session.scopes.includes('messages:write')&&!session.migration_state;
export class JmapError extends Error {constructor(readonly type:string){super(type);}}
export const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function argumentsOnly(args:Record<string,unknown>,allowed:string[]){
  if(Object.keys(args).some(key=>!allowed.includes(key)))throw new JmapError('invalidArguments');
}

export const jmapAccountId=(origin:string,session:AccountApiSession)=>`a_${createHash('sha256').update(origin).digest('hex').slice(0,16)}_${session.account_id.replaceAll('-','')}_${session.serving_generation??1}`;
