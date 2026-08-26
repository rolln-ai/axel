import {
  assertResolvedHostSafe,
  validateDestinationUrl,
  type DnsLookupAll,
} from "@axel/shared";
import type { FetchLike, FetchResponseLike } from "./index.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}

async function assertUrlSafe(url: string, lookup?: DnsLookupAll): Promise<void> {
  const reason = validateDestinationUrl(url);
  if (reason) throw new UnsafeDestinationError(`ssrf_blocked: ${reason}`);
  if (!lookup) return;
  const resolvedReason = await assertResolvedHostSafe(new URL(url).hostname, lookup);
  if (resolvedReason) throw new UnsafeDestinationError(`ssrf_blocked: ${resolvedReason}`);
}

/**
 * Fetch with browser auto-redirects disabled. Every Location target is resolved
 * against the current URL and passes the same literal/DNS SSRF checks before
 * another socket is opened. This closes the common public-host -> metadata or
 * loopback redirect bypass in both the Node and Workers runtimes.
 */
export async function fetchWithValidatedRedirects(input: {
  fetchImpl: FetchLike;
  url: string;
  init: Parameters<FetchLike>[1];
  lookup?: DnsLookupAll;
}): Promise<FetchResponseLike> {
  let currentUrl = input.url;
  let method = input.init.method;
  let body = input.init.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertUrlSafe(currentUrl, input.lookup);
    const response = await input.fetchImpl(currentUrl, {
      ...input.init,
      method,
      body,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers?.get("location");
    if (!location) return response;
    // A redirect response can carry an unbounded body. Release its stream
    // before validating or following Location so hostile receivers cannot
    // retain connections across redirect chains or rejected redirect targets.
    await response.body?.cancel().catch(() => undefined);
    if (hop === MAX_REDIRECTS) {
      throw new UnsafeDestinationError(`ssrf_blocked: redirect limit exceeded (${MAX_REDIRECTS})`);
    }
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new UnsafeDestinationError("ssrf_blocked: redirect Location is malformed");
    }
    await assertUrlSafe(nextUrl, input.lookup);
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      throw new UnsafeDestinationError(
        "redirect_blocked: cross-origin redirects are not permitted for webhook data",
      );
    }
    // Preserve the configured method and bytes across validated hops. Axel is
    // an event delivery system, so silently converting a POST into a GET would
    // drop the event body and can make a legitimate receiver acknowledge data
    // it never received.
    currentUrl = nextUrl;
  }
  throw new UnsafeDestinationError(`ssrf_blocked: redirect limit exceeded (${MAX_REDIRECTS})`);
}
