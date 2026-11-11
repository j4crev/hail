import {Hono} from 'hono';
import {expect,it,vi} from 'vitest';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import {JmapOperations} from '../src/jmap/operations.js';
import {UserGrantError} from '../src/grants/service.js';

it('correlates rejected connection batches without logging bodies, credentials or unexpected error text',async()=>{
  const id='00000000-0000-7000-8000-000000000001',log=vi.spyOn(console,'error').mockImplementation(()=>{});
  let failure:Error=new UserGrantError(409,'Finish or cancel open message batches first');
  const app=new Hono(),accounts={authenticate:async()=>({account_id:id,serving_generation:1,scopes:['messages:write'],migration_state:null})};
  registerJmapRoutes(app,accounts as never,{accountId:()=> 'account'} as never,'https://example.com',undefined,undefined,undefined,undefined,
    new JmapOperations({accounts:accounts as never,grants:{} as never,service:{} as never,publications:{createConnections:async()=>{throw failure;}} as never}));
  const send=async()=>{
    const response=await app.request('/jmap',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer private-credential'},
      body:JSON.stringify({using:['urn:ietf:params:jmap:core','https://haili.app/ns/jmap/account'],methodCalls:[['HailSubmission/submit',{accountId:'account',kind:'connections',input:{publicationId:id,text:'private message text',connections:[]}},'send']]})});
    return (await response.json() as any).methodResponses[0][1];
  };
  try{
    expect((await send()).httpStatus).toBe(409);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({requestId:id,outcome:'rejected',status:409,reason:'Finish or cancel open message batches first'});
    failure=new Error('private database detail');
    expect((await send()).type).toBe('serverFail');
    const output=JSON.stringify(log.mock.calls);
    for(const secret of ['private message text','private-credential','private database detail'])expect(output).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[1]![0]).frames.length).toBeGreaterThan(0);
  }finally{log.mockRestore();}
});
