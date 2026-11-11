import {expect,it,vi} from "vitest";
import {validateSenderAddress,recoverPermission,senderLink,senderRequest,senderQr,permissionRequest,subscriptionScopeLabel} from "./permissions.js";

const capability='https://racrproto.com/ns/jmap/account',accountId='a_fixture';
function jmapFetch(...results:unknown[]){
  let resultIndex=0;
  return vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/jmap/session')return Response.json({apiUrl:'https://evil.example/jmap',primaryAccounts:{[capability]:accountId}});
    expect(path).toBe('/api/jmap');expect(init?.method).toBe('POST');
    const wire=JSON.parse(String(init?.body));
    expect(wire.using).toEqual(['urn:ietf:params:jmap:core',capability]);expect(wire.methodCalls).toHaveLength(1);
    const [name,args,tag]=wire.methodCalls[0];expect(args.accountId).toBe(accountId);
    const result=results[resultIndex++];
    return result instanceof Response?result:Response.json({methodResponses:[[name,{accountId,...result as object},tag]]});
  });
}
function operation(request:ReturnType<typeof jmapFetch>,index:number){
  const calls=request.mock.calls.filter(([path])=>path==='/api/jmap');
  return JSON.parse(String(calls[index]?.[1]?.body)).methodCalls[0];
}

it("makes public identity-pinned QR links and rejects malformed or credential-bearing requests",()=>{
  const did="did:plc:"+"a".repeat(24),link=senderLink("https://haili.app","canary-prov@haili.app",did),url=new URL(link);
  expect(url.pathname).toBe("/permissions");expect(senderRequest(url.hash)).toEqual({sender:"canary-prov@haili.app",did});
  expect(link).not.toMatch(/token|credential|hails_|racr_/);
  const qr=senderQr(link);expect(qr.size).toBeGreaterThan(29);expect(qr.path).toMatch(/^M\d+ \d+h1v1h-1z/);expect(qr.path).not.toContain("<");
  expect(senderQr(link)).toEqual(qr);
  expect(senderRequest("")).toBeNull();
  for(const hash of ["#sender=a@b.com","#sender=a@b.com&did=evil",url.hash+"&token=secret",url.hash+"&sender=other@b.com"])
    expect(()=>senderRequest(hash)).toThrow();
  expect(()=>senderLink("https://evil.example/path","a@b.com",did)).toThrow();
  expect(()=>senderLink("javascript:alert(1)","a@b.com",did)).toThrow();
});

it("labels General and handles unavailable permissions",()=>{
  expect(subscriptionScopeLabel({type:"categories",values:["general","updates"]})).toBe("General, updates");
  expect(subscriptionScopeLabel(undefined)).toBe("Permission unavailable");
});

