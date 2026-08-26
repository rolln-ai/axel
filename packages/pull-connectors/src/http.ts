export interface HttpResponseLike {
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
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
    const requestInit: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal } = {
      method: "GET",
      headers: init.headers,
    };
    if (init.signal) requestInit.signal = init.signal;
    const response = await fetchImpl(url, requestInit);
    const body = await response.text();
    if (response.status >= 200 && response.status < 300) {
      return parseJson<T>(body);
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    if (!retryable || attempt === maxAttempts) break;

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    await sleep(retryAfter ?? Math.min(30_000, 500 * 2 ** (attempt - 1)));
  }

  throw lastError ?? new Error("HTTP request failed");
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new Error(`invalid JSON response: ${err instanceof Error ? err.message : String(err)}`);
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
