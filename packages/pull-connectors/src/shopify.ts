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
import { type HttpFetch } from "./http";

export type ShopifyStreamName = "customers" | "orders" | "products";

export interface ShopifyConfig {
  shop: string;
  api_version?: string;
  streams?: PullStreamConfig[];
  page_size?: number;
}

export interface ShopifyCredentials {
  access_token: string;
}

export type ShopifySource = PullSource<ShopifyConfig & Partial<ShopifyCredentials>>;

const STREAMS: ShopifyStreamName[] = ["customers", "orders", "products"];

export function createShopifyConnector(fetchImpl: HttpFetch = globalFetch): PullConnector<ShopifyConfig & Partial<ShopifyCredentials>> {
  return {
    type: "shopify",
    streams() {
      return STREAMS.map((name) => new ShopifyStream(name, fetchImpl));
    },
  };
}

class ShopifyStream implements PullStream<ShopifyConfig & Partial<ShopifyCredentials>> {
  readonly defaultCursorField = "updated_at";

  constructor(
    readonly name: ShopifyStreamName,
    private readonly fetchImpl: HttpFetch,
  ) {}

  async read(input: PullReadInput<ShopifyConfig & Partial<ShopifyCredentials>>): Promise<PullPage> {
    const url = input.pageCursor ?? buildShopifyListUrl(input.source, this.name, input.stream, input.state?.cursor ?? null);
    // SSRF guard: the Link-header pageCursor is attacker-controllable (a poisoned
    // upstream response). We send the shop access token on this request, so only
    // follow the cursor when it stays on the source's own myshopify.com host —
    // otherwise a crafted Link header would exfiltrate the token (audit).
    if (input.pageCursor) assertShopifyHost(input.pageCursor, input.source.config.shop);
    const request: {
      method: "GET";
      headers: Record<string, string>;
      signal?: AbortSignal;
      redirect: "manual";
    } = {
      method: "GET",
      redirect: "manual",
      headers: {
        "x-shopify-access-token": requireAccessToken(input.source),
        accept: "application/json",
      },
    };
    if (input.signal) request.signal = input.signal;
    const response = await this.fetchImpl(url, request);
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    let body: Record<string, unknown[] | undefined>;
    try {
      body = JSON.parse(text) as Record<string, unknown[] | undefined>;
    } catch {
      throw new Error("invalid JSON response");
    }
    const entries = body[this.name] ?? [];

    let highWatermark = input.state?.cursor ?? null;
    const records: PullRecord[] = [];
    for (const data of entries) {
      const cursor = cursorFrom(data, input.stream.cursor_field ?? this.defaultCursorField);
      highWatermark = maxCursor(highWatermark, cursor);
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "shopify",
        stream: this.name,
        record_id: recordId(data),
        cursor,
        extracted_at: input.now().toISOString(),
        data,
      });
    }

    const page: PullPage = { records, highWatermark };
    const next = nextLink(response.headers.get("link"));
    if (next) page.nextCursor = next;
    return page;
  }
}

export function buildShopifyListUrl(
  source: ShopifySource,
  stream: ShopifyStreamName,
  streamConfig: PullStreamConfig,
  cursor: PullCursor | null,
): string {
  const url = new URL(`/admin/api/${apiVersion(source.config)}/${stream}.json`, shopBaseUrl(source.config));
  url.searchParams.set("limit", String(clampPageSize(source.config.page_size)));
  if (streamConfig.sync_mode !== "full_refresh" && cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set("updated_at_min", afterIsoCursor(cursor.value));
  }
  return url.toString();
}

function shopBaseUrl(config: ShopifyConfig): string {
  return `https://${shopHostname(config)}`;
}

function shopHostname(config: ShopifyConfig): string {
  const shop = config.shop.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("Shopify shop must be a myshopify.com hostname");
  }
  return shop;
}

/**
 * Reject a paginated URL whose host isn't the source's own shop. The Link-header
 * `next` cursor is untrusted; we only follow it with the access token attached
 * when it stays on https://<shop>.myshopify.com — defeating token exfiltration
 * via a poisoned Link header.
 */
function assertShopifyHost(rawUrl: string, shop: string): void {
  const expectedHost = shopHostname({ shop } as ShopifyConfig);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Shopify pagination cursor is not a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.host.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error(
      `Shopify pagination cursor host "${parsed.host}" does not match shop "${expectedHost}"`,
    );
  }
}

function apiVersion(config: ShopifyConfig): string {
  return config.api_version?.trim() || "2026-04";
}

function afterIsoCursor(value: string | number): string {
  // Use the EXACT watermark (Shopify's updated_at_min is inclusive), NOT +1s.
  // The +1s skipped every record sharing the watermark's whole-second updated_at
  // that wasn't on the last page (audit: permanent row loss). The boundary
  // records are re-fetched next sync but dedup on the deterministic pull
  // event_id (record_id + cursor), so no skip and no duplicates.
  if (typeof value === "number") return new Date(value).toISOString();
  const time = Date.parse(value);
  if (Number.isFinite(time)) return new Date(time).toISOString();
  return value;
}

function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function clampPageSize(value: number | undefined): number {
  if (!value) return 250;
  return Math.min(250, Math.max(1, Math.floor(value)));
}

function requireAccessToken(source: ShopifySource): string {
  const token = source.config.access_token;
  if (!token) throw new Error("Shopify access_token is required in merged source config");
  return token;
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
  const leftDate = Date.parse(String(left.value));
  const rightDate = Date.parse(String(right.value));
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return rightDate > leftDate ? right : left;
  return String(right.value) > String(left.value) ? right : left;
}

const globalFetch: HttpFetch = async (url, init) => fetch(url, init);
