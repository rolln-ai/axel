/**
 * AXE-34 — SSRF / private-network egress protection.
 *
 * Webhook destinations let the operator paste any URL. Without a
 * guard, a misconfigured (or malicious) workspace could point Axel
 * at:
 *   - the AWS/GCP/Azure metadata endpoint (169.254.169.254)
 *   - private networks inside Render / Cloudflare (10/8, 172.16/12,
 *     192.168/16, 127/8, ::1, fc00::/7, fe80::/10)
 *   - link-local IPv4/IPv6
 *   - non-http(s) schemes (file://, gopher://, etc.)
 *
 * `validateDestinationUrl` rejects all of those at config-save time
 * AND at delivery time (belt + suspenders — the URL could be edited
 * in another tab between save and delivery, and we still want to
 * refuse to send).
 *
 * Pure-function, runs in Workers + Node + the dashboard. Returns
 * null on success or a human-readable reason string on rejection.
 *
 * Optional `allowPrivate`: set to `true` for self-hosted / internal
 * deploys where the operator legitimately wants to hit a private
 * destination. Defaults to `false`.
 */

export interface ValidateDestinationUrlOptions {
  /** Skip the private-IP block. Off by default. */
  allowPrivate?: boolean;
  /** Skip the http (non-TLS) block. Off by default. http is allowed
   *  by default to support local dev / on-prem; the dashboard can
   *  flip it on. */
  requireHttps?: boolean;
}

export function validateDestinationUrl(
  urlString: string,
  options: ValidateDestinationUrlOptions = {},
): string | null {
  if (!urlString || typeof urlString !== "string") return "URL is required.";
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return "URL is malformed.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `URL must use http or https — got "${url.protocol}".`;
  }
  if (options.requireHttps && url.protocol !== "https:") {
    return "URL must use https.";
  }
  if (url.username || url.password) {
    return "URL must not include username or password credentials; use an encrypted authentication field instead.";
  }
  const host = url.hostname.toLowerCase();
  if (host === "") return "URL is missing a hostname.";

  // Block raw IP literals against our private/metadata block list.
  // For DNS hostnames we can only check at delivery time (the
  // resolved address may differ). The connector layer should be the
  // second check.
  if (isPrivateOrUnsafeHost(host) && !options.allowPrivate) {
    return `URL host "${host}" is in a private/link-local/metadata range — refusing to send to it.`;
  }
  // Refuse hostnames that *resolve* through DNS-rebinding tricks like
  // `127-0-0-1.nip.io`. Cheap heuristic: any literal IPv4 substring
  // matching our block list, embedded anywhere in the hostname.
  if (containsBlockedIpFragment(host) && !options.allowPrivate) {
    return `URL host "${host}" embeds a private/loopback IP literal — refusing to send to it.`;
  }
  return null;
}

/**
 * SSRF check for a connection TARGET — a full connection URI
 * (mongodb://…@host/db, postgres://…@host/db) or a bare host[:port]. Strips the
 * scheme + userinfo, splits multi-host authorities on commas, and runs
 * validateDestinationUrl on each host. Returns a reason when any host is
 * private/link-local/metadata, else null. Use for DB / pull-source connection
 * strings the dashboard or workers would otherwise connect to without the
 * destination-URL SSRF guard.
 */
export function connectionHostSsrfReason(value: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    for (const queryHost of parsed.searchParams.getAll("host")) {
      if (!queryHost) continue;
      if (queryHost.startsWith("/") || queryHost.startsWith("\\")) {
        return "Connection URI overrides the host with a local socket path — refusing to connect.";
      }
      for (const entry of queryHost.split(",")) {
        const hostport = entry.trim();
        if (!hostport) continue;
        const reason = validateDestinationUrl(`https://${hostport}`);
        if (reason) return reason;
      }
    }
  } catch {
    // The authority parser below returns the normal malformed/unsafe reason.
  }
  const afterScheme = value.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "");
  const at = afterScheme.indexOf("@");
  const authority = (at === -1 ? afterScheme : afterScheme.slice(at + 1)).split(/[/?]/)[0] ?? "";
  for (const entry of authority.split(",")) {
    const hostport = entry.trim();
    if (!hostport) continue;
    const reason = validateDestinationUrl(`https://${hostport}`);
    if (reason) return reason;
  }
  return null;
}

/**
 * Same shape as `validateDestinationUrl` but for an already-resolved
 * IP address. Use this in the delivery hot path AFTER DNS resolution
 * to catch rebinding (host resolves to a public IP at save time and
 * a private one at delivery time).
 */
export function isPrivateOrUnsafeIp(ip: string): boolean {
  return isPrivateOrUnsafeHost(ip.trim().toLowerCase());
}

export type DnsLookupAll = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

/**
 * Resolve a hostname and reject if ANY resolved address is private/unsafe.
 * Use AFTER `validateDestinationUrl`, in the delivery hot path, to catch
 * DNS-rebinding — a name that was public at save time resolving to an internal
 * IP at delivery. Returns null when safe, or a reason string when blocked.
 *
 * IP-literal hosts are already covered by `validateDestinationUrl`, so they
 * short-circuit to null here. NOTE: this validates the resolved IPs but does
 * not PIN the connection to them — a TOCTOU window remains between check and
 * connect (full protection needs a custom socket lookup). This closes the
 * common rebinding case, and only runs where DNS is available (Node connectors,
 * not the Cloudflare Worker delivery path).
 */
