/**
 * Collapse an HTTP destination's wizard auth-mode fields (auth_type,
 * bearer_token, basic_user/password, api_key_header/value, custom_headers)
 * into the `headers` dictionary the HTTP connector spreads onto every request.
 *
 * Lives in @axel/shared so BOTH delivery runtimes apply it identically:
 *   - apps/delivery-service (Node) — the native connector path
 *   - apps/delivery-edge (Cloudflare Worker) — the http/r2/s3/webhook path
 * Previously this only existed in delivery-service, so http destinations
 * delivered from the edge went out with NO auth header (audit critical
 * delivery-http::auth-mode-headers-not-expanded-on-edge).
 *
 * Idempotent on `auth_type === "none"`: the input config flows through
 * unchanged. Header rules that fail validation are SILENTLY DROPPED rather
 * than throwing — the connector still sends the request and the destination
 * rejects it on its own; we log one warning per (name) so operators see the
 * drop without dead-lettering.
 */

import { isSafeHeaderName, isSafeHeaderValue } from "./headers.js";

const warnedHeaders = new Set<string>();

export function buildHttpAuthConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const authType = typeof config.auth_type === "string" ? config.auth_type : "none";
  if (authType === "none") return config;
  const headers: Record<string, string> = {
    ...(typeof config.headers === "object" && config.headers !== null
      ? (config.headers as Record<string, string>)
      : {}),
  };
  function setHeader(name: string, value: string): void {
    if (!isSafeHeaderName(name) || !isSafeHeaderValue(value)) {
      if (!warnedHeaders.has(name)) {
        warnedHeaders.add(name);
        // Fully static message — never interpolate the operator-supplied header
        // name (it's scanner-tainted as sensitive, e.g. api_key_header, and being
        // unsafe it may carry CR/LF that would inject into the log).
        console.warn(
          "[http-auth] dropped an unsafe header from destination config — check the header name(s) for CR/LF or non-token characters",
        );
      }
      return;
    }
    headers[name] = value;
  }
  if (authType === "bearer" && typeof config.bearer_token === "string" && config.bearer_token.length > 0) {
    setHeader("Authorization", `Bearer ${config.bearer_token}`);
  } else if (
    authType === "basic" &&
    typeof config.basic_user === "string" &&
    typeof config.basic_password === "string"
  ) {
    const encoded = base64Encode(`${config.basic_user}:${config.basic_password}`);
    setHeader("Authorization", `Basic ${encoded}`);
  } else if (
    authType === "api_key" &&
    typeof config.api_key_header === "string" &&
    config.api_key_header.length > 0 &&
    typeof config.api_key_value === "string"
  ) {
    setHeader(config.api_key_header, config.api_key_value);
  } else if (authType === "custom_headers" && typeof config.custom_headers === "string") {
    for (const line of config.custom_headers.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (name && value) setHeader(name, value);
    }
  }
  return { ...config, headers };
}

/**
 * UTF-8-safe base64 that works in both the Workers runtime and Node
 * (Buffer is Node-only; btoa over a binary string is universal).
 */
function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
