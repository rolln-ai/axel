export interface HttpResponseLike {
  status: number;
  headers: {
    get(name: string): string | null;
  };
  body?: {
    cancel(): Promise<void>;
  } | null;
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "manual";
  },
) => Promise<HttpResponseLike>;

export async function fetchJsonWithRetry<T>(
  fetchImpl: HttpFetch,
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const requestInit: Parameters<HttpFetch>[1] = {
      method: "GET",
      headers: init.headers,
      // Pull credentials must never be replayed by the runtime to an
      // unvalidated Location target.
      redirect: "manual",
    };
    if (init.signal) requestInit.signal = init.signal;
    const response = await fetchImpl(url, requestInit);
    if (response.status >= 200 && response.status < 300) {
      return parseJson<T>(await response.text());
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    // API error bodies are upstream-controlled and often echo request data or
    // credentials. Never carry them into a runner summary, pull_sync_runs, log,
    // Sentry event, or dashboard error. The status is enough to classify retry
    // behavior; cancel the unused stream so the connection can be reclaimed.
    await response.body?.cancel().catch(() => undefined);
    lastError = new Error(`HTTP ${response.status}`);
    if (!retryable || attempt === maxAttempts) break;

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    await sleep(retryAfter ?? Math.min(30_000, 500 * 2 ** (attempt - 1)));
  }

  throw lastError ?? new Error("HTTP request failed");
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    // Some runtimes include a slice of the invalid input in SyntaxError.message.
    // Keep upstream bytes out of every diagnostic boundary.
    throw new Error("invalid JSON response");
  }
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
