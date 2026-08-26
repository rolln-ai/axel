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

export type StripeStreamName = "customers" | "subscriptions" | "invoices" | "payment_intents";

export interface StripeConfig {
  streams?: PullStreamConfig[];
  page_size?: number;
}

export interface StripeCredentials {
  api_key: string;
}

export type StripeSource = PullSource<StripeConfig & Partial<StripeCredentials>>;

interface StripeListResponse {
  data: Array<Record<string, unknown>>;
  has_more?: boolean;
}

const STREAMS: StripeStreamName[] = ["customers", "subscriptions", "invoices", "payment_intents"];

export function createStripeConnector(fetchImpl: HttpFetch = globalFetch): PullConnector<StripeConfig & Partial<StripeCredentials>> {
  return {
    type: "stripe",
    streams() {
      return STREAMS.map((name) => new StripeStream(name, fetchImpl));
    },
  };
}

class StripeStream implements PullStream<StripeConfig & Partial<StripeCredentials>> {
  readonly defaultCursorField = "created";

  constructor(
    readonly name: StripeStreamName,
    private readonly fetchImpl: HttpFetch,
  ) {}

  async read(input: PullReadInput<StripeConfig & Partial<StripeCredentials>>): Promise<PullPage> {
    const url = buildStripeListUrl(input.source, this.name, input.stream, input.state?.cursor ?? null, input.pageCursor);
    const request: { headers: Record<string, string>; signal?: AbortSignal } = {
      headers: {
        authorization: `Bearer ${requireApiKey(input.source)}`,
        accept: "application/json",
      },
    };
    if (input.signal) request.signal = input.signal;
    const response = await fetchJsonWithRetry<StripeListResponse>(this.fetchImpl, url, request);

    let highWatermark = input.state?.cursor ?? null;
    const records: PullRecord[] = [];
    for (const data of response.data ?? []) {
      const cursor = cursorFrom(data, input.stream.cursor_field ?? this.defaultCursorField);
      highWatermark = maxCursor(highWatermark, cursor);
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "stripe",
        stream: this.name,
        record_id: recordId(data),
        cursor,
        extracted_at: input.now().toISOString(),
        data,
      });
    }

    const page: PullPage = { records, highWatermark };
    const last = response.data?.[response.data.length - 1];
    const lastId = last && typeof last.id === "string" ? last.id : null;
    if (response.has_more && lastId) page.nextCursor = lastId;
    return page;
  }
}

export function buildStripeListUrl(
  source: StripeSource,
  stream: StripeStreamName,
  streamConfig: PullStreamConfig,
  cursor: PullCursor | null,
  startingAfter?: string,
): string {
  const url = new URL(`/v1/${stream}`, "https://api.stripe.com");
  url.searchParams.set("limit", String(clampPageSize(source.config.page_size)));
  if (streamConfig.sync_mode !== "full_refresh" && cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set(`created[gt]`, String(afterCursorValue(cursor.value)));
  }
  if (startingAfter) url.searchParams.set("starting_after", startingAfter);
  return url.toString();
}

function afterCursorValue(value: string | number): string | number {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : value;
}

function clampPageSize(value: number | undefined): number {
  if (!value) return 100;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function requireApiKey(source: StripeSource): string {
  const apiKey = source.config.api_key;
  if (!apiKey) throw new Error("Stripe api_key is required in merged source config");
  return apiKey;
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
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return rightNum > leftNum ? right : left;
  return String(right.value) > String(left.value) ? right : left;
}

const globalFetch: HttpFetch = async (url, init) => fetch(url, init);
