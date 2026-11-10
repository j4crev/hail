import { expect, it } from "vitest";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog, type ExportedOp } from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { MonitorDatabase } from "../src/database.js";
import { EnrollmentProviders } from "../src/providers.js";
import { PlcMonitor } from "../src/monitor.js";
import { cleanMonitorReceiver } from "../src/receiver-lifecycle.js";

it.skipIf(!process.env.DATABASE_URL)("hands off ownership without resetting coverage and rejects former-provider and previous-generation cleanup",async()=>{
  const db=new MonitorDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();const providers=new EnrollmentProviders(db.sql);
    const a=await providers.create("https://a.example","https://alerts.example"),b=await providers.create("https://b.example","https://other-alerts.example");
    const owner=await P256Keypair.create(),lower=await P256Keypair.create();
    const genesis=await signOperation({type:"plc_operation",prev:null,rotationKeys:[owner.did(),lower.did()],verificationMethods:{},
      services:{hail:{type:"HailMessaging",endpoint:a.providerOrigin+"/hail"}},alsoKnownAs:[]},owner);
    const did=await didForCreateOp(genesis),cid=(await cidForCbor(genesis)).toString(),state=(await validateOperationLog(did,[genesis]))!;
    let audit:ExportedOp[]=[{did,cid,operation:genesis,nullified:false,createdAt:new Date(Date.now()-1000).toISOString()}];
    const monitor=new PlcMonitor(db.sql,{async getAuditableLog(){return audit;},async getOperationLog(){return audit.map(x=>x.operation);},
      async getDocumentData(){return state;},async exportAfter(){return [];}});
    const receiver=a.alertOrigin+"/hail/signup";
    await monitor.enroll(did,cid,receiver,state,a.id);
    const before=(await db.sql`SELECT expected_cid,coverage_since,alert_webhook_url FROM monitored_dids WHERE did=${did}`)[0];
    const transfer=crypto.randomUUID();
    async function change(endpoint:string,key=owner){
      const {sig: _signature,...unsigned}=genesis;
      const operation=await signOperation({...unsigned,prev:audit.at(-1)!.cid,services:{hail:{type:"HailMessaging",endpoint}}},key);
      const next=(await cidForCbor(operation)).toString();
      audit.push({did,cid:next,operation,nullified:false,createdAt:new Date().toISOString()});return next;
    }
    const unauthorized=await change(b.providerOrigin+"/hail",lower);
    await expect(monitor.handoff(did,unauthorized,transfer,b.id,async()=>{})).rejects.toThrow();
    audit=audit.slice(0,1);
    const moved=await change(b.providerOrigin+"/hail");
    await expect(monitor.handoff(did,moved,transfer,b.id,async()=>{throw Error("Receiver unavailable");})).rejects.toThrow();
    expect((await db.sql`SELECT enrollment_provider_id FROM monitored_dids WHERE did=${did}`)[0]!.enrollment_provider_id).toBe(a.id);
    let claims=0;
    const claim=async(url:string,identity:string,bootstrap:string)=>{expect([url,identity,bootstrap]).toEqual([receiver,did,cid]);claims++;};
    await providers.setEnabled(a.id,false); // Revocation must not obstruct an authorized move.
    expect(await monitor.handoff(did,moved,transfer,b.id,claim)).toBe(true);
    expect(await monitor.handoff(did,moved,transfer,b.id,claim)).toBe(true);expect(claims).toBe(1);
    expect((await db.sql`SELECT expected_cid,coverage_since,alert_webhook_url FROM monitored_dids WHERE did=${did}`)[0]).toEqual(before);
    await providers.setEnabled(a.id,true);
    await expect(monitor.stopManaged(did,cid,a.providerOrigin,receiver,a.id)).rejects.toThrow();
    const returned=await change(a.providerOrigin+"/hail");
    expect(await monitor.handoff(did,returned,crypto.randomUUID(),a.id,claim)).toBe(true);
    await expect(monitor.stopManaged(did,cid,a.providerOrigin,receiver,a.id)).rejects.toThrow();
    await expect(monitor.stopManaged(did,moved,b.providerOrigin,b.alertOrigin+"/hail/signup",b.id)).rejects.toThrow();
    expect(await providers.retire(b.id,0)).toBe(0);
    expect((await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at).toBeNull();
    await expect(providers.retire(a.id,0)).rejects.toThrow("count changed");
    await providers.setEnabled(a.id,false);
    expect((await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at).toBeNull();
    expect(await providers.retire(a.id,1)).toBe(1);
    expect(await providers.retire(a.id,0)).toBe(0);
    await expect(providers.setEnabled(a.id,true)).rejects.toThrow();
    expect((await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at).not.toBeNull();
    expect(await cleanMonitorReceiver(db.sql,{async send(){throw Error("Unavailable");}})).toBe("retry");
    await db.sql`UPDATE monitor_receiver_cleanup SET next_attempt_at=clock_timestamp()`;
    expect(await cleanMonitorReceiver(db.sql,{async send(url,identity,bootstrap,action){expect([url,identity,bootstrap,action]).toEqual([receiver,did,cid,"stop"]);}})).toBe("completed");
    expect(await cleanMonitorReceiver(db.sql,{async send(){throw Error("Must not repeat");}})).toBe("idle");
    const rollback=await db.sql.reserve();
    try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0010_monitor_lifecycle.sql",import.meta.url)).text()))
      .rejects.toThrow("Lifecycle authority");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}
  }finally{await db.close();}
});
