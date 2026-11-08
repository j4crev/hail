import { dirname, resolve } from 'node:path';
// @did-plc/lib uses the server common barrel for three browser-safe helpers.
// Select the upstream browser implementation and equivalent DAG-CBOR CID helper,
// avoiding server stream/fs imports without forking the PLC verification rules.
const resolved = (name: string) => JSON.stringify(import.meta.resolve(name).replace('file://', ''));
const common = dirname(import.meta.resolve('@atproto/common').replace('file://', ''));
const commonWeb = import.meta.resolve('@atproto/common-web', resolve(common, 'index.js')).replace('file://', '');
export async function buildBrowser(entrypoint = resolve(import.meta.dir, '../src/incident-browser.ts')) {
const result = await Bun.build({ entrypoints: [entrypoint], target: 'browser', minify: true,
  plugins: [{ name: 'plc-browser-common', setup(build) {
    build.onResolve({ filter: /^@atproto\/common$/ }, () => ({ path: 'common', namespace: 'plc-browser' }));
    build.onLoad({ filter: /.*/, namespace: 'plc-browser' }, () => ({ loader: 'js', resolveDir: resolve(import.meta.dir, '..'),
      contents: `export * from ${JSON.stringify(commonWeb)};
        import { CID } from ${resolved('multiformats/cid')}; import { sha256 } from ${resolved('multiformats/hashes/sha2').replace('sha2.js', 'sha2-browser.js')}; import { encode } from ${resolved('@ipld/dag-cbor')};
        export async function cidForCbor(value) { return CID.createV1(0x71, await sha256.digest(encode(value))); }` }));
  } }] });
if (!result.success) throw new AggregateError(result.logs, 'Monitor browser build failed');
return result.outputs[0]!;
}
if (import.meta.main) {
  const result = await buildBrowser();
  await Bun.write(resolve(import.meta.dir, '../dist-browser/incident-browser.js'), result);
  console.info(`Built monitor browser (${result.size} bytes)`);
}