it("permission requests use only the bounded same-origin cookie API, never QR-selected endpoints",async()=>{
  const request=jmapFetch({address:"sender@example.com"});vi.stubGlobal("fetch",request);
  try{
    await permissionRequest("review",{sender:"sender@example.com"});
    expect(request).toHaveBeenNthCalledWith(1,"/api/jmap/session",expect.objectContaining({method:'GET',credentials:"same-origin",cache:"no-store",redirect:"error"}));
    expect(request).toHaveBeenNthCalledWith(2,"/api/jmap",expect.objectContaining({method:'POST',credentials:"same-origin",cache:"no-store",redirect:"error"}));
    expect(operation(request,0)).toEqual(['HailGrant/reviewApproval',{accountId,input:{sender:'sender@example.com'}},'read-state']);
    await expect(permissionRequest("https://evil.example/commit",{})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    vi.stubGlobal("fetch",jmapFetch(new Response('{"error":"private vendor diagnostics"}',{status:503})));
    await expect(permissionRequest("commit",{})).rejects.toMatchObject({status:503,message:"The request could not be confirmed. Refresh and try again."});
  }finally{vi.unstubAllGlobals();}
});

const requestId="00000000-0000-4000-8000-000000000001",grantor="did:plc:"+"a".repeat(24);
function pending(approved=false,result:unknown=null){return {requestId,action:"revoke",expiresAt:new Date(Date.now()+60000).toISOString(),approved,
  options:approved?null:{challenge:"passkey-required"},result,permission:{grant_id:requestId,revision:1,grantor,grantee:"did:plc:"+"b".repeat(24),
    expires_at:null,scope:[{type:"categories",values:["general"]}],consent_context:{grantee_address:"sender@example.com"}}};}
const saved={grantId:requestId,revision:2,status:"revoked",publication:"durable"};

it("restores an unconfirmed review without submitting or authorizing it",async()=>{
  const request=jmapFetch(pending());vi.stubGlobal("fetch",request);
  try{expect((await recoverPermission(requestId,grantor)).approved).toBe(false);expect(request).toHaveBeenCalledTimes(2);expect(operation(request,0)).toEqual(['HailGrant/approvalStatus',{accountId,requestId},'read-state']);}
  finally{vi.unstubAllGlobals();}
});

it("recognizes completion after a lost response without repeating the change",async()=>{
  const request=jmapFetch(pending(true,saved));vi.stubGlobal("fetch",request);
  try{expect((await recoverPermission(requestId,grantor)).result).toEqual(saved);expect(request).toHaveBeenCalledTimes(2);expect(operation(request,0)).toEqual(['HailGrant/approvalStatus',{accountId,requestId},'read-state']);}
  finally{vi.unstubAllGlobals();}
});

it("finishes an already authorized action using the same request and no new proof",async()=>{
  const request=jmapFetch(pending(true),pending(true,saved));
  vi.stubGlobal("fetch",request);
  try{
    expect((await recoverPermission(requestId,grantor)).result).toEqual(saved);
    expect(operation(request,0)).toEqual(['HailGrant/approvalStatus',{accountId,requestId},'read-state']);
    expect(operation(request,1)).toEqual(['HailGrant/commitApproval',{accountId,input:{requestId}},'read-state']);
    expect(request).toHaveBeenCalledTimes(4);
  }finally{vi.unstubAllGlobals();}
});

it("bounds automatic recovery when saving remains unavailable",async()=>{
  const request=jmapFetch(pending(true),Response.json({}, {status:503}));
  vi.stubGlobal("fetch",request);
  try{await expect(recoverPermission(requestId,grantor)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(4);}
  finally{vi.unstubAllGlobals();}
});

it("does not retry another account's action",async()=>{
  const request=jmapFetch(pending(true));vi.stubGlobal("fetch",request);
  try{await expect(recoverPermission(requestId,"did:plc:"+"c".repeat(24))).rejects.toThrow("account mismatch");expect(request).toHaveBeenCalledTimes(2);expect(operation(request,0)).toEqual(['HailGrant/approvalStatus',{accountId,requestId},'read-state']);}
  finally{vi.unstubAllGlobals();}
});

it.each([404,410])("preserves terminal status %s so the UI can clear a stale review",async status=>{
  vi.stubGlobal("fetch",jmapFetch(Response.json({methodResponses:[["error",{type:"notFound",httpStatus:status},"read-state"]]})));
  try{await expect(recoverPermission(requestId,grantor)).rejects.toMatchObject({status});}
  finally{vi.unstubAllGlobals();}
});

it("validates the complete batch review and rejects missing, duplicate or unrelated results",async()=>{
  const {approval}=await import("./permissions.js");
  const first=pending().permission,second={...first,grant_id:"00000000-0000-4000-8000-000000000002"};
  const batch={...pending(),action:"revoke-batch",permissions:[first,second]};
  expect(approval(batch).permissions).toHaveLength(2);
  const items=[first,second].map(permission=>({grantId:permission.grant_id,result:{...saved,grantId:permission.grant_id},error:null}));
  expect(approval({...batch,approved:true,result:{items}}).result).toEqual({items});
  for(const change of [{action:"revoke"},{permissions:undefined},{permissions:[first,first]},{permissions:[first,{...second,grantor:"did:plc:"+"c".repeat(24)}]},
    {approved:true,result:{items:items.slice(0,1)}},{approved:true,result:{items:[items[1],items[0]]}},
    {approved:true,result:{items:[{...items[0],result:{...saved,revision:99}},items[1]]}}]){
    expect(()=>approval({...batch,...change})).toThrow();
  }
});

it("validates a category restriction against its reviewed previous scope and result",async()=>{
  const {approval}=await import("./permissions.js"),permission={...pending().permission,revision:2,scope:[{type:"categories",values:["updates"]}]};
  const restriction={...pending(),action:"restrict",permission,previousScope:[{type:"categories",values:["general","updates"]}]};
  expect(approval(restriction).previousScope).toEqual(restriction.previousScope);
  expect(approval({...restriction,approved:true,result:{...saved,revision:2,status:"active"}}).result).toMatchObject({revision:2,status:"active"});
  for(const change of [{previousScope:undefined},{permission:{...permission,scope:[{type:"categories",values:["general","updates"]}]}},
    {permission:{...permission,scope:[{type:"categories",values:["other"]}]}},{approved:true,result:{...saved,revision:1,status:"active"}},
    {approved:true,result:{...saved,revision:2,status:"revoked"}}]){
    expect(()=>approval({...restriction,...change})).toThrow();
  }
});

it("recovers one authorized batch without requesting another passkey",async()=>{
  const first=pending().permission,second={...first,grant_id:"00000000-0000-4000-8000-000000000002"};
  const batch={...pending(true),action:"revoke-batch",permissions:[first,second]};
  const result={items:[{grantId:first.grant_id,result:saved,error:null},{grantId:second.grant_id,result:null,error:"Subscription changed after review."}]};
  const request=jmapFetch(batch,{...batch,result});
  vi.stubGlobal("fetch",request);
  try{
    expect((await recoverPermission(requestId,grantor)).result).toEqual(result);
    expect(request).toHaveBeenCalledTimes(4);
    expect(operation(request,1)).toEqual(['HailGrant/commitApproval',{accountId,input:{requestId}},'read-state']);
  }finally{vi.unstubAllGlobals();}
});

it("preserves identity-conflict warnings when restoring an unfinished approval",async()=>{
  const previous="did:plc:"+"d".repeat(24);
  vi.stubGlobal("fetch",jmapFetch({...pending(),action:"allow",previousDids:[previous]}));
  try{expect((await recoverPermission(requestId,grantor)).previousDids).toEqual([previous]);}
  finally{vi.unstubAllGlobals();}
});

it("validates Hail addresses locally and normalizes case and surrounding whitespace",()=>{
  expect(validateSenderAddress("  J4crev@Example.COM  ")).toBe("j4crev@example.com");
  expect(validateSenderAddress("a.b-c@sub.example.com")).toBe("a.b-c@sub.example.com");
  for(const address of ["j4crev.com","","a@localhost","a@@example.com","a..b@example.com","a.-b@example.com","a_1@example.com","a@example..com","a@-example.com","a@example.com-","a b@example.com","a".repeat(64)+"@example.com","a@"+"b".repeat(64)+".com"])
    expect(()=>validateSenderAddress(address)).toThrow("Enter a valid Hail address");
});
