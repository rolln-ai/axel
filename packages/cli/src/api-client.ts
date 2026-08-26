import type { CliConfig } from "./config.js";

/**
 * Thin HTTP client for the delivery-service `/v1/cli/*` endpoints.
 * All requests carry `Authorization: Bearer <PAT>`. Non-2xx responses
 * throw a `CliApiError` with the HTTP status + decoded `{error,
 * message}` body so commands can render targeted messages.
 */
export class CliApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/**
 * Accept only an HTTPS API origin, with an HTTP exception for exact loopback
 * development hosts. Returning `origin` discards paths and query strings so a
 * saved config cannot redirect authenticated requests away from the API root.
 */
export function normalizeApiBaseUrl(input: string): string {
  const raw = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API base must be a valid absolute URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("API base must not contain embedded credentials");
  }
  // URL.hash is empty for a trailing bare `#`, so inspect the raw URL too.
  if (raw.includes("#")) {
    throw new Error("API base must not contain a URL fragment");
  }

  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("API base must use HTTPS (HTTP is allowed only for localhost, 127.0.0.1, or [::1])");
  }

  return parsed.origin;
}

export function makeClient(config: CliConfig): ApiClient {
  // Validate eagerly: callers may pass legacy or manually edited config, and
  // no bearer request may leave the process until its destination is safe.
  const base = normalizeApiBaseUrl(config.api_base);
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        "user-agent": "axel-cli/0.1.0",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let parsed: unknown = null;
    if (contentType.includes("application/json") && text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // fall through; surface raw text below.
      }
    }
    if (!res.ok) {
      const obj = (parsed && typeof parsed === "object" ? parsed : {}) as {
        error?: string;
        message?: string;
      };
      const code = obj.error ?? `http_${res.status}`;
      const message = obj.message ?? (text.slice(0, 200) || res.statusText);
      throw new CliApiError(res.status, code, message);
    }
    return parsed as T;
  }
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  };
}
