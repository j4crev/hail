import type { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { accountRequestBytes } from "../accounts/routes.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { EmailBridgeIntake } from "./intake.js";

export const INTAKE_CHECK_PATH = "/email-bridge/v1/intake/check";
export const INTAKE_MESSAGE_PATH = "/email-bridge/v1/intake/messages";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * The ingress contract in spec/email-bridge.md. Any mail edge may call it; the
 * routes know nothing about which one does.
 */
export function registerEmailBridgeIntakeRoutes(app: Hono, intake: EmailBridgeIntake, token: string, maxMessageBytes: number): void {
  const expected = sha256(token);
  const authorized = (header: string | undefined): boolean => {
    const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    // Hashing first makes the comparison independent of the supplied length.
    return supplied !== undefined && timingSafeEqual(sha256(supplied), expected);
  };

  app.all(INTAKE_CHECK_PATH, async context => {
    context.header("Cache-Control", "no-store");
    if (context.req.method !== "POST") return context.json({ error: "Use POST" }, 405);
    if (!authorized(context.req.header("Authorization"))) return context.json({ error: "Intake credential required" }, 401);
    if (context.req.header("Content-Type") !== "application/json") return context.json({ error: "Use JSON" }, 415);
    const bytes = await accountRequestBytes(context.req.raw, 1024);
    let recipient: unknown;
    try { recipient = (parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes ?? undefined)) as { recipient?: unknown }).recipient; }
    catch { recipient = undefined; }
    if (bytes === null || typeof recipient !== "string") return context.json({ error: "Invalid check request" }, 400);
    return context.json({ result: await intake.check(recipient) });
  });

  app.all(INTAKE_MESSAGE_PATH, async context => {
    context.header("Cache-Control", "no-store");
    if (context.req.method !== "POST") return context.json({ error: "Use POST" }, 405);
    if (!authorized(context.req.header("Authorization"))) return context.json({ error: "Intake credential required" }, 401);
    if (context.req.header("Content-Type") !== "message/rfc822" || context.req.header("Content-Encoding") !== undefined) {
      return context.json({ error: "Use an uncoded message/rfc822 body" }, 415);
    }
    const recipient = context.req.header("Bridge-Recipient"), received = context.req.header("Bridge-Received-At");
    const receivedAt = received !== undefined && /^\d{1,12}$/.test(received) ? new Date(Number(received) * 1000) : null;
    if (!recipient || !receivedAt) return context.json({ error: "Recipient and receive time are required" }, 400);
    const raw = await accountRequestBytes(context.req.raw, maxMessageBytes, 60_000);
    if (raw === null) return context.json({ result: "reject" }, 413);
    return context.json({ result: await intake.submit({
      recipient, raw, receivedAt, envelopeSender: context.req.header("Bridge-Envelope-Sender"), sourceAddress: context.req.header("Bridge-Source-Address"),
    }) });
  });
}
