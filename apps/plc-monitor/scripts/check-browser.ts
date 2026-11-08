import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBrowser } from './build-browser.js';
const javascript = await (await buildBrowser(new URL('./browser-recovery-proof.ts', import.meta.url).pathname)).text();
const unexpected: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/proof.js') return new Response(javascript, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path !== '/') { unexpected.push(path); return new Response(null, { status: 404 }); }
  return new Response('<!doctype html><body>RUNNING<script type="module" src="/proof.js"></script></body>', {
    headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'" } });
} });
const profile = await mkdtemp(join(tmpdir(), 'hail-monitor-browser-'));
try {
  const child = Bun.spawn([process.env.CHROMIUM || 'chromium', '--headless', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', '--timeout=20000',
    '--virtual-time-budget=10000', server.url.toString()], { stdout: 'pipe', stderr: 'pipe' });
  const [html, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr.slice(-1000)); assert(html.includes('PASS: browser recovery'), html);
  assert.deepEqual(unexpected, []); console.info('PASS: Chromium PLC recovery with network access blocked');
} finally { server.stop(true); await rm(profile, { recursive: true, force: true }); }

// Exercise the shipped page and bundle: no automatic redemption, URL removal,
// explicit entry, data rendering and explicit exact-state recognition.
const { incidentHtml, incidentStyles } = await import('../src/incident-page.js');
const app = await (await buildBrowser()).text();
const incidentId = '12345678-1234-1234-1234-123456789abc', capability = 'a'.repeat(43);
let redemptions = 0, approvals = 0;
const fixture = { id: incidentId, did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', category: 'unexpected-operation',
  detail: { operationCid: 'current' }, summary: 'Messaging service changed. Review before and after.',
  directoryVerified: true, recoveryCid: 'current', currentCid: 'current', currentState: { services: {} }, currentDigest: 'digest',
  expectedCid: 'previous', expectedState: {}, operationStatus: 'current', approvalAuthority: null,
  checkedAt: new Date().toISOString(), lastMonitorPollAt: new Date().toISOString(), monitorReady: true, recovery: null, audit: [] };
const uiServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/incidents/app.js') return new Response(app, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/incidents/style.css') return new Response(incidentStyles, { headers: { 'Content-Type': 'text/css' } });
  if (path.endsWith('/data')) return redemptions ? Response.json({ ...fixture, expectedCid: approvals ? 'current' : 'previous' }) : Response.json({ error: 'Open link' }, { status: 401 });
  if (path.endsWith('/redeem')) {
    assert.equal((await request.json()).token, capability); redemptions++; return Response.json({});
  }
  if (path.endsWith('/approve')) {
    assert.deepEqual(await request.json(), { cid: 'current', digest: 'digest' }); approvals++; return Response.json({});
  }
  if (path === '/test.js') return new Response(`
    const wait = async predicate => { for (let i=0;i<200;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw Error('UI timed out'); };
    try {
      await wait(()=>!location.search);
      if(document.getElementById('entry').hidden) throw Error('Automatic entry');
      document.getElementById('open').click();
      await wait(()=>!document.getElementById('incident').hidden && !document.getElementById('recognize').disabled);
      if(!document.getElementById('summary').textContent.includes('Messaging service')) throw Error('Missing explanation');
      if(document.querySelectorAll('input[name=mode]').length!==2) throw Error('Missing recovery choice');
      document.getElementById('recognize-confirm').checked=true; document.getElementById('recognize').click();
      await wait(()=>document.getElementById('message').textContent.includes('Change recognized'));
      document.body.textContent='PASS: incident UI capability entry and recognition';
    } catch(error) {document.body.textContent='FAIL: '+error.message;}
  `, { headers: { 'Content-Type': 'text/javascript' } });
  return new Response(incidentHtml.replace('</body>', '<script type="module" src="/test.js"></script></body>'),
    { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'" } });
} });
const uiProfile = await mkdtemp(join(tmpdir(), 'hail-monitor-ui-'));
try {
  const child = Bun.spawn([process.env.CHROMIUM || 'chromium', '--headless', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${uiProfile}`, '--dump-dom', '--timeout=20000',
    '--virtual-time-budget=10000', `${uiServer.url}incidents/${incidentId}?token=${capability}`], { stdout: 'pipe', stderr: 'pipe' });
  const [html, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr.slice(-1000)); assert(html.includes('PASS: incident UI'), html);
  assert.equal(redemptions, 1); assert.equal(approvals, 1);
  console.info('PASS: Chromium incident page, token entry, both choices and exact-state recognition');
} finally { uiServer.stop(true); await rm(uiProfile, { recursive: true, force: true }); }
