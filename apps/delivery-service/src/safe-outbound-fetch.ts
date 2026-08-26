import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type buildConnector as BuildConnector,
} from "undici";
import {
  UnsafeDestinationError,
  type FetchLike,
  type FetchResponseLike,
} from "@axel/connectors";
import { isPrivateOrUnsafeIp } from "@axel/shared";
import { safeLookup } from "./safe-dns.js";

// Validate and pin the DNS answer before opening the socket. The connected
// remote-address check remains defense in depth for literal targets and any
// unexpected connector behavior.
const connect = buildConnector({ lookup: safeLookup });

export function unsafeRemoteAddressReason(address: string | undefined): string | null {
  if (!address) return "ssrf_blocked: outbound socket has no remote address";
  if (isPrivateOrUnsafeIp(address)) {
    return `ssrf_blocked: outbound socket resolved to private/link-local/metadata IP (${address})`;
  }
  return null;
}

const safeConnect: BuildConnector.connector = (options, callback) => {
  connect(options, (error, socket) => {
    if (error) {
      callback(error, null);
      return;
    }
    const reason = unsafeRemoteAddressReason(socket.remoteAddress);
    if (reason) {
      socket.destroy();
      callback(new UnsafeDestinationError(reason), null);
      return;
    }
    callback(null, socket);
  });
};

const dispatcher = new Agent({ connect: safeConnect });

export async function safeNodeFetch(
  url: string,
  init: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  try {
    return await undiciFetch(url, {
      ...init,
      dispatcher,
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
      if (current instanceof UnsafeDestinationError) throw current;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}

/**
 * Node-only fetch adapter that validates the address of the socket Undici
 * actually opened. The connector's DNS preflight remains useful diagnostics;
 * this socket check closes the rebinding window between lookup and connect.
 */
export const safeOutboundFetch: FetchLike = async (url, init) => {
  return await safeNodeFetch(url, init) as unknown as FetchResponseLike;
};

export async function closeSafeOutboundDispatcher(): Promise<void> {
  await dispatcher.close();
}
