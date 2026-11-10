import {randomBytes} from 'node:crypto';

// Browser media receives a narrowly scoped capability, never the app session.
// Process-local tickets deliberately expire on restart; clients obtain fresh URLs.
export function isMediaPath(path:string):boolean {
  return /^\/api\/v1\/account\/senders\/did(?::|%3A)plc(?::|%3A)[a-z2-7]{24}\/avatar\/image$/.test(path)||
    /^\/api\/v1\/account\/attachments\/(?:did(?::|%3A)plc(?::|%3A)[a-z2-7]{24}|sent-(?:connections|category|message))\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{43}(?:\?index=(?:[0-9]|1[0-9]))?$/.test(path);
}
interface Ticket {path:string;authorization?:string|undefined;cookie?:string|undefined;expires:number}
export class MediaTickets {
  private readonly tickets=new Map<string,Ticket>();
  constructor(private readonly now=Date.now,private readonly maximum=4096){}
  issue(path:string,credentials:{authorization?:string|undefined;cookie?:string|undefined}):string|null {
    if(!isMediaPath(path))return null;
    const now=this.now();
    for(const [key,value] of this.tickets)if(value.expires<=now)this.tickets.delete(key);
    if(this.tickets.size>=this.maximum)return null;
    const token=randomBytes(32).toString('base64url');
    this.tickets.set(token,{path,...credentials,expires:now+60_000});
    return token;
  }
  read(token:string):Ticket|null {
    const ticket=this.tickets.get(token);
    if(!ticket)return null;
    if(ticket.expires<=this.now()){this.tickets.delete(token);return null;}
    return ticket;
  }
}
