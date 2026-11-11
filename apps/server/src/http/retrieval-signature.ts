import {randomBytes} from "node:crypto";
import {parseDictionary, serializeDictionary, serializeInnerList} from "structured-headers";

export const RETRIEVAL_SIGNATURE_LIFETIME = 60;
export const RETRIEVAL_CLOCK_SKEW = 30;
const components = ['@method', '@target-uri', 'authorization'];
const kidPattern = /^did:plc:[a-z2-7]{24}#hail-messaging$/;

function base(request: Request, parameters: string, target = request.url): Uint8Array {
  return new TextEncoder().encode(`"@method": ${request.method}\n"@target-uri": ${target}\n"authorization": ${request.headers.get('authorization')}\n"@signature-params": ${parameters}`);
}

/** RFC 9421 Ed25519 over the signature base, not COSE or an application digest. */
export async function signRetrievalRequest(request: Request, recipient: string, key: CryptoKey,
  now = Math.floor(Date.now()/1000), nonce = randomBytes(32).toString('base64url')): Promise<Request> {
  const kid = `${recipient}#hail-messaging`;
  if (request.method !== 'GET' || !kidPattern.test(kid) || !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !Number.isSafeInteger(now) || now < 0 || Buffer.from(nonce,"base64url").toString("base64url") !== nonce || !/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') ?? ''))
    throw new Error('Invalid retrieval signing input');
  const parameters = `("@method" "@target-uri" "authorization");created=${now};expires=${now+RETRIEVAL_SIGNATURE_LIFETIME};nonce="${nonce}";keyid="${kid}";alg="ed25519";tag="hail-retrieval-v1"`;
  const signature = await crypto.subtle.sign('Ed25519', key, Uint8Array.from(base(request, parameters)));
  const headers = new Headers(request.headers);
  headers.set('Signature-Input', `hail=${parameters}`);
  headers.set('Signature', `hail=:${Buffer.from(signature).toString('base64')}:`);
  return new Request(request, {headers});
}

export function parseRetrievalSignature(request: Request, recipient: string, target: string,
  now = Math.floor(Date.now()/1000)) {
  const input = request.headers.get('signature-input'), signature = request.headers.get('signature');
  if (!input || !signature || input.length > 1024 || signature.length > 128 || request.method !== 'GET') return null;
  try {
    const inputs = parseDictionary(input), signatures = parseDictionary(signature);
    // A deliberately canonical, single-signature profile. Equality also rejects
    // duplicate dictionary keys/parameters silently overwritten by SF parsers.
    if (inputs.size !== 1 || signatures.size !== 1 || serializeDictionary(inputs) !== input || serializeDictionary(signatures) !== signature) return null;
    const entry = inputs.get('hail'), sig = signatures.get('hail');
    if (!entry || !sig || !Array.isArray(entry[0]) || entry[0].length !== components.length ||
      entry[0].some((item, i) => item[0] !== components[i] || item[1].size !== 0) ||
      !(sig[0] instanceof ArrayBuffer) || sig[0].byteLength !== 64 || sig[1].size !== 0) return null;
    const params = entry[1], created = params.get('created'), expires = params.get('expires'), nonce = params.get('nonce');
    if (params.size !== 6 || params.get('alg') !== 'ed25519' || params.get('tag') !== 'hail-retrieval-v1' ||
      params.get('keyid') !== `${recipient}#hail-messaging` || !kidPattern.test(String(params.get('keyid'))) ||
      typeof created !== 'number' || !Number.isSafeInteger(created) || typeof expires !== 'number' || !Number.isSafeInteger(expires) ||
      created < 0 || expires !== created+RETRIEVAL_SIGNATURE_LIFETIME || created > now+RETRIEVAL_CLOCK_SKEW ||
      now > expires+RETRIEVAL_CLOCK_SKEW || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
      Buffer.from(nonce,'base64url').toString('base64url') !== nonce) return null;
    return {bytes: base(request, serializeInnerList(entry as Parameters<typeof serializeInnerList>[0]), target),
      signature: new Uint8Array(sig[0]), nonce, retainUntil: expires+RETRIEVAL_CLOCK_SKEW};
  } catch {return null;}
}
