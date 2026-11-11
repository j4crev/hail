import {signRetrievalRequest} from "../../src/http/retrieval-signature.js";
const pair = crypto.subtle.generateKey("Ed25519", true, ["sign","verify"]) as Promise<CryptoKeyPair>;
export const signTestRetrieval = async (request: Request, recipient: string) => signRetrievalRequest(request, recipient, (await pair).privateKey);
