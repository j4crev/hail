import type {Hono} from "hono";
import {getCookie} from "hono/cookie";
import type {AuthenticationResponseJSON} from "@simplewebauthn/server";
import {decodeBase64Url,encodeBase64Url} from "@racrproto/codec";
import {AccountConnections,ConnectionError} from "./connections.js";
import type {AccountApiRepository} from "./repository.js";
import {PasskeyError} from "./passkeys.js";
import {accountRequestBytes} from "./routes.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {FixedWindowRateLimit,clientAddress} from "../http/rate-limit.js";
import {withServingGeneration} from "../db/serving.js";

export function registerConnectionRoutes(app:Hono,connections:AccountConnections,accounts:AccountApiRepository,origin:string){
  const source=new FixedWindowRateLimit(),account=new FixedWindowRateLimit();
  if(connections.federation)app.post("/hail/connections/:step",async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    try{
      if(source.take(clientAddress(c.req.raw),120)!==null)throw new ConnectionError(429);
      if(c.req.header("Authorization")||c.req.header("Cookie")||c.req.header("Origin"))throw new ConnectionError(403);
      if(c.req.header("Content-Type")!=="application/json"||c.req.header("Content-Encoding"))throw new ConnectionError(415);
      const step=c.req.param("step");if(!["state","admit","commit","disconnect","sync","handover","handover-freeze","handover-abort","handover-commit","handover-complete"].includes(step))throw new ConnectionError(404);
      const bytes=await accountRequestBytes(c.req.raw,131072);if(!bytes)throw new ConnectionError(413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new ConnectionError(400);}
      return c.json(await connections.federation!.handle(step as "state"|"admit"|"commit"|"disconnect"|"sync"|"handover"|"handover-freeze"|"handover-abort"|"handover-commit"|"handover-complete",input));
    }catch(error){return new Response(JSON.stringify({error:"Connection exchange not accepted"}),{status:error instanceof ConnectionError?error.status:503,
      headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
  });
  app.post("/hail/connections/invitations/review",async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    try{
      if(source.take(clientAddress(c.req.raw),60)!==null)throw new ConnectionError(429);
      if(c.req.header("Authorization")||c.req.header("Cookie")||c.req.header("Origin"))throw new ConnectionError(403);
      if(c.req.header("Content-Type")!=="application/json"||c.req.header("Content-Encoding"))throw new ConnectionError(415);
      const bytes=await accountRequestBytes(c.req.raw,2048);if(!bytes)throw new ConnectionError(413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new ConnectionError(400);}
      return c.json(await connections.exportInvitation(input));
    }catch(error){return new Response(JSON.stringify({error:"Connection invitation unavailable"}),{status:error instanceof ConnectionError?error.status:503,
      headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
  });
}
