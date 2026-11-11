import {describe,expect,it} from 'vitest';
import {Hono} from 'hono';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import type {JmapMessages} from '../src/jmap/messages.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import vectors from '../../../spec/vectors/jmap.json';
const origin='https://provider.example.com';
const session={account_id:'fixture',did:'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',canonical_address:'test@example.com',scopes:['messages:read']} as AccountApiSession;
function app(){
  const app=new Hono();
  const accounts={authenticate:async(auth?:string,cookie?:string)=>auth==='Bearer valid'||cookie==='valid'?session:null} as AccountApiRepository;
  const messages={accountId:()=> 'account_fixture'} as unknown as JmapMessages;
  registerJmapRoutes(app,accounts,messages,origin);return app;
}
describe('JMAP request conformance vectors',()=>{
  for(const vector of vectors.cases)it(vector.name,async()=>{
    const result=await app().request(origin+'/jmap',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify(vector.request)});
    expect(result.status).toBe(vector.status);const body=await result.json();
    if(vector.responses)expect(body.methodResponses).toEqual(vector.responses);
    else expect(body.type).toBe(vector.problem);
    if("createdIds" in vector)expect(body.createdIds).toEqual(vector.createdIds);
  });
  it('rejects duplicate keys and cookies without exact browser Origin',async()=>{
    const server=app();const headers={'Content-Type':'application/json',Cookie:'hail_session=valid'};
    const body='{"using":["urn:ietf:params:jmap:core"],"methodCalls":[]}';
    expect((await server.request(origin+'/jmap',{method:'POST',headers,body})).status).toBe(403);
    expect((await server.request(origin+'/jmap',{method:'POST',headers:{...headers,Origin:origin},body})).status).toBe(200);
    const duplicate=await server.request(origin+'/jmap',{method:'POST',headers:{...headers,Origin:origin},body:'{"using":[],"using":[],"methodCalls":[]}'});
    expect(duplicate.status).toBe(400);expect((await duplicate.json()).type).toBe('urn:ietf:params:jmap:error:notJSON');
  });
  it('reserves mutation and event endpoints without advertising writable accounts',async()=>{
    const server=app(),headers={Authorization:'Bearer valid'};
    const session=await (await server.request(origin+'/.well-known/jmap',{headers})).json();
    expect(session.accounts.account_fixture.isReadOnly).toBe(true);
    expect((await server.request(origin+'/jmap/upload/account_fixture',{method:'POST',headers})).status).toBe(403);
    expect((await server.request(origin+'/jmap/events',{headers})).status).toBe(501);
  });
});
