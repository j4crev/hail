import type {SQL} from 'bun';
import type {AccountApiSession} from '../accounts/repository.js';
import {JmapError,MAX_OBJECTS,argumentsOnly,jmapAccountId} from './common.js';
interface State {revision:string;retained_from:string}
export class JmapChangeLog {
  private readonly states:string;
  private readonly events:string;
  readonly prefix:string;
  constructor(private readonly sql:SQL,private readonly origin:string,kind:'message'|'draft'){
    if(kind!=='message'&&kind!=='draft')throw Error('Unknown JMAP collection');
    // Identifiers come only from this closed collection list; values are bound.
    this.states=`jmap_${kind}_states`;this.events=`jmap_${kind}_changes`;this.prefix=kind==='message'?'m':'d';
  }
  accountId(session:AccountApiSession){return jmapAccountId(this.origin,session);}
  state(session:AccountApiSession,revision:string){return `${this.accountId(session)}_${this.prefix}_${revision}`;}
  recordId(id:string){return `${this.prefix}_${id.replaceAll('-','')}`;}
  private parseState(session:AccountApiSession,value:unknown){
    const prefix=this.state(session,'');
    if(typeof value!=='string'||!value.startsWith(prefix)||! /^(0|[1-9][0-9]{0,18})$/.test(value.slice(prefix.length)))throw new JmapError('cannotCalculateChanges');
    const revision=value.slice(prefix.length);if(BigInt(revision)>9223372036854775807n)throw new JmapError('cannotCalculateChanges');return revision;
  }
  async snapshot<T>(session:AccountApiSession,work:(tx:SQL,state:State)=>Promise<T>){
    return this.sql.begin(async tx=>{
      // AFTER write triggers take this row exclusively before committing. Reads
      // paired with this shared lock observe one committed data/state snapshot.
      const state=(await tx.unsafe<State[]>(`SELECT revision::text,retained_from::text FROM ${this.states}
        WHERE account_id=$1 AND generation=$2 FOR SHARE`,[session.account_id,session.serving_generation??1]))[0];
      if(!state)throw new JmapError('accountNotFound');return work(tx as SQL,state);
    });
  }
  async changes(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['accountId','sinceState','maxChanges']);
    const since=this.parseState(session,args.sinceState),max=args.maxChanges??MAX_OBJECTS;
    if(!Number.isSafeInteger(max)||Number(max)<1||Number(max)>MAX_OBJECTS)throw new JmapError('invalidArguments');
    const result=await this.sql.begin(async tx=>{
      const owner=[session.account_id,session.serving_generation??1];
      const state=(await tx.unsafe<State[]>(`SELECT revision::text,retained_from::text FROM ${this.states}
        WHERE account_id=$1 AND generation=$2 FOR UPDATE`,owner))[0];
      if(!state)throw new JmapError('accountNotFound');
      const removed=await tx.unsafe<{revision:string}[]>(`DELETE FROM ${this.events} WHERE (account_id,generation,revision) IN
        (SELECT account_id,generation,revision FROM ${this.events} WHERE account_id=$1 AND generation=$2
        AND occurred_at<clock_timestamp()-interval '31 days' ORDER BY revision LIMIT 1000) RETURNING revision::text`,owner);
      let floor=BigInt(state.retained_from);for(const row of removed)if(BigInt(row.revision)>floor)floor=BigInt(row.revision);
      if(floor!==BigInt(state.retained_from))await tx.unsafe(`UPDATE ${this.states} SET retained_from=$3
        WHERE account_id=$1 AND generation=$2`,[...owner,floor.toString()]);
      if(BigInt(since)<floor||BigInt(since)>BigInt(state.revision))return null;
      const rows=await tx.unsafe<{revision:string;id:string;operation:'created'|'updated'|'destroyed'}[]>(`
        SELECT revision::text,id,operation FROM ${this.events} WHERE account_id=$1 AND generation=$2
        AND revision>$3::bigint ORDER BY revision LIMIT $4`,[...owner,since,Number(max)+1]);
      const page=rows.slice(0,Number(max)),changes=new Map<string,{first:string;last:string}>();
      for(const row of page){const prior=changes.get(row.id);changes.set(row.id,{first:prior?.first??row.operation,last:row.operation});}
      const created:string[]=[],updated:string[]=[],destroyed:string[]=[];
      for(const [id,change] of changes){if(change.first==='created'){if(change.last!=='destroyed')created.push(this.recordId(id));}
        else if(change.last==='destroyed')destroyed.push(this.recordId(id));else updated.push(this.recordId(id));}
      return {accountId:this.accountId(session),oldState:args.sinceState,newState:this.state(session,rows.length>Number(max)?page.at(-1)!.revision:state.revision),
        hasMoreChanges:rows.length>Number(max),created,updated,destroyed};
    });
    if(result===null)throw new JmapError('cannotCalculateChanges');return result;
  }
}
