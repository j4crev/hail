import {afterEach,expect,it,vi} from 'vitest';
import {pushStatus,enablePush,disablePush} from './push.js';
afterEach(()=>vi.unstubAllGlobals());
const capability={applicationServerKey:btoa(String.fromCharCode(4,...Array(64).fill(1))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''),contentEncoding:'aes128gcm'};
function fixture(){
  const storage=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
  const notification={permission:'granted',requestPermission:vi.fn(async()=>notification.permission)};
  vi.stubGlobal('Notification',notification);vi.stubGlobal('window',{PushManager:{},Notification:notification});
  let browser:any=null,list:any[]=[];
  const subscription={options:{applicationServerKey:Uint8Array.from(atob(capability.applicationServerKey),c=>c.charCodeAt(0)).buffer},
    toJSON:()=>({endpoint:'https://push.example/device',keys:{p256dh:'device-key',auth:'secret'}}),unsubscribe:vi.fn(async()=>{browser=null;return true;})};
  const registration={pushManager:{getSubscription:vi.fn(async()=>browser),subscribe:vi.fn(async()=>browser=subscription)}};
  const serviceWorker={getRegistration:vi.fn(async()=>registration),register:vi.fn(async()=>registration),ready:Promise.resolve(registration)};
  vi.stubGlobal('navigator',{serviceWorker});
  const calls:any[]=[];
  const request=vi.fn(async(path:string,init?:RequestInit)=>{
    expect(init).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
    if(path==='/api/jmap/session')return Response.json({apiUrl:'https://evil.example',capabilities:{'https://haili.app/ns/jmap/push':capability}});
    expect(path).toBe('/api/jmap');const body=JSON.parse(String(init?.body));const [method,args,tag]=body.methodCalls[0];calls.push({method,args});
    if(method==='PushSubscription/get')return Response.json({methodResponses:[[method,{list},tag]]});
    if(args.create){list=[{id:'registered',deviceClientId:args.create.browser.deviceClientId,verificationCode:null}];}
    if(args.destroy)list=[];
    return Response.json({methodResponses:[[method,{created:{browser:{id:'registered'}},updated:{},destroyed:args.destroy??[]},tag]]});
  });vi.stubGlobal('fetch',request);
  return {notification,registration,serviceWorker,subscription,calls,request,verify(){list[0].verificationCode='verified';}};
}
it('does not prompt on discovery; explicitly registers once and reflects verification',async()=>{
  const f=fixture();expect(await pushStatus()).toMatchObject({available:true,enabled:false,pending:false});
  expect(f.notification.requestPermission).not.toHaveBeenCalled();expect(f.serviceWorker.register).not.toHaveBeenCalled();
  await enablePush(capability);expect(f.notification.requestPermission).toHaveBeenCalledTimes(1);
  expect(f.serviceWorker.register).toHaveBeenCalledWith('/service-worker.js',{scope:'/'});
  expect(f.registration.pushManager.subscribe).toHaveBeenCalledWith({userVisibleOnly:true,applicationServerKey:expect.any(Uint8Array)});
  expect(await pushStatus()).toMatchObject({enabled:false,pending:true});f.verify();expect(await pushStatus()).toMatchObject({enabled:true,pending:false});
  await enablePush(capability);expect(f.calls.filter(c=>c.args.create)).toHaveLength(1);
  expect(f.calls.at(-1).args.update).toEqual({registered:{expires:null}});
  await disablePush();expect(f.calls.at(-1).args.destroy).toEqual(['registered']);expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it('does not subscribe or contact endpoints when permission is refused',async()=>{
  const f=fixture();f.notification.permission='denied';await expect(enablePush(capability)).rejects.toThrow('Allow notifications');
  expect(f.request).not.toHaveBeenCalled();expect(f.registration.pushManager.subscribe).not.toHaveBeenCalled();
});
it('reports unsupported browsers without contacting the provider',async()=>{
  const f=fixture();vi.stubGlobal('navigator',{});expect(await pushStatus()).toEqual({available:false,enabled:false,pending:false});expect(f.request).not.toHaveBeenCalled();
});

it('replaces a refreshed browser endpoint instead of renewing stale server destinations',async()=>{
  const f=fixture();await enablePush(capability);f.verify();
  f.subscription.toJSON=()=>({endpoint:'https://push.example/new-device',keys:{p256dh:'new-key',auth:'new-secret'}});
  expect(await pushStatus()).toMatchObject({enabled:false,pending:false});
  await enablePush(capability);
  expect(f.calls.filter(c=>c.args.destroy)).toHaveLength(1);
  expect(f.calls.filter(c=>c.args.create)).toHaveLength(2);
  expect(f.calls.at(-1).args.create.browser.url).toBe('https://push.example/new-device');
});
