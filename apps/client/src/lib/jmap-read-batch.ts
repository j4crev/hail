// JMAP uses POST for reads too. Only known, inspectable read-only batches may
// skip mailbox invalidation; unknown methods/bodies remain mutations.
export function isJmapReadBatch(body:unknown):boolean{
  if(typeof body!=='string'||body.length>1_048_576)return false;
  try{
    const input=JSON.parse(body);
    return Array.isArray(input?.methodCalls)&&input.methodCalls.every((call:unknown)=>Array.isArray(call)&&call.length===3&&
      ['HailMailbox/view','HailSubmission/status','HailSubmission/recent','HailSubmission/audiences','HailSubmission/targets','HailGrant/list','HailGrant/read','HailGrant/approvalStatus','HailRelationship/list','HailRelationship/status',...['HailSent','HailSubmission','HailGrant','HailRelationship'].flatMap(t=>['get','query','changes','queryChanges'].map(m=>t+'/'+m)),'Core/echo','HailMessage/get','HailMessage/query','HailMessage/changes','HailMessage/queryChanges','HailDraft/get','HailDraft/query','HailDraft/changes','HailDraft/queryChanges'].includes(call[0]));
  }catch{return false;}
}
