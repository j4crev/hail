import type {ErrorEvent, init} from '@sentry/sveltekit';
type StreamedSpanJSON=Parameters<NonNullable<Parameters<typeof init>[0]['beforeSendSpan']>>[0];

// Mailbox content, credentials and identity data must never become telemetry.
export const dataCollection = {
  userInfo:false, cookies:false, httpHeaders:false, httpBodies:[], urlQueryParams:false,
  stackFrameVariables:false, frameContextLines:0, databaseQueryData:false,
  graphQL:{document:false,variables:false}, genAI:{inputs:false,outputs:false},
  mcp:{inputs:false,outputs:false}, queues:false,
};

function sourceFile(value?:string) {
  if (!value) return undefined;
  // Keep code locations; discard request URLs and query strings.
  const path=value.split(/[?#]/)[0];
  return /\.(?:[cm]?js|ts|svelte)$/.test(path) ? path : undefined;
}

export function sanitizeError(event:ErrorEvent):ErrorEvent {
  return {
    type:event.type,
    event_id:event.event_id,timestamp:event.timestamp,platform:event.platform,level:event.level,
    release:event.release,environment:event.environment,sdk:event.sdk,debug_meta:event.debug_meta,
    exception:{values:event.exception?.values?.map(exception=>({
      type:exception.type?.replace(/[^a-zA-Z0-9_.]/g,'').slice(0,80),
      // Arbitrary exception messages can contain message text or recovery material.
      value:/^Provider API returned HTTP \d{3}\./.test(exception.value??'')
        ? exception.value!.match(/^Provider API returned HTTP \d{3}\./)![0] : 'Error details omitted for privacy',
      mechanism:exception.mechanism ? {type:exception.mechanism.type,handled:exception.mechanism.handled} : undefined,
      stacktrace:exception.stacktrace ? {frames:exception.stacktrace.frames?.map(frame=>({
        filename:sourceFile(frame.filename),function:frame.function,lineno:frame.lineno,colno:frame.colno,in_app:frame.in_app,
      }))} : undefined,
    }))},
  };
}

export function sanitizeSpan(span:StreamedSpanJSON):StreamedSpanJSON {
  const op=String(span.attributes['sentry.op']??'operation').replace(/[^a-zA-Z_.]/g,'').slice(0,80);
  return {trace_id:span.trace_id,parent_span_id:span.parent_span_id,span_id:span.span_id,
    name:op,start_timestamp:span.start_timestamp,end_timestamp:span.end_timestamp,
    status:span.status,is_segment:span.is_segment,attributes:{'sentry.op':op}};
}

export const privacyOptions = {
  dataCollection,maxBreadcrumbs:0,tracePropagationTargets:[],
  beforeSend:sanitizeError,beforeSendSpan:sanitizeSpan,
  beforeSendLog:()=>null,beforeSendMetric:()=>null,
};

export function sentryOrigin(dsn:string|undefined):string|null {
  if (!dsn) return null;
  try {const url=new URL(dsn);return url.protocol==='https:' ? url.origin : null;} catch {return null;}
}

export function sentryCsp(policy:string,origin:string):string {
  return policy.replace(/(^|;)\s*connect-src\s+([^;]+)/g,(directive,separator,sources)=>
    sources.includes("'none'") ? directive : `${separator} connect-src ${sources} ${origin}`);
}
