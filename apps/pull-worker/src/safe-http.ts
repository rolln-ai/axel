import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type buildConnector as BuildConnector,
} from "undici";
import type { HttpFetch } from "@axel/pull-connectors";
import { isPrivateOrUnsafeIp } from "@axel/shared";
import { safeLookup } from "./safe-dns.js";

function unsafeRemoteAddressReason(address: string | undefined): string | null {
  if (!address) return "ssrf_blocked: outbound socket has no remote address";
  if (isPrivateOrUnsafeIp(address)) {
    return `ssrf_blocked: outbound socket resolved to private/link-local/metadata IP (${address})`;
  }
  return null;
}

const connect = buildConnector({ lookup: safeLookup });
const safeConnect: BuildConnector.connector = (options, callback) => {
  connect(options, (error, socket) => {
    if (error) {
      callback(error, null);
      return;
    }
    const reason = unsafeRemoteAddressReason(socket.remoteAddress);
    if (reason) {
      socket.destroy();
      callback(Object.assign(new Error(reason), { code: "ESSRF" }), null);
      return;
    }
    callback(null, socket);
  });
};

const safeDispatcher = new Agent({ connect: safeConnect });

/** Node fetch for pull credentials. DNS is checked and pinned before connect. */
export const safePullHttpFetch: HttpFetch = async (url, init) => {
  try {
    return await undiciFetch(url, {
      ...init,
      // Never let Undici replay a credential to a redirect target.
      redirect: "manual",
      dispatcher: safeDispatcher,
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
      const candidate = current as { cause?: unknown; code?: unknown; message?: unknown };
      if (
        candidate.code === "ESSRF"
        || (typeof candidate.message === "string" && candidate.message.startsWith("ssrf_blocked:"))
      ) {
        throw current;
      }
      current = candidate.cause;
    }
    throw error;
  }
};

export async function closeSafePullHttpDispatcher(): Promise<void> {
  await safeDispatcher.close();
}
