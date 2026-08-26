import type {
  PullConnector,
  PullCursor,
  PullPage,
  PullReadInput,
  PullRecord,
  PullSource,
  PullStream,
  PullStreamConfig,
} from "./types";
import { fetchJsonWithRetry, type HttpFetch } from "./http";

export type ChargebeeStreamName = "customers" | "subscriptions" | "invoices";

export interface ChargebeeConfig {
  /** Chargebee site subdomain, e.g. "acme-test" for acme-test.chargebee.com. */
  site: string;
  /** Optional region/domain override for EU or custom Chargebee domains. */
  domain?: string;
  streams?: PullStreamConfig[];
  page_size?: number;
}

export interface ChargebeeCredentials {
  api_key: string;
}

export type ChargebeeSource = PullSource<ChargebeeConfig & Partial<ChargebeeCredentials>>;

interface ChargebeeListResponse {
  list: Array<Record<string, unknown>>;
  next_offset?: string;
}

const STREAMS: ChargebeeStreamName[] = ["customers", "subscriptions", "invoices"];

export function createChargebeeConnector(fetchImpl: HttpFetch = globalFetch): PullConnector<ChargebeeConfig & Partial<ChargebeeCredentials>> {
  return {
    type: "chargebee",
    streams() {
      return STREAMS.map((name) => new ChargebeeStream(name, fetchImpl));
    },
  };
}

class ChargebeeStream implements PullStream<ChargebeeConfig & Partial<ChargebeeCredentials>> {
  readonly defaultCursorField = "updated_at";

  constructor(
    readonly name: ChargebeeStreamName,
    private readonly fetchImpl: HttpFetch,
  ) {}

  async read(input: PullReadInput<ChargebeeConfig & Partial<ChargebeeCredentials>>): Promise<PullPage> {
    const url = buildChargebeeListUrl(input.source, this.name, input.stream, input.state?.cursor ?? null, input.pageCursor);
    const request: { headers: Record<string, string>; signal?: AbortSignal } = {
      headers: {
        authorization: basicAuthHeader(requireApiKey(input.source)),
        accept: "application/json",
      },
    };
    if (input.signal) request.signal = input.signal;
    const response = await fetchJsonWithRetry<ChargebeeListResponse>(this.fetchImpl, url, request);

    let highWatermark = input.state?.cursor ?? null;
    const records: PullRecord[] = [];
    for (const entry of response.list ?? []) {
      const data = entry[resourceKey(this.name)] ?? entry;
      const cursor = cursorFrom(data, input.stream.cursor_field ?? this.defaultCursorField);
      highWatermark = maxCursor(highWatermark, cursor);
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "chargebee",
        stream: this.name,
        record_id: recordId(data),
        cursor,
        extracted_at: input.now().toISOString(),
        data,
      });
    }

    const page: PullPage = {
      records,
      highWatermark,
    };
    if (response.next_offset) page.nextCursor = response.next_offset;
    return page;
  }
}

export function buildChargebeeListUrl(
  source: ChargebeeSource,
  stream: ChargebeeStreamName,
  streamConfig: PullStreamConfig,
  cursor: PullCursor | null,
  offset?: string,
): string {
  const pageSize = clampPageSize(source.config.page_size);
  const url = new URL(`/api/v2/${stream}`, baseUrl(source.config));
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("sort_by[asc]", streamConfig.cursor_field ?? "updated_at");
  if (streamConfig.sync_mode !== "full_refresh" && cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set(`${streamConfig.cursor_field ?? "updated_at"}[after]`, String(afterCursorValue(cursor.value)));
  }
  if (offset) url.searchParams.set("offset", offset);
  return url.toString();
}

function afterCursorValue(value: string | number): string | number {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : value;
}

function baseUrl(config: ChargebeeConfig): string {
  const site = config.site.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(site)) {
    throw new Error("Chargebee site must be a bare site name, not a URL");
  }
  const domain = config.domain?.trim() || "chargebee.com";
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) {
    throw new Error("Chargebee domain must be a hostname");
  }
  return `https://${site}.${domain}`;
}

function clampPageSize(value: number | undefined): number {
  if (!value) return 100;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function requireApiKey(source: ChargebeeSource): string {
  const apiKey = source.config.api_key;
  if (!apiKey) throw new Error("Chargebee api_key is required in merged source config");
  return apiKey;
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${base64(`${apiKey}:`)}`;
}

function base64(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  const bufferCtor = (globalThis as { Buffer?: { from(input: string): { toString(encoding: "base64"): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(value).toString("base64");
  throw new Error("No base64 encoder available in this runtime");
}

function resourceKey(stream: ChargebeeStreamName): string {
  if (stream === "customers") return "customer";
  if (stream === "subscriptions") return "subscription";
  return "invoice";
}

function cursorFrom(data: unknown, field: string): PullCursor | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[field];
  if (typeof value === "string" || typeof value === "number") return { value };
  return null;
}

function recordId(data: unknown): string {
  if (data && typeof data === "object") {
    const id = (data as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return `unknown_${Math.random().toString(36).slice(2, 10)}`;
}

function maxCursor(left: PullCursor | null, right: PullCursor | null): PullCursor | null {
  if (!left) return right;
  if (!right) return left;
  const leftNum = Number(left.value);
  const rightNum = Number(right.value);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    return rightNum > leftNum ? right : left;
  }
  return String(right.value) > String(left.value) ? right : left;
}

const globalFetch: HttpFetch = async (url, init) => {
  const response = await fetch(url, init);
  return response;
};
