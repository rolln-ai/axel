import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { safeLookup } from "./safe-dns.js";

export function createSafeNodeHttpHandler(): NodeHttpHandler {
  return new NodeHttpHandler({
    httpAgent: new HttpAgent({ lookup: safeLookup }),
    httpsAgent: new HttpsAgent({ lookup: safeLookup }),
  });
}
