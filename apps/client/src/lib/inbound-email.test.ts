import {expect,it} from 'vitest';
import {parseAliases,parseInboundEmail} from './inbound-email.js';

const on={available:true,domain:'in.mail.example',sender:{address:'email@mail.example',category:'email'},enabled:true,
  grant:{grantId:'0b8f1a52-6d1e-4c3a-9a51-2f0f7a1c00ff',revision:2,digest:'A'.repeat(43)}};
const alias={id:'0b8f1a52-6d1e-4c3a-9a51-2f0f7a1c0001',address:'kq4tzx7m2fpa@in.mail.example',label:'News',createdAt:'2026-11-01T00:00:00Z',lastReceivedAt:null,messageCount:0};

it('reads the inbound email state and treats a provider without the bridge as unavailable',()=>{
  expect(parseInboundEmail({available:false})).toEqual({available:false});
  expect(parseInboundEmail(on)).toEqual(on);
  expect(parseInboundEmail({...on,enabled:false,grant:null})).toMatchObject({enabled:false,grant:null});
  for(const bad of [null,{},{...on,enabled:true,grant:null},{...on,enabled:false},{...on,domain:'Bad Domain'},{...on,grant:{...on.grant,grantId:'x'}}])
    expect(()=>parseInboundEmail(bad)).toThrow();
});

it('validates alias lists',()=>{
  expect(parseAliases([alias,{...alias,id:'0b8f1a52-6d1e-4c3a-9a51-2f0f7a1c0002',lastReceivedAt:'2026-11-10T00:00:00Z',messageCount:3}])).toHaveLength(2);
  for(const bad of [null,[{...alias,id:'x'}],[{...alias,messageCount:-1}],[{...alias,createdAt:'never'}],Array(51).fill(alias)])
    expect(()=>parseAliases(bad)).toThrow();
});
