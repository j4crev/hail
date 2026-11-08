import * as Sentry from '@sentry/sveltekit';
import {privacyOptions} from './lib/sentry.js';

// instrumentation runs before SvelteKit initializes its dynamic environment.
if (process.env.PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn:process.env.PUBLIC_SENTRY_DSN,
    environment:process.env.PUBLIC_SENTRY_ENVIRONMENT || 'development',
    release:process.env.PUBLIC_SENTRY_RELEASE,
    tracesSampleRate:process.env.PUBLIC_SENTRY_ENVIRONMENT==='production'?0.1:1,
    ...privacyOptions,
    includeServerName:false,
  });
}
