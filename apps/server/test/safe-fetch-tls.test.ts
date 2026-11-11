import {expect,it} from 'vitest';
it('verifies service identity with a trusted CA through the DNS-aware transport',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./support/safe-fetch-tls.ts',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+'\n'+error).toBe(0);
},20000);
