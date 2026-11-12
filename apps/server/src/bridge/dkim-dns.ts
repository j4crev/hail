import { randomInt } from "node:crypto";
import { getServers } from "node:dns";
import { connect, isIP } from "node:net";
import * as packet from "dns-packet";

const dnsError = (code: string) => Object.assign(new Error(`DKIM DNS lookup failed: ${code}`), { code });
const normalize = (name: string) => name.toLowerCase().replace(/\.$/, "");

function endpoint(server: string): { host: string; port: number } {
  if (isIP(server)) return { host: server, port: 53 };
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(server);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !isIP(host) || port < 1 || port > 65535) throw dnsError("EBADSERVER");
  return { host, port };
}

/** One bounded TCP exchange, using the OS-configured recursive resolver. TCP avoids
 * truncation for large keys; dns-packet preserves TXT character strings per RR. */
function query(server: string, name: string, timeout: number): Promise<packet.DecodedPacket> {
  const id = randomInt(65536);
  const request = packet.encode({ type: "query", id, flags: packet.RECURSION_DESIRED,
    questions: [{ name, type: "TXT", class: "IN" }] });
  const size = Buffer.alloc(2); size.writeUInt16BE(request.length);
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint(server));
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: packet.DecodedPacket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    // A wall-clock deadline, not an idle timeout that a trickling response can reset.
    const timer = setTimeout(() => finish(dnsError("ETIMEOUT")), timeout);
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(dnsError("EBADRESP")));
    socket.on("close", () => finish(dnsError("EBADRESP")));
    socket.on("connect", () => socket.write(Buffer.concat([size, request])));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65537) return finish(dnsError("EBADRESP"));
      if (bytes.length < 2) return;
      const length = bytes.readUInt16BE(0);
      if (bytes.length < length + 2) return;
      try {
        const response = packet.decode(bytes.subarray(2, length + 2));
        const question = response.questions?.[0];
        if (response.id !== id || response.type !== "response" || response.flag_tc || ((response.flags ?? 0) & 0x7800) !== 0 ||
            response.questions?.length !== 1 || question?.type !== "TXT" || question.class !== "IN" || normalize(question.name) !== normalize(name)) {
          throw dnsError("EBADRESP");
        }
        finish(undefined, response);
      } catch { finish(dnsError("EBADRESP")); }
    });
  });
}

/** Bun's resolveTxt flattens the strings in a TXT RR into separate records. Never
 * repair that by joining records: distinct keys must remain distinct. Query TXT
 * on the wire instead, without ANY queries or a hardcoded public DNS service. */
export function createDkimTxtResolver(servers: () => string[] = getServers, timeoutMs = 10_000) {
  return async (domain: string, type: string): Promise<string[][]> => {
    if (type !== "TXT") throw dnsError("ENOTIMP");
    const deadline = Date.now() + timeoutMs;
    const visited = new Set<string>();
    let name = normalize(domain);
    let answers: packet.Answer[] = [];
    for (let hop = 0; hop < 8; hop++) {
      if (visited.has(name)) throw dnsError("EBADRESP");
      visited.add(name);
      if (!answers.some(answer => normalize(answer.name) === name)) {
        let response: packet.DecodedPacket | undefined;
        let failure: unknown = dnsError("ESERVFAIL");
        for (const server of servers().slice(0, 3)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw dnsError("ETIMEOUT");
          try {
            const candidate = await query(server, name, Math.min(2000, remaining));
            const rcode = (candidate.flags ?? 0) & 15;
            if (rcode === 3) throw dnsError("ENOTFOUND");
            if (rcode !== 0) throw dnsError("ESERVFAIL");
            response = candidate;
            break;
          } catch (error) {
            if ((error as { code?: string }).code === "ENOTFOUND") throw error;
            failure = error;
          }
        }
        if (!response) throw failure;
        answers = response.answers ?? [];
      }
      const records = answers.filter(answer => normalize(answer.name) === name && "class" in answer && answer.class === "IN");
      const texts = records.filter((answer): answer is packet.TxtAnswer => answer.type === "TXT");
      if (texts.length) return texts.map(answer => (Array.isArray(answer.data) ? answer.data : [answer.data]).map(chunk => chunk.toString()));
      const aliases = records.filter((answer): answer is packet.StringAnswer => answer.type === "CNAME");
      if (!aliases.length) throw dnsError("ENODATA");
      if (aliases.length !== 1) throw dnsError("EBADRESP");
      name = normalize(aliases[0]!.data);
    }
    throw dnsError("EBADRESP");
  };
}