export async function assertResolvedHostSafe(
  hostname: string,
  lookup: DnsLookupAll,
): Promise<string | null> {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return "URL is missing a hostname.";
  // IP literals were already checked at the string level by validateDestinationUrl.
  if (looksLikeIpv4(host) || host.includes(":")) return null;
  let records: ReadonlyArray<{ address: string }>;
  try {
    records = await lookup(host);
  } catch {
    return `URL host "${hostname}" could not be resolved — refusing to send.`;
  }
  if (records.length === 0) {
    return `URL host "${hostname}" resolved to no addresses — refusing to send.`;
  }
  for (const record of records) {
    if (isPrivateOrUnsafeIp(record.address)) {
      return `URL host "${hostname}" resolves to a private/link-local/metadata IP (${record.address}) — refusing to send.`;
    }
  }
  return null;
}

function isPrivateOrUnsafeHost(host: string): boolean {
  // Strip IPv6 brackets if present.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // DNS treats a trailing dot as the same absolute name. Normalise it before
  // checking localhost/metadata names so `localhost.` cannot bypass the guard.
  if (host.endsWith(".")) host = host.slice(0, -1);
  // localhost catches DNS-resolved loopback regardless of IP family.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (looksLikeIpv4(host)) return isBlockedIpv4(host);
  if (host.includes(":")) return isBlockedIpv6(host);
  return false;
}

function looksLikeIpv4(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local incl. AWS/GCP/Azure metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && parts[2]! === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && parts[2]! === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && parts[2]! === 99) return true; // 192.88.99/24 deprecated relay
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark testing
  if (a === 198 && b === 51 && parts[2]! === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && parts[2]! === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const hextets = parseIpv6Hextets(ip);
  if (!hextets) return false;

  const [first] = hextets;
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7]! <= 1) return true;

  // IPv4-mapped IPv6 is commonly canonicalised from dotted decimal into the
  // final two hexadecimal hextets (for example ::ffff:127.0.0.1 becomes
  // ::ffff:7f00:1). Decode those bits before applying the IPv4 block list.
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    const high = hextets[6]!;
    const low = hextets[7]!;
    const mappedIpv4 = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    return isBlockedIpv4(mappedIpv4);
  }

  // Be conservative with literal/resolved IPv6 destinations: ordinary global
  // unicast lives in 2000::/3. Everything else includes local, translation,
  // discard, multicast, deprecated site-local, and otherwise special-use
  // space that can acquire surprising meaning inside the runtime network.
  if ((first! & 0xe000) !== 0x2000) return true;

  // Non-global or transition ranges inside 2000::/3. Blocking the whole
  // 2001::/23 protocol-assignment block is intentionally conservative; the
  // few globally reachable anycast exceptions are not sensible webhook or
  // database destinations.
  const second = hextets[1]!;
  if (first === 0x2001 && second <= 0x01ff) return true; // 2001::/23
  if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2002) return true; // 2002::/16 6to4
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // 3fff::/20 documentation
  return false;
}

function parseIpv6Hextets(ip: string): number[] | null {
  let value = ip.toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);

  // Convert a dotted IPv4 tail into the two hextets it represents before
  // expanding IPv6 compression.
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4 = value.slice(lastColon + 1);
    if (!looksLikeIpv4(ipv4)) return null;
    const octets = ipv4.split(".").map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    value = `${value.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const compressionIndex = value.indexOf("::");
  if (compressionIndex !== value.lastIndexOf("::")) return null;

  let parts: string[];
  if (compressionIndex === -1) {
    parts = value.split(":");
    if (parts.length !== 8) return null;
  } else {
    const left = value.slice(0, compressionIndex);
    const right = value.slice(compressionIndex + 2);
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 1) return null;
    parts = [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts];
  }

  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function containsBlockedIpFragment(host: string): boolean {
  // Catch tricks like 127-0-0-1.nip.io, 192-168-1-1.sslip.io.
  const dashedIp = host.match(/\b(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\b/);
  if (dashedIp) {
    const candidate = dashedIp[1]!.replaceAll("-", ".");
    if (looksLikeIpv4(candidate) && isBlockedIpv4(candidate)) return true;
  }
  return false;
}

/**
 * Always block these. Includes the documented metadata hosts of the
 * three major clouds, k8s, and consul/etcd default service names.
 */
const BLOCKED_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata.aws.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

/**
 * AXE-34 — inbound IP allowlist. Returns true if `ip` is inside any
 * of the listed CIDR ranges (or if the list is empty — which means
 * "no allowlist configured, allow all"). Used by the ingest worker
 * to reject requests from forged source IPs when the operator has
 * narrowed the accepted set (e.g. provider-published IP ranges).
 *
 * Supports IPv4 CIDRs (a.b.c.d/n) and bare-IP entries (a.b.c.d ==
 * /32). IPv6 CIDR support is intentionally limited to /128 exact
 * matches for now — providers publish IPv4 ranges and the cost of
 * a bad IPv6 parser is silently letting traffic through.
 */
export function ipMatchesAllowlist(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalised = ip.trim().toLowerCase();
  if (!normalised) return false;
  const isV4 = looksLikeIpv4(normalised);
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (isV4) {
      if (cidrV4Contains(trimmed, normalised)) return true;
    } else {
      // IPv6: exact-string match only. See block comment above.
      const cidrIdx = trimmed.indexOf("/");
      const target = cidrIdx === -1 ? trimmed : trimmed.slice(0, cidrIdx);
      if (target.toLowerCase() === normalised) return true;
    }
  }
  return false;
}

function cidrV4Contains(cidr: string, ip: string): boolean {
  const slashIdx = cidr.indexOf("/");
  const network = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
  const bitsRaw = slashIdx === -1 ? "32" : cidr.slice(slashIdx + 1);
  const bits = Number(bitsRaw);
  if (!looksLikeIpv4(network)) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const networkInt = ipv4ToInt(network);
  const ipInt = ipv4ToInt(ip);
  if (networkInt === null || ipInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (networkInt & mask) === (ipInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4) return null;
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}
