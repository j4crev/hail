import {expect,it} from 'vitest';
import {isJmapReadBatch} from './jmap-read-batch.js';
it('does not invalidate mailbox data for a JMAP read batch',()=>{
  expect(isJmapReadBatch(JSON.stringify({methodCalls:[['HailMessage/query',{},'q'],['HailMessage/get',{},'g'],['HailDraft/changes',{},'d']]}))).toBe(true);
});
it('invalidates mixed writes, unknown methods and uninspectable bodies conservatively',()=>{
  for(const body of [undefined,'{',new Uint8Array(),JSON.stringify({methodCalls:[['HailMessage/query',{},'q'],['HailMessage/set',{},'s']]}),JSON.stringify({methodCalls:[['Other/get',{},'g']]})])
    expect(isJmapReadBatch(body)).toBe(false);
});
