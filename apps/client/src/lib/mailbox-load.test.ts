import {expect,it,vi} from 'vitest';
vi.mock('$app/environment',()=>({browser:false}));
import {readMailbox} from './mailbox-load.js';

it.each([303,307])('preserves the server loader redirect status %s',async status=>{
  const location=status===303?'/?next=%2F%3Fview%3Dconnections':'/?view=connections';
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({redirect:location,status}),{headers:{'Content-Type':'application/json'}}));
  await expect(readMailbox(fetcher,new URL('https://provider.example/?view=connections'))).rejects.toMatchObject({status,location});
});
