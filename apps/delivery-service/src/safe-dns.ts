import { lookup as dnsLookup } from "node:dns/promises";
import { Socket, type LookupFunction, type SocketConnectOpts } from "node:net";
import type { Duplex } from "node:stream";
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
 * Node lookup hook that rejects the entire answer set if any address is not
 * globally routable, then returns an already-checked IP to the socket. Passing
 * the IP back through the lookup callback pins that connection and removes the
 * validation-to-connect DNS race.
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
        socket.destroy(
          lookupError("ssrf_blocked: local Unix socket destinations are not allowed", "ESSRF"),
        );
      });
      return socket;
    }
    const onConnect = typeof hostOrListener === "function" ? hostOrListener : listener;
    if ("path" in portOrOptions) {
      queueMicrotask(() => {
        socket.destroy(
          lookupError("ssrf_blocked: local Unix socket destinations are not allowed", "ESSRF"),
        );
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
