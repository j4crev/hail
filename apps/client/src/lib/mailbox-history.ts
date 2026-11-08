type Row = {sender?:string;messageId?:string;kind?:string;id?:string;conversation?:{messages:{sender:string;messageId:string}[]};sharedConversation?:{creator:string;conversationId:string}};
export function appendRows<T extends Row>(previous:T[], incoming:T[]):T[] {
  const key = (row:Row) => row.id ?? JSON.stringify([row.kind,row.sender,row.messageId]);
  const shared = (row:Row) => row.sharedConversation && JSON.stringify([row.sharedConversation.creator,row.sharedConversation.conversationId]);
  const known = new Set(previous.map(key));
  const groups = new Set(previous.map(shared).filter(Boolean));
  const members = new Set(previous.flatMap(row => row.conversation?.messages.map(key) ?? []));
  return [...previous, ...incoming.filter(row => {
    if (known.has(key(row)) || shared(row) && groups.has(shared(row)) || row.conversation?.messages.some(member => members.has(key(member)))) return false;
    known.add(key(row));
    if (shared(row)) groups.add(shared(row));
    for (const member of row.conversation?.messages ?? []) members.add(key(member));
    return true;
  })];
}
// Cursor streams in Trash are independent. Never overwrite one with another's page.
export function appendMailbox<T>(previous:T, incoming:T, cursor:string):T {
  const before = previous as Record<string, any>, after = incoming as Record<string, any>;
  if (cursor === 'sentAfter') return {...before, sent:{...after.sent,messages:appendRows(before.sent.messages,after.sent.messages)}} as T;
  if (cursor === 'draftAfter') return {...before, drafts:{...after.drafts,drafts:appendRows(before.drafts.drafts,after.drafts.drafts)}} as T;
  if (Array.isArray(before.drafts)) return {...before, next:after.next, drafts:appendRows(before.drafts,after.drafts)} as T;
  return {...before, next:after.next, messages:appendRows(before.messages,after.messages)} as T;
}
