import {expect,it} from 'vitest';
import {sanitizeError,sanitizeSpan,sentryCsp,sentryOrigin} from './sentry.js';

it('retains code locations and provider status without account or message data',()=>{
  const result=sanitizeError({type:undefined,event_id:'event',environment:'test',release:'commit',
    request:{url:'https://haili.app/message/private?token=secret',headers:{cookie:'hail_session=secret'},data:'private message'},
    user:{email:'private@example.com'},extra:{recovery:'secret'},breadcrumbs:[{message:'private message'}],
    exception:{values:[{type:'AccountApiError',value:'Provider API returned HTTP 429. private message',
      stacktrace:{frames:[{filename:'https://haili.app/_app/immutable/app.js?token=secret',function:'load',lineno:10,vars:{token:'secret'},context_line:'private message'}]}},
      {type:'Error',value:'private message'}]}});
  expect(JSON.stringify(result)).not.toMatch(/private|secret|cookie|recovery/);
  expect(result.exception?.values?.[0].value).toBe('Provider API returned HTTP 429.');
  expect(result.exception?.values?.[0].stacktrace?.frames?.[0]).toMatchObject({filename:'https://haili.app/_app/immutable/app.js',function:'load',lineno:10});
});

it('removes URL and payload attributes from streamed spans',()=>{
  const result=sanitizeSpan({trace_id:'trace',span_id:'span',name:'/message/private?token=secret',start_timestamp:1,end_timestamp:2,status:'error',is_segment:true,
    attributes:{'sentry.op':'http.server','url.full':'https://haili.app/private','http.request.body':'secret'}});
  expect(result.name).toBe('http.server');
  expect(result.attributes).toEqual({'sentry.op':'http.server'});
  expect(JSON.stringify(result)).not.toMatch(/private|secret/);
});

it('permits only the configured ingest origin and preserves restrictive CSP policies',()=>{
  const origin=sentryOrigin('https://key@ingest.example.com/123')!;
  expect(origin).toBe('https://ingest.example.com');
  expect(sentryOrigin('http://ingest.example.com/123')).toBeNull();
  expect(sentryCsp("default-src 'self'; connect-src 'self'; script-src 'nonce-abc'",origin))
    .toBe("default-src 'self'; connect-src 'self' https://ingest.example.com; script-src 'nonce-abc'");
  expect(sentryCsp("connect-src 'none'; form-action 'none'",origin)).toBe("connect-src 'none'; form-action 'none'");
});
