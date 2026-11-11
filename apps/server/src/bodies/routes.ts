import type {BodyRequestVerifier} from "./request-proof.js";
import {ProtectedResponseSchedule} from "../http/protected-schedule.js";
import { createHash } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@racrproto/codec";
import type { Hono } from "hono";
import { BODY_MEDIA_TYPE, type BodyStore } from "./service.js";
import {clientAddress,FixedWindowRateLimit} from "../http/rate-limit.js";

const PATH = /^\/hail\/bodies\/([A-Za-z0-9_-]{43})(?:\/attachments\/([A-Za-z0-9_-]{43}))?$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/i;

function problem(status: number, title: string, headers: Record<string, string> = {}): Response {
  return Response.json({ type: "about:blank", title, status }, {
    status,
    headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store", ...headers },
  });
}

function canonical32(value: string): Uint8Array | null {
  try {
    const bytes = decodeBase64Url(value);
    return bytes.length === 32 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function acceptsBody(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(",").some((part) => {
    const [type, ...params] = part.trim().split(";");
    if (params.some((param) => !/^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(param.trim()))) return false;
    const quality = params.length ? Number(params[0]!.trim().slice(2)) : 1;
    return quality > 0 && [BODY_MEDIA_TYPE, "application/*", "*/*"].includes(type!.trim().toLowerCase());
  });
}

export function registerBodyRoutes(app: Hono, store: BodyStore, proof?: Pick<BodyRequestVerifier,"verify">,
  schedule = new ProtectedResponseSchedule()): void {
  const rateLimit=new FixedWindowRateLimit(), tokenLimit=new FixedWindowRateLimit();
  app.all("/hail/bodies/*", async (context) => {
    const retry=rateLimit.take(clientAddress(context.req.raw),120);
    if(retry!==null)return problem(429,"Too Many Requests",{"Retry-After":String(retry)});
    if (context.req.method !== "GET") return problem(405, "Method Not Allowed", { Allow: "GET" });
    const result = await schedule.run(async signal => {
      const notFound = () => null;
      const url = new URL(context.req.url);
      const match = PATH.exec(url.pathname);
      const authorization = context.req.header("Authorization");
      const credential = authorization === undefined ? null : BEARER.exec(authorization)?.[1];
      const digest = match?.[1] ? canonical32(match[1]) : null;
      const token = credential ? canonical32(credential) : null;
      const attachmentDigest=match?.[2]?canonical32(match[2]):null;
      if (url.search || !digest || !token || (match?.[2] && !attachmentDigest)) return notFound();
      try {
        const tokenHash = createHash("sha256").update(token).digest();
        if (tokenLimit.take(tokenHash.toString("hex"),30) !== null) return notFound();
        const recipient = await store.recipient(digest, tokenHash, Math.floor(Date.now()/1000));
        if (!recipient || !proof || !await proof.verify(context.req.raw, recipient, signal) || signal.aborted) return notFound();
        if (!match?.[2] && !acceptsBody(context.req.header("Accept"))) return problem(406, "Not Acceptable");
        const body = attachmentDigest ? await store.retrieveAttachment?.(digest,attachmentDigest,tokenHash,Math.floor(Date.now()/1000))??null : await store.retrieve(digest, tokenHash, Math.floor(Date.now() / 1000));
        if (body === null) return notFound();
        if (body === "missing-body") return problem(503, "Service Unavailable", { "Retry-After": "30" });
        return new Response(Uint8Array.from(body.bytes), {
          status: 200,
          headers: {
            "Content-Type": attachmentDigest?"application/octet-stream":BODY_MEDIA_TYPE,
            "X-Content-Type-Options":"nosniff",
            "Content-Length": String(body.bytes.length),
            "Cache-Control": "private, no-store",
            "Content-Digest": `sha-256=:${Buffer.from(attachmentDigest??digest).toString("base64")}:`,
          },
        });
      } catch {
        // Only the store's authenticated unavailable result may disclose a 503.
        return notFound();
      }
    }, false, clientAddress(context.req.raw));
    return result.kind === "detailed" ? result.value : result.kind === "busy"
      ? problem(429, "Too Many Requests", {"Retry-After":"10"}) : problem(404, "Not Found");
  });
  app.all("/hail/bodies", () => problem(404, "Not Found"));
}
