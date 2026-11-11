import {readJmapJson} from './jmap.js';
const CORE='urn:ietf:params:jmap:core',PUSH='https://racrproto.com/ns/jmap/push';
const DEVICE='hail.push.device.v1',BINDING='hail.push.binding.v1';
interface Subscription {id:string;deviceClientId:string;verificationCode:string|null;verificationError?:string|null;expires:string}
interface Capability {applicationServerKey:string;contentEncoding:string}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
async function request(path:string,body?:unknown){
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20_000),
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error('Notifications are unavailable. Try again.');
  return await readJmapJson(response,65536) as Record<string,any>;
}
async function call(method:string,args:unknown){
  const result=await request('/api/jmap',{using:[CORE],methodCalls:[[method,args,'push']]});
  const invocation=result.methodResponses?.[0];
  if(!Array.isArray(invocation)||invocation[0]!==method||invocation[2]!=='push'||!object(invocation[1]))throw Error('Notification settings could not be saved.');
  const value=invocation[1];
  if(['notCreated','notUpdated','notDestroyed'].some(k=>object(value[k])&&Object.keys(value[k]).length))throw Error('Notification settings could not be saved. Try again later.');
  return value;
}
function device(){let value=localStorage.getItem(DEVICE);if(!value){value=crypto.randomUUID();localStorage.setItem(DEVICE,value);}return value;}
async function subscriptions():Promise<Subscription[]>{
  const result=await call('PushSubscription/get',{});
  if(!Array.isArray(result.list))throw Error('Invalid notification settings.');
  return result.list.filter((s:Subscription)=>s.deviceClientId===device());
}
function applicationKey(capability:Capability){return Uint8Array.from(atob(capability.applicationServerKey.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
function keyMatches(browser:PushSubscription,capability:Capability){
  const previous=browser.options.applicationServerKey,key=applicationKey(capability);
  return !!previous&&previous.byteLength===key.length&&new Uint8Array(previous).every((v,i)=>v===key[i]);
}
async function fingerprint(browser:PushSubscription){
  const json=browser.toJSON(),bytes=new TextEncoder().encode(JSON.stringify([json.endpoint,json.keys?.p256dh,json.keys?.auth]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
async function bindingMatches(browser:PushSubscription,list:Subscription[]){
  let binding:unknown;try{binding=JSON.parse(localStorage.getItem(BINDING)??'null');}catch{return false;}
  return object(binding)&&list.some(s=>s.id===binding.id)&&binding.fingerprint===await fingerprint(browser);
}
export async function pushStatus():Promise<{available:boolean;enabled:boolean;pending:boolean;verificationError?:string;capability?:Capability}>{
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return {available:false,enabled:false,pending:false};
  const session=await request('/api/jmap/session'),capability=session.capabilities?.[PUSH];
  if(!object(capability)||capability.contentEncoding!=='aes128gcm'||typeof capability.applicationServerKey!=='string')return {available:false,enabled:false,pending:false};
  const registration=await navigator.serviceWorker.getRegistration('/');
  const browser=await registration?.pushManager.getSubscription(),list=await subscriptions();
  const cap=capability as unknown as Capability,matched=!!browser&&keyMatches(browser,cap)&&await bindingMatches(browser,list);
  const failure=list.find(s=>!s.verificationCode&&s.verificationError)?.verificationError;
  return {available:true,...(matched&&failure?{verificationError:failure}:{}),enabled:matched&&Notification.permission==='granted'&&list.some(s=>!!s.verificationCode),pending:matched&&list.some(s=>!s.verificationCode),capability:cap};
}
export async function enablePush(capability:Capability){
  // Called directly from a button click: never prompt during page load.
  if(await Notification.requestPermission()!=='granted')throw Error('Allow notifications in your browser settings to enable them.');
  await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});
  const registration=await navigator.serviceWorker.ready;
  const key=applicationKey(capability);
  let browser=await registration.pushManager.getSubscription();
  const keyChanged=browser&&!keyMatches(browser,capability);
  if(keyChanged){await browser!.unsubscribe();browser=null;}
  const list=await subscriptions();
  if(browser&&list.length&&!keyChanged&&await bindingMatches(browser,list)){
    // Renewal does not extend authentication/session lifetime.
    await call('PushSubscription/set',{update:Object.fromEntries(list.map(s=>[s.id,{expires:null}]))});return;
  }
  if(list.length)await call('PushSubscription/set',{destroy:list.map(s=>s.id)});
  browser??=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  const json=browser.toJSON();
  if(!json.endpoint||!json.keys)throw Error('Your browser did not provide notification keys.');
  const result=await call('PushSubscription/set',{create:{browser:{deviceClientId:device(),url:json.endpoint,keys:json.keys,types:['HailMessage'],expires:null}}});
  const id=result.created?.browser?.id;
  if(typeof id!=='string')throw Error('Notification registration could not be confirmed.');
  localStorage.setItem(BINDING,JSON.stringify({id,fingerprint:await fingerprint(browser)}));
}
export async function disablePush(){
  const list=await subscriptions();
  if(list.length)await call('PushSubscription/set',{destroy:list.map(s=>s.id)});
  const registration=await navigator.serviceWorker.getRegistration('/');
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  localStorage.removeItem(BINDING);
}
