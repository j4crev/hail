import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real browser fetch receiver in a worker; a mock fetch accepts
// object receivers that WorkerGlobalScope.fetch rejects before sending anything.
const bundle = await Bun.build({ entrypoints: [new URL('../src/lib/push-handler.ts', import.meta.url).pathname], target: 'browser' });
assert(bundle.success, 'Push handler bundle failed');
const javascript = await bundle.outputs[0]!.text();
const id = '12345678-1234-1234-1234-123456789abc';
const requests: string[] = [];
let release:()=>void;
const finished=new Promise<void>(resolve=>{release=resolve;});
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/barrier') { await finished; return new Response(null,{status:204}); }
  if (path === '/done') { release(); return new Response(null,{status:204}); }
  if (path === '/handler.js') return new Response(javascript, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/worker.js') return new Response(`
    import {handlePush} from '/handler.js';
    const notices=[],reports=[];
    const deps={request:fetch,notify:async(title,options)=>notices.push(options.body),report:async result=>reports.push(result)};
    await handlePush({'@type':'PushVerification',pushSubscriptionId:'${id}',verificationCode:'A'.repeat(43)},deps);
    await handlePush({'@type':'StateChange',changed:{current:{HailMessage:'state'}}},deps);
    postMessage({notices,reports});
  `, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/api/jmap' || path === '/api/jmap/session') {
    requests.push(request.method + ' ' + path);
    assert.equal(request.headers.get('x-hail-background'), 'true');
    if (path === '/api/jmap') {
      assert.equal(request.method, 'POST');
      const body = await request.json();
      assert.deepEqual(body.methodCalls, [['PushSubscription/set', {update:{[id]:{verificationCode:'A'.repeat(43)}}}, 'verify-push']]);
      return Response.json({methodResponses:[['PushSubscription/set',{updated:{[id]:null}},'verify-push']]});
    }
    return Response.json({accounts:{current:{}},primaryAccounts:{messages:'current'}});
  }
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path !== '/') return new Response(null, { status: 404 });
  return new Response(`<body>RUNNING<img src='/barrier'><script>
    const worker=new Worker('/worker.js',{type:'module'});
    worker.onmessage=({data})=>{
      document.body.textContent=JSON.stringify(data.notices)===JSON.stringify(['Notifications enabled.','Your mailbox has updates.']) &&
        data.reports.length===1 && data.reports[0].ok===true ? 'PASS: worker push fetch' : 'FAIL: '+JSON.stringify(data);
      worker.terminate();void fetch('/done');
    };
    worker.onerror=()=>{document.body.textContent='FAIL: worker error';void fetch('/done');};
  </script>`, { headers: { 'content-type': 'text/html' } });
}});
const profile = await mkdtemp(join(tmpdir(), 'hail-push-browser-'));
try {
  const child = Bun.spawn([process.env.CHROMIUM || 'chromium', '--headless', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom',
    '--timeout=20000', '--virtual-time-budget=10000', server.url.toString()], { stdout:'pipe', stderr:'pipe' });
  const [html, stderr, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  assert.equal(code,0,stderr.slice(-1000));
  assert(html.includes('<body>PASS: worker push fetch'), `Worker push failed: ${html}`);
  assert.deepEqual(requests,['POST /api/jmap','GET /api/jmap/session']);
  console.info('PASS: native worker fetch verifies push and authorizes mailbox notifications');
} finally { server.stop(true); await rm(profile,{recursive:true,force:true}); }
