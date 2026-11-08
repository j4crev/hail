import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import {sentrySvelteKit} from '@sentry/sveltekit/vite';

export default defineConfig(({mode}) => {
  const env = {...loadEnv(mode, process.cwd(), "HAIL_WEB_CLIENT_"), ...process.env};
  const target = env.HAIL_WEB_CLIENT_API_ORIGIN || env.HAIL_WEB_CLIENT_PROVIDER;
  return {
    plugins: [sentrySvelteKit({
      adapter:'node',autoInstrument:false,autoUploadSourceMaps:Boolean(process.env.SENTRY_AUTH_TOKEN),
      org:process.env.SENTRY_ORG,project:process.env.SENTRY_PROJECT,
      authToken:process.env.SENTRY_AUTH_TOKEN,telemetry:false,
      sourcemaps:{filesToDeleteAfterUpload:['./.svelte-kit/output/client/**/*.map','./build/client/**/*.map']},
    }),tailwindcss(), sveltekit()],
    ssr: {external: ["@atproto/common", "@atproto/crypto", "@did-plc/lib", "@racrproto/codec", "@ipld/dag-cbor", "multiformats"]},
    server: {proxy: target ? {
      "/api/v1/auth": {target, changeOrigin: false, secure: true},
      "/api/v1/operator": {target, changeOrigin: false, secure: true},
    } : undefined},
  };
});
