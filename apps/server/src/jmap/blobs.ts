import type {SQL} from 'bun';
import type {AccountApiSession} from '../accounts/repository.js';
import {lockMessageAccount} from '../accounts/message-read.js';
import {JmapError,argumentsOnly,jmapAccountId,MAX_OBJECTS} from './common.js';
import type {JmapCollections} from './collections.js';
import type {JmapMessages} from './messages.js';
export const MAX_UPLOAD_BYTES=25*1024*1024;
const uuid=(id:string)=>/^u_[0-9a-f]{32}$/.test(id)?`${id.slice(2,10)}-${id.slice(10,14)}-${id.slice(14,18)}-${id.slice(18,22)}-${id.slice(22)}`:null;
export class JmapBlobs {
  constructor(private readonly sql:SQL,private readonly origin:string,private readonly messages:JmapMessages,private readonly collections?:JmapCollections){}
  async upload(session:AccountApiSession,bytes:Uint8Array,type:string){
    if(!session.scopes.includes('messages:write')||session.migration_state)throw new JmapError('forbidden');
    if(bytes.length>MAX_UPLOAD_BYTES)throw new JmapError('tooLarge');
    if(type.length>255||!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(type))throw new JmapError('invalidArguments');
    return this.sql.begin(async tx=>{
      await lockMessageAccount(tx as SQL,session);
      const generation=(await tx`SELECT generation FROM account_serving_generations WHERE account_id=${session.account_id}`)[0]?.generation;
      if(Number(generation)!==(session.serving_generation??1))throw new JmapError('accountNotFound');
      await tx`DELETE FROM jmap_uploads WHERE account_id=${session.account_id} AND expires_at<=clock_timestamp()`;
      const used=(await tx`SELECT COALESCE(sum(octet_length(bytes)),0)::text AS size FROM jmap_uploads WHERE account_id=${session.account_id}`)[0]!.size;
      if(Number(used)+bytes.length>100*1024*1024)throw new JmapError('overQuota');
      const row=(await tx<{id:string}[]>`INSERT INTO jmap_uploads(account_id,generation,bytes,media_type)
        VALUES(${session.account_id},${session.serving_generation??1},${bytes},${type}) RETURNING id`)[0]!;
      return {accountId:jmapAccountId(this.origin,session),blobId:'u_'+row.id.replaceAll('-',''),type,size:bytes.length};
    });
  }
  async get(session:AccountApiSession,id:string){
    if(!session.scopes.includes('messages:read')&&!session.scopes.includes('messages:write'))return null;
    if(id.startsWith('u_')){
      const row=(await this.sql<{bytes:Uint8Array;media_type:string}[]>`SELECT bytes,media_type FROM jmap_uploads WHERE id=${uuid(id)}::uuid
        AND account_id=${session.account_id} AND generation=${session.serving_generation??1} AND expires_at>clock_timestamp()`)[0];
      return row?{bytes:row.bytes,type:row.media_type}:null;
    }
    return session.scopes.includes('messages:read')?(await this.collections?.blob(session,id))??this.messages.blob(session,id):null;
  }
  async copy(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['fromAccountId','accountId','blobIds']);
    const accountId=jmapAccountId(this.origin,session);
    if(args.fromAccountId!==accountId)throw new JmapError('fromAccountNotFound');
    if(args.accountId!==accountId)throw new JmapError('accountNotFound');
    if(!Array.isArray(args.blobIds)||args.blobIds.some(id=>typeof id!=='string'||id.length>255))throw new JmapError('invalidArguments');
    if(args.blobIds.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
    const copied:Record<string,string>=Object.create(null),notCopied:Record<string,unknown>=Object.create(null);
    for(const id of new Set(args.blobIds as string[])){
      if(await this.get(session,id))copied[id]=id;else notCopied[id]={type:'notFound'};
    }
    return {fromAccountId:accountId,accountId,copied:Object.keys(copied).length?copied:null,notCopied:Object.keys(notCopied).length?notCopied:null};
  }
}
