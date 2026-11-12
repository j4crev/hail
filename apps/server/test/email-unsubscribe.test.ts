import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { createDkimCheck } from "../src/bridge/dkim.js";
import { validUnsubscribeUrl } from "../src/bridge/unsubscribe.js";
import { SafeHttpsTransport } from "../src/discovery/safe-fetch.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = privateKey.export({ type: "pkcs8", format: "pem" });
const dns = async () => [[`v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`]];
const check = createDkimCheck(dns);
const url = "https://news.example/unsubscribe/secret";
const headers = `From: Editor <editor@news.example>\r\nList-Id: Weekly <weekly.news.example>\r\nList-Unsubscribe: <${url}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`;
async function signed(extra = "", headerList = "from:list-id:list-unsubscribe:list-unsubscribe-post", domain = "news.example") {
  const message = headers + extra + "\r\nHello\r\n";
  const result = await dkimSign(message, { headerList, signatureData: [{ signingDomain: domain, selector: "s", privateKey: key }] });
  return new TextEncoder().encode(result.signatures + message);
}

describe("verified one-click metadata", () => {
  it("accepts both headers only when covered by a passing aligned signature", async () => {
    const result = await check(await signed(), "editor@news.example");
    expect(result.unsubscribe).toMatchObject({ url, listKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await check(await signed("", "from:list-unsubscribe"), "editor@news.example")).unsubscribe).toBeUndefined();
    expect((await check(await signed("", "from:list-unsubscribe-post"), "editor@news.example")).unsubscribe).toBeUndefined();
    expect((await check(await signed("", undefined, "attacker.example"), "editor@news.example")).unsubscribe).toBeUndefined();
  });
  it("rejects duplicate or tampered headers and unsigned messages", async () => {
    expect((await check(await signed(`List-Unsubscribe: <${url}>\r\n`), "editor@news.example")).unsubscribe).toBeUndefined();
    const tampered = Buffer.from(await signed()).toString().replace("/secret>", "/changed>");
    expect((await check(new TextEncoder().encode(tampered), "editor@news.example")).unsubscribe).toBeUndefined();
    expect((await check(new TextEncoder().encode(headers + "\r\nHello"), "editor@news.example")).unsubscribe).toBeUndefined();
  });
  it("groups rotating URLs by signed List-ID, otherwise keeps endpoints distinct", async () => {
    const first = await signed();
    const make = async (list: string) => {
      const message = headers.replace("/secret>", "/new-token>") + "\r\nHello\r\n";
      const result = await dkimSign(message, { headerList: list, signatureData: [{ signingDomain: "news.example", selector: "s", privateKey: key }] });
      return check(new TextEncoder().encode(result.signatures + message), "editor@news.example");
    };
    expect((await make("from:list-id:list-unsubscribe:list-unsubscribe-post")).unsubscribe?.listKey).toBe((await check(first, "editor@news.example")).unsubscribe?.listKey);
    expect((await make("from:list-unsubscribe:list-unsubscribe-post")).unsubscribe?.listKey).not.toBe((await check(await signed("", "from:list-unsubscribe:list-unsubscribe-post"), "editor@news.example")).unsubscribe?.listKey);
  });
  it("refuses credentialed/non-HTTPS/IP/nonstandard-port URLs and private DNS before connecting", async () => {
    for (const value of ["http://news.example/u", "https://user:pass@news.example/u", "https://127.0.0.1/u", "https://[::1]/u", "https://news.example:8443/u", "https://news.example/u#x"])
      expect(validUnsubscribeUrl(value)).toBe(false);
    const safe = new SafeHttpsTransport({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    await expect(safe.fetch(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click" }))).rejects.toThrow("public addresses");
  });
});
