const SAFE_ENDPOINT_PATH = /^\/[a-z0-9][a-z0-9/_-]{0,255}$/;

function invalidUrl(): never {
  throw new Error("internal_service_url_invalid");
}

function parseHttpsUrl(raw: string): URL {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidUrl();
  }
  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
  ) {
    return invalidUrl();
  }
  return url;
}

function requireEndpointPath(path: string): void {
  if (!SAFE_ENDPOINT_PATH.test(path) || path.includes("//") || path.includes("..")) {
    throw new Error("internal_service_endpoint_invalid");
  }
}

/** Resolve a fixed internal path from a credential-safe HTTPS origin. */
export function resolveInternalServiceEndpoint(baseUrl: string, path: string): string {
  requireEndpointPath(path);
  const url = parseHttpsUrl(baseUrl);
  if (url.pathname !== "/") invalidUrl();
  return `${url.origin}${path}`;
}

/** Validate an optional full endpoint override without permitting path drift. */
export function validateInternalServiceEndpoint(endpointUrl: string, path: string): string {
  requireEndpointPath(path);
  const url = parseHttpsUrl(endpointUrl);
  if (url.pathname !== path) invalidUrl();
  return url.href;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider stream errors are replaced with a fixed local failure below.
  }
}

/** Parse JSON without allowing an internal endpoint to exhaust Worker memory. */
export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8 * 1024 * 1024) {
    throw new Error("internal_service_response_limit_invalid");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maximumBytes) {
      await cancelResponse(response);
      throw new Error("internal_service_response_too_large");
    }
  }
  if (!response.body) throw new Error("internal_service_response_invalid");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("internal_service_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message === "internal_service_response_too_large") {
      throw error;
    }
    throw new Error("internal_service_response_read_failed");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("internal_service_response_invalid");
  }
}
