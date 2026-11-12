import { generateKeyPairSync } from "node:crypto";
import { createSocket } from "node:dgram";
import { getServers, setServers } from "node:dns";
import { createServer, type Socket } from "node:net";
import * as packet from "dns-packet";
import { afterEach, describe, expect, it } from "vitest";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { createDkimCheck } from "../src/bridge/dkim.js";
import { createDkimTxtResolver } from "../src/bridge/dkim-dns.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const record = `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
const name = "s._domainkey.sender.example";
const txt = (name: string, chunks: string[]): packet.Answer => ({ name, type: "TXT", class: "IN", ttl: 60, data: chunks.map(chunk => Buffer.from(chunk)) });
const originalServers = getServers();
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { setServers(originalServers); await cleanup?.(); cleanup = undefined; });

// Serve actual DNS packets: mocking resolveTxt would hide Bun's chunk-boundary bug.
async function dnsFixture(answer: (query: packet.DecodedPacket) => Partial<packet.Packet> | null) {
  const sockets = new Set<Socket>();
  const respond = (bytes: Buffer) => {
    const query = packet.decode(bytes);
    const result = answer(query);
    if (!result) return null;
    return packet.encode({ type: "response", id: query.id, flags: packet.RECURSION_AVAILABLE,
      questions: query.questions, ...result });
  };
  const tcp = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 2 || bytes.length < bytes.readUInt16BE(0) + 2) return;
      const response = respond(bytes.subarray(2));
      if (!response) return;
      const size = Buffer.alloc(2); size.writeUInt16BE(response.length);
      // Fragment the TCP framing as well as the TXT record itself.
      socket.write(size.subarray(0, 1));
      setTimeout(() => socket.end(Buffer.concat([size.subarray(1), response])), 1);
    });
  });
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const port = (tcp.address() as { port: number }).port;
  const udp = createSocket("udp4");
  udp.on("message", (message, peer) => { const response = respond(message); if (response) udp.send(response, peer.port, peer.address); });
  await new Promise<void>(resolve => udp.bind(port, "127.0.0.1", resolve));
  cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => tcp.close(() => resolve())), new Promise<void>(resolve => udp.close(() => resolve()))]);
  };
  setServers([`127.0.0.1:${port}`]);
}

async function signedMessage() {
  const message = "From: Editor <editor@sender.example>\r\nSubject: DNS test\r\n\r\nHello\r\n";
  const signed = await dkimSign(message, { signatureData: [{ signingDomain: "sender.example", selector: "s",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
  return Buffer.from(signed.signatures + message);
}

describe("DKIM DNS records", () => {
  it("verifies an aligned signature with a multi-chunk DNS public key", async () => {
    await dnsFixture(() => ({ answers: [txt(name, [record.slice(0, 200), record.slice(200)])] }));
    expect(await createDkimCheck()(await signedMessage(), "editor@sender.example")).toMatchObject({
      authentication: "dkim-aligned", signatures: [{ domain: "sender.example", result: "pass", aligned: true }],
    });
  });

  it("preserves distinct TXT records and ignores unrelated answer owners", async () => {
    await dnsFixture(() => ({ answers: [txt("other.example", ["unrelated"]), txt(name, ["first", " record"]), txt(name, ["second", " record"])] }));
    expect(await createDkimTxtResolver()(name, "TXT")).toEqual([["first", " record"], ["second", " record"]]);
  });

  it("does not reconstruct a public key from separate TXT records", async () => {
    await dnsFixture(() => ({ answers: [txt(name, [record.slice(0, 200)]), txt(name, [record.slice(200)])] }));
    expect(await createDkimCheck()(await signedMessage(), "editor@sender.example")).toMatchObject({
      authentication: "none", signatures: [{ result: "neutral" }],
    });
  });

  it.each([true, false])("follows a CNAME (target included: %s)", async included => {
    const target = "key.mailer.example";
    const queries: string[] = [];
    await dnsFixture(query => {
      const requested = query.questions![0]!.name;
      queries.push(requested);
      expect(query.questions![0]!.type).toBe("TXT");
      return { answers: requested === name
        ? [{ name, type: "CNAME", class: "IN", ttl: 60, data: target }, ...(included ? [txt(target, [record.slice(0, 200), record.slice(200)])] : [])]
        : [txt(target, [record.slice(0, 200), record.slice(200)])] };
    });
    expect(await createDkimCheck()(await signedMessage(), "editor@sender.example")).toMatchObject({ authentication: "dkim-aligned" });
    expect(queries).toEqual(included ? [name] : [name, target]);
  });

  it("rejects CNAME cycles", async () => {
    await dnsFixture(() => ({ answers: [{ name, type: "CNAME", class: "IN", data: name }] }));
    await expect(createDkimTxtResolver()(name, "TXT")).rejects.toMatchObject({ code: "EBADRESP" });
  });

  it.each([
    ["missing name", { flags: 3 }, "ENOTFOUND"],
    ["empty answer", { answers: [] }, "ENODATA"],
    ["server failure", { flags: 2 }, "ESERVFAIL"],
    ["truncated response", { flags: packet.TRUNCATED_RESPONSE }, "EBADRESP"],
    ["wrong question", { questions: [{ name: "other.example", type: "TXT" }] }, "EBADRESP"],
  ] as const)("rejects %s", async (_label, response, code) => {
    await dnsFixture(() => response as Partial<packet.Packet>);
    await expect(createDkimTxtResolver()(name, "TXT")).rejects.toMatchObject({ code });
  });

  it("falls back to another configured resolver after connection failure", async () => {
    const chunks = [record.slice(0, 200), record.slice(200)];
    await dnsFixture(() => ({ answers: [txt(name, chunks)] }));
    const servers = getServers();
    expect(await createDkimTxtResolver(() => ["127.0.0.1:1", ...servers])(name, "TXT")).toEqual([chunks]);
  });

  it("bounds a stalled response and leaves the sender unverified", async () => {
    await dnsFixture(() => null);
    const check = createDkimCheck(createDkimTxtResolver(getServers, 30));
    expect(await check(await signedMessage(), "editor@sender.example")).toMatchObject({
      authentication: "none", signatures: [{ result: "temperror", comment: "DNS failure: ETIMEOUT" }],
    });
  });
});
