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

export function makeClient(config: CliConfig): ApiClient {
  const base = config.api_base.replace(/\/$/, "");
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
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
