import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { Socket, type LookupFunction, type SocketConnectOpts } from "node:net";
import type { Duplex } from "node:stream";
import { Agent, buildConnector, fetch as undiciFetch, type buildConnector as BuildConnector } from "undici";
import { isPrivateOrUnsafeIp } from "@axel/shared";

export type ResolveAllAddresses = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemResolveAll: ResolveAllAddresses = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * Resolve every address, reject the whole answer set if any address is unsafe,
 * and hand the already-checked IP to the socket. This both covers mixed
 * public/private DNS answers and pins the connection against rebinding.
 */
export function createSafeLookup(resolveAll: ResolveAllAddresses = systemResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAll(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(lookupError(`ssrf_blocked: ${hostname} resolved to no addresses`, "ENOTFOUND"), "", 0);
          return;
        }
        const blocked = addresses.find((entry) => isPrivateOrUnsafeIp(entry.address));
        if (blocked) {
          callback(
            lookupError(
              `ssrf_blocked: ${hostname} resolves to private/link-local/metadata IP (${blocked.address})`,
              "ESSRF",
            ),
            "",
            0,
          );
          return;
        }

        const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
        const eligible = requestedFamily
          ? addresses.filter((entry) => entry.family === requestedFamily)
          : addresses;
        if (eligible.length === 0) {
          callback(
            lookupError(`ssrf_blocked: ${hostname} has no IPv${requestedFamily} address`, "ENOTFOUND"),
            "",
            0,
          );
          return;
        }
        if (options.all) {
          callback(null, eligible.map(({ address, family }) => ({ address, family })));
          return;
        }
        const selected = eligible[0]!;
        callback(null, selected.address, selected.family);
      },
      (error: unknown) => {
        callback(
          error instanceof Error
            ? error
            : lookupError(`ssrf_blocked: ${hostname} could not be resolved`, "ENOTFOUND"),
          "",
          0,
        );
      },
    );
  };
}

export const safeLookup = createSafeLookup();

/**
 * node-postgres calls its stream factory with the connection config. Keep that
 * argument out of the lookup slot, then construct a socket with the pinned
 * lookup hook. The separate helper exists only for deterministic unit tests.
 */
export function createSafePgStream(_pgConfig?: unknown): Duplex {
  return createSafePgStreamForLookup(safeLookup);
}

export function createSafePgStreamForLookup(lookup: LookupFunction): Duplex {
  const socket = new Socket();
  const connect = Socket.prototype.connect as unknown as (
    this: Socket,
    options: SocketConnectOpts,
    listener?: () => void,
  ) => Socket;

  socket.connect = ((
    portOrOptions: number | string | SocketConnectOpts,
    hostOrListener?: string | (() => void),
    listener?: () => void,
  ) => {
    if (typeof portOrOptions === "number") {
      const host = typeof hostOrListener === "string" ? hostOrListener : "localhost";
      const onConnect = typeof hostOrListener === "function" ? hostOrListener : listener;
      if (isPrivateOrUnsafeIp(host)) {
        queueMicrotask(() => {
          socket.destroy(
            lookupError(
              `ssrf_blocked: outbound database socket targets private/link-local/metadata host (${host})`,
              "ESSRF",
            ),
          );
        });
        return socket;
      }
      return connect.call(socket, { port: portOrOptions, host, lookup }, onConnect);
    }
    if (typeof portOrOptions === "string") {
      queueMicrotask(() => {
        socket.destroy(lookupError("ssrf_blocked: local Unix socket destinations are not allowed", "ESSRF"));
      });
      return socket;
    }
    const onConnect = typeof hostOrListener === "function" ? hostOrListener : listener;
    if ("path" in portOrOptions) {
      queueMicrotask(() => {
        socket.destroy(lookupError("ssrf_blocked: local Unix socket destinations are not allowed", "ESSRF"));
      });
      return socket;
    }
    if (portOrOptions.host && isPrivateOrUnsafeIp(portOrOptions.host)) {
      queueMicrotask(() => {
        socket.destroy(
          lookupError(
            `ssrf_blocked: outbound database socket targets private/link-local/metadata host (${portOrOptions.host})`,
            "ESSRF",
          ),
        );
      });
      return socket;
    }
    return connect.call(socket, { ...portOrOptions, lookup }, onConnect);
  }) as typeof socket.connect;

  return socket;
}

export function unsafeRemoteAddressReason(address: string | undefined): string | null {
  if (!address) return "ssrf_blocked: outbound socket has no remote address";
  if (isPrivateOrUnsafeIp(address)) {
    return `ssrf_blocked: outbound socket resolved to private/link-local/metadata IP (${address})`;
  }
  return null;
}

// Pass the safe lookup into Undici's actual socket connector. The
// remoteAddress check below is defense in depth, but on its own it would only
// reject after a TCP/TLS connection had already reached the private service.
// The lookup hook rejects mixed/private DNS answers and pins the checked IP
// before the first socket is opened.
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
      callback(lookupError(reason, "ESSRF"), null);
      return;
    }
    callback(null, socket);
  });
};

const safeDispatcher = new Agent({ connect: safeConnect });

/**
 * Node fetch whose connected socket is checked before Undici writes request
 * headers or body. The dispatcher is reused so normal public destinations keep
 * connection pooling, while every new connection receives the same check.
 */
export async function safeDashboardFetch(
  url: string | URL,
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  try {
    return await undiciFetch(url, { ...init, dispatcher: safeDispatcher });
  } catch (error) {
    // Undici wraps connector failures in `TypeError: fetch failed`. Preserve
    // an SSRF-specific cause so callers and logs retain the useful reason.
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (typeof current !== "object") break;
      const candidate = current as {
        cause?: unknown;
        code?: unknown;
        message?: unknown;
      };
      if (
        candidate.code === "ESSRF" ||
        (typeof candidate.message === "string" &&
          candidate.message.startsWith("ssrf_blocked:"))
      ) {
        throw current;
      }
      current = candidate.cause;
    }
    throw error;
  }
}

export async function closeSafeDashboardDispatcher(): Promise<void> {
  await safeDispatcher.close();
}
