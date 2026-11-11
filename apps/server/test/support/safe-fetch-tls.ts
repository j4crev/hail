import {signTestRetrieval} from "./retrieval-signing.js";
// Run in a fresh Bun process: test-only trust and socket routing cannot leak into
// other suites. Only the dial address changes; TLS/SNI/hostname validation is real.
import assert from 'node:assert/strict';
import {createServer, request as realRequest, type RequestOptions} from 'node:https';
import type {IncomingMessage} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock} from 'bun:test';
import {createLocalTlsFixture} from '../client-support/tls.js';

const directory=await mkdtemp(join(tmpdir(),'hail-transport-tls-'));
const originalRequest=realRequest;
let server:ReturnType<typeof createServer>|undefined;
try {
 await createLocalTlsFixture(directory,'localhost.example.com');
 const ca=await readFile(join(directory,'ca.pem'));
 let connected=0,received=0;
 server=createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>{
  received++;
  if(req.url==='/redirect'){res.writeHead(302,{Location:'https://127.0.0.1/private'});res.end();}
  else {res.end('verified');}
 });
 await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 mock.module('node:https',()=>({request:(options:RequestOptions,callback:(response:IncomingMessage)=>void)=>{
  connected++;
  assert.equal(options.servername,options.hostname);
  assert.equal(options.agent,false);
  // Prove the real transport selected and pinned the validated public answer.
  (options.lookup as Function)(options.hostname,{},(error:unknown,address:string,family:number)=>{
   assert.equal(error,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);
  });
  const routed:RequestOptions={...options,ca,port,lookup:(_host,_options,cb)=>cb(null,'127.0.0.1',4)};
  return originalRequest(routed,callback);
 }}));
 const {SafeHttpsTransport}=await import('../../src/discovery/safe-fetch.js');
 const {createProviderDiscovery}=await import('../../src/discovery/delegation.js');
 const transport=new SafeHttpsTransport({lookup:async()=>[{address:'1.1.1.1',family:4}]});
 const get=(host:string,path='/')=>transport.fetch(new Request(`https://${host}${path}`,{signal:AbortSignal.timeout(5000)}));
 assert.equal(await (await get('localhost.example.com')).text(),'verified');
 const before=received;
 await assert.rejects(get('wrong.example'), /altname|hostname|certificate/i);
 assert.equal(received,before,'wrong-host TLS must fail before HTTP reaches the server');
 // A DNS-delegated endpoint must match its own name, not the address domain.
 const discover=createProviderDiscovery(()=>({resolveTxt:async()=>[['v=hail1; provider=wrong.example.com']],cancel(){}}));
 const delegated=await discover('address.example',AbortSignal.timeout(5000));
 await assert.rejects(get(delegated!), /altname|hostname|certificate/i);
 const correctDiscovery=createProviderDiscovery(()=>({resolveTxt:async()=>[['v=hail1; provider=localhost.example.com']],cancel(){}}));
 assert.equal(await (await get((await correctDiscovery('address.example.com',AbortSignal.timeout(5000)))!)).text(),'verified');
 const calls=connected;
 const unsafe=new SafeHttpsTransport({lookup:async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]});
 await assert.rejects(unsafe.fetch(new Request('https://localhost/')),/exclusively to public/);
 assert.equal(connected,calls,'unsafe DNS must fail before dialing');
 assert.equal((await get('localhost.example.com','/redirect')).status,302);
 assert.equal(connected,calls+1,'redirect must not trigger a second request');
 const path=`/hail/bodies/${'A'.repeat(43)}/attachments/${'B'.repeat(43)}`;
 const headers={Authorization:`Bearer ${'C'.repeat(43)}`};
 assert.equal(await (await transport.fetchBody(await signTestRetrieval(new Request(`https://localhost.example.com${path}`,{headers}),`did:plc:${"a".repeat(24)}`))).text(),'verified');
 for(const suffix of ['?token=secret','/extra','/../other']) {
  await assert.rejects(transport.fetchBody(new Request(`https://localhost.example.com${path}${suffix}`,{headers})),/canonical body GET/);
 }
 console.log('Real TLS: matching host, wrong host, delegated host, DNS pinning, mixed-address SSRF, redirects and attachment paths passed');
} finally {
 mock.restore();
 if(server) {server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
 await rm(directory,{recursive:true,force:true});
}
