/// <reference lib="webworker" />
import {handlePush} from './lib/push-handler.js';
const worker=self as unknown as ServiceWorkerGlobalScope;
worker.addEventListener('install',event=>event.waitUntil(worker.skipWaiting()));
worker.addEventListener('activate',event=>event.waitUntil(worker.clients.claim()));
worker.addEventListener('push',event=>{
  let value:unknown;
  try{const text=event.data?.text();if(!text||text.length>8192)return;value=JSON.parse(text);}catch{return;}
  event.waitUntil(handlePush(value,{request:fetch,notify:(title,options)=>worker.registration.showNotification(title,options)}));
});
worker.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const clients=await worker.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=clients.find(client=>new URL(client.url).origin===worker.location.origin);
    if(existing){await existing.focus();return;}
    await worker.clients.openWindow('/');
  })());
});
