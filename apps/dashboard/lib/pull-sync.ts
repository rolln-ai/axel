import "server-only";
import {
  resolveIngestBaseUrl,
  sanitizeConnectorDiagnosticForStorage,
  tryAcquirePullSourceLock,
  type PullSourceLockClient,
} from "@axel/shared";
import {
  chargebeeApiBaseUrl,
  runPullSync,
  sanitizePullRunSummaryForStorage,
} from "@axel/pull-connectors";
import { decryptCredentialBlob, pullSourceCredentialAad, type CredentialBlob } from "./credentials";
import { db } from "./db";
import { buildDbPullConnector, isDbPullType } from "./pull-db-connectors";
import { safeDashboardFetch } from "./safe-egress";
import { prefixedId } from "./ids";

type PullSourceType =
  | "chargebee"
  | "stripe"
  | "shopify"
  | "postgres"
  | "mongodb"
  | "bigquery";
type PullStreamName =
  | "customers"
  | "subscriptions"
  | "invoices"
  | "payment_intents"
  | "orders"
  | "products";

interface PullCursor {
  value: string | number | null;
}

interface PullStreamState {
  cursor: PullCursor | null;
  /** In-flight pageset resume token — mirrors @axel/pull-connectors
   *  PullStreamState so the dashboard "Sync now" path persists/reads it instead
   *  of dropping it (which left a stale token poisoning the next worker tick). */
  resumePageCursor?: string | null;
  /** Highest cursor observed while resumePageCursor is in flight. */
  pendingHighWatermark?: PullCursor | null;
  updated_at: string;
}

interface PullSourceState {
  streams: Record<string, PullStreamState>;
}

interface PullSource<TConfig = unknown> {
  source_id: string;
  workspace_id: string;
  type: PullSourceType;
  name: string;
  config: TConfig;
  credentials_ref?: string | null;
}

interface PullRecord {
  source_id: string;
  workspace_id: string;
  source_type: PullSourceType;
  stream: string;
  record_id: string;
  cursor: PullCursor | null;
  extracted_at: string;
  data: unknown;
}

interface PullRecordSink {
  write(record: PullRecord): Promise<void>;
}

interface PullRunSummary {
  source_id: string;
  source_type: PullSourceType;
  started_at: string;
  finished_at: string;
  streams: Array<{
    stream: string;
    records: number;
    pages: number;
    cursor: PullCursor | null;
    status: "success" | "partial" | "failed";
    error?: string;
  }>;
}

interface PullStateStore {
  get(sourceId: string): Promise<PullSourceState | null>;
  setStreamState(sourceId: string, streamName: string, state: PullStreamState): Promise<void>;
}

interface PullSourceRow {
  id: string;
  workspace_id: string;
  name: string;
  type: PullSourceType;
  config: Record<string, unknown>;
  credentials_ref: string | null;
  status: "active" | "disabled";
  ingest_status: "active" | "disabled" | null;
}

interface PullCredentialRow extends CredentialBlob {
  workspace_id: string;
  pull_source_id: string;
}

export async function runDashboardPullSync(input: {
  sourceId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<PullRunSummary> {
  const pool = db();
  const rowResult = await pool.query<PullSourceRow>(
    `SELECT ps.id, ps.workspace_id, ps.name, ps.type, ps.config,
            ps.credentials_ref, ps.status, ingest_source.status AS ingest_status
       FROM pull_sources ps
       LEFT JOIN sources ingest_source
         ON ingest_source.id = ps.id
        AND ingest_source.workspace_id = ps.workspace_id
      WHERE ps.id = $1 AND ps.workspace_id = $2
      LIMIT 1`,
    [input.sourceId, input.workspaceId],
  );
  const row = rowResult.rows[0];
  if (!row) throw new Error("pull_source_not_found");
  if (row.status !== "active") throw new Error("pull_source_disabled");
  if (row.ingest_status !== "active") throw new Error("pull_ingest_source_unavailable");

  const lease = await tryAcquirePullSourceLock(pool, row.id);
  if (!lease) throw new Error("pull_sync_already_running");
  try {
    return await runLockedDashboardPullSync(input, row, lease.client);
  } finally {
    try {
      await lease.release();
    } catch (err) {
      console.error(
        `[pull-sync] failed to release source lock ${row.id}: ${safePullDiagnostic(err)}`,
      );
    }
  }
}

async function runLockedDashboardPullSync(
  input: { sourceId: string; workspaceId: string; actorUserId: string },
  row: PullSourceRow,
  pool: PullSourceLockClient,
): Promise<PullRunSummary> {
  const source = await sourceFromRow(row, pool);
  const runId = prefixedId("psr");
  const now = () => new Date();
  await pool.query(
    `INSERT INTO pull_sync_runs (id, pull_source_id, workspace_id, status, started_at)
     VALUES ($1, $2, $3, 'running', $4)`,
    [runId, row.id, row.workspace_id, now().toISOString()],
  );

  try {
    const stateStore = new DashboardPullStateStore(pool);
    const sink = new DashboardHttpIngestSink({
      ingestBaseUrl: resolveIngestBaseUrl(process.env),
      token: requireString(source.config.ingest_token, "pull source credential is missing ingest_token"),
    });
    const maxPagesPerStream = Number.parseInt(process.env.DASHBOARD_PULL_SYNC_MAX_PAGES ?? "5", 10);
    // DB pulls (postgres/mongodb/bigquery) run through the real
    // @axel/pull-connectors connectors. The inline runGenericSync/readPage
    // path only implements the SaaS HTTP APIs (chargebee/stripe/shopify) and
    // throws pull_sync_dispatch_error for DB types — so manual "Sync now" for
    // a database source was always failing before this dispatch was added.
    let summary: PullRunSummary;
    if (isDbPullType(source.type)) {
      // Build the DB connector once so we can close it afterwards. Each connector
      // caches a per-source pg.Pool / MongoClient that holds connections open;
      // without an explicit close() the dashboard "Sync now" path leaked that
      // pool on every run (the worker poll loop already closes it — this mirrors
      // that). close() runs in finally so a failed sync still releases it.
      const connector = buildDbPullConnector(source.type);
      try {
        summary = await runPullSync(
          { source, connector, stateStore, sink },
          { now, maxPagesPerStream },
        );
      } finally {
        try {
          await connector.close?.();
        } catch (closeErr) {
          console.error(
            `[pull-sync] connector close failed for ${source.source_id}: ${safePullDiagnostic(closeErr)}`,
          );
        }
      }
    } else {
      summary = await runGenericSync({ source, stateStore, sink, now, maxPagesPerStream });
    }
    const records = summary.streams.reduce((sum, stream) => sum + stream.records, 0);
    const failedStream = summary.streams.find((stream) => stream.status === "failed");
    const partialStream = summary.streams.find((stream) => stream.status === "partial");
    const runStatus = failedStream ? "failed" : partialStream ? "partial" : "success";
    await pool.query(
      `UPDATE pull_sync_runs
          SET status = $2,
              finished_at = $3,
              records_emitted = $4,
              error_message = $5,
              summary = $6
        WHERE id = $1`,
      [
        runId,
        runStatus,
        now().toISOString(),
        records,
        failedStream?.error
          ? safePullDiagnostic(failedStream.error)
          : partialStream?.error
            ? safePullDiagnostic(partialStream.error)
            : null,
        JSON.stringify({
          ...sanitizePullRunSummaryForStorage(summary),
          triggered_by: "dashboard",
          actor_user_id: input.actorUserId,
        }),
      ],
    );
    if (failedStream) throw new Error(failedStream.error ?? "Sync failed.");
    return summary;
  } catch (err) {
    await pool.query(
      `UPDATE pull_sync_runs
          SET status = 'failed',
              finished_at = $2,
              error_message = $3
        WHERE id = $1 AND status = 'running'`,
      [runId, now().toISOString(), safePullDiagnostic(err)],
    );
    throw err;
  }
}

async function sourceFromRow(
  row: PullSourceRow,
  pool: Pick<PullSourceLockClient, "query"> = db(),
): Promise<PullSource<Record<string, unknown>>> {
  const credentials = await fetchCredentials(
    row.credentials_ref,
    row.workspace_id,
    row.id,
    pool,
  );
  return {
    source_id: row.id,
    workspace_id: row.workspace_id,
    type: row.type,
    name: row.name,
    config: { ...row.config, ...credentials },
    credentials_ref: row.credentials_ref,
  };
}

async function fetchCredentials(
  credentialsRef: string | null,
  workspaceId: string,
  pullSourceId: string,
  pool: Pick<PullSourceLockClient, "query"> = db(),
): Promise<Record<string, unknown>> {
  if (!credentialsRef) return {};
  const result = await pool.query<PullCredentialRow>(
    `SELECT ciphertext, nonce, auth_tag, encryption_version, workspace_id, pull_source_id
       FROM pull_source_credentials
      WHERE id = $1
        AND workspace_id = $2
        AND pull_source_id = $3
      LIMIT 1`,
    [credentialsRef, workspaceId, pullSourceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("pull_credential_not_found");
  // v2 creds require their (workspace, source) AAD; v1 ignore it.
  return JSON.parse(
    await decryptCredentialBlob(row, pullSourceCredentialAad(workspaceId, pullSourceId)),
  ) as Record<string, unknown>;
}

class DashboardPullStateStore implements PullStateStore {
  constructor(private readonly pool: Pick<PullSourceLockClient, "query">) {}

  async get(sourceId: string): Promise<PullSourceState | null> {
    const result = await this.pool.query<{
      stream: string;
      cursor: unknown;
      resume_page_cursor: string | null;
      pending_high_watermark: unknown;
      updated_at: string;
    }>(
      `SELECT stream, cursor, resume_page_cursor, pending_high_watermark, updated_at::text
         FROM pull_source_stream_state
        WHERE pull_source_id = $1`,
      [sourceId],
    );
    if (result.rows.length === 0) return null;
    const streams: PullSourceState["streams"] = {};
    for (const row of result.rows) {
      streams[row.stream] = {
        cursor: isCursor(row.cursor) ? row.cursor : null,
        // Surface the in-flight pageset token so an interrupted sync (and the
        // shared worker runner, which reads this same row) resumes pagination
        // instead of restarting — restarting re-emits duplicates and, for
        // descending streams, skips older never-fetched pages.
        resumePageCursor: row.resume_page_cursor ?? null,
        pendingHighWatermark: isCursor(row.pending_high_watermark)
          ? row.pending_high_watermark
          : null,
        updated_at: row.updated_at,
      };
    }
    return { streams };
  }

  async setStreamState(sourceId: string, streamName: string, state: PullStreamState): Promise<void> {
    await this.pool.query(
      `INSERT INTO pull_source_stream_state
         (pull_source_id, stream, cursor, resume_page_cursor, pending_high_watermark, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pull_source_id, stream)
       DO UPDATE SET cursor = EXCLUDED.cursor,
                     resume_page_cursor = EXCLUDED.resume_page_cursor,
                     pending_high_watermark = EXCLUDED.pending_high_watermark,
                     updated_at = EXCLUDED.updated_at`,
      // Persisting resume_page_cursor (and clearing it to NULL on a clean drain)
      // keeps the dashboard "Sync now" path from leaving a stale page token that
      // would poison the next worker tick.
      [
        sourceId,
        streamName,
        JSON.stringify(state.cursor),
        state.resumePageCursor ?? null,
        JSON.stringify(state.pendingHighWatermark ?? null),
        state.updated_at,
      ],
    );
  }
}

class DashboardHttpIngestSink implements PullRecordSink {
  constructor(private readonly deps: { ingestBaseUrl: string; token: string }) {}

  async write(record: PullRecord): Promise<void> {
    const url = `${this.deps.ingestBaseUrl.replace(/\/$/, "")}/in/${encodeURIComponent(record.source_id)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axel-token": this.deps.token,
        "x-axel-pull-source-type": record.source_type,
        "x-axel-pull-stream": record.stream,
      },
      body: JSON.stringify(record),
      cache: "no-store",
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Ingest rejected pull record: HTTP ${response.status}`);
    }
  }
}

async function runGenericSync(input: {
  source: PullSource<Record<string, unknown>>;
  stateStore: PullStateStore;
  sink: PullRecordSink;
  now: () => Date;
  maxPagesPerStream: number;
}): Promise<PullRunSummary> {
  const startedAt = input.now().toISOString();
  const persistedState = await input.stateStore.get(input.source.source_id);
  const summaries: PullRunSummary["streams"] = [];
  for (const stream of selectedStreams(input.source.type, input.source.config)) {
    try {
      const summary = await runGenericStream({
        ...input,
        stream,
        state: persistedState?.streams[stream] ?? null,
      });
      summaries.push(summary);
    } catch (err) {
      summaries.push({
        stream: sanitizeConnectorDiagnosticForStorage(stream, 160) || "pull_stream",
        records: 0,
        pages: 0,
        cursor: persistedState?.streams[stream]?.cursor ?? null,
        status: "failed",
        error: safePullDiagnostic(err),
      });
    }
  }
  return {
    source_id: input.source.source_id,
    source_type: input.source.type,
    started_at: startedAt,
    finished_at: input.now().toISOString(),
    streams: summaries,
  };
}

async function runGenericStream(input: {
  source: PullSource<Record<string, unknown>>;
  stateStore: PullStateStore;
  sink: PullRecordSink;
  now: () => Date;
  maxPagesPerStream: number;
  stream: PullStreamName;
  state: PullStreamState | null;
}): Promise<PullRunSummary["streams"][number]> {
  // The committed cursor floor stays pinned at the run's base until the stream
  // fully drains; resume an interrupted pageset from the persisted page token.
  const baseCursor = input.state?.cursor ?? null;
  let pageCursor: string | undefined = input.state?.resumePageCursor ?? undefined;
  let highWatermark = maxCursor(baseCursor, input.state?.pendingHighWatermark ?? null);
  let pages = 0;
  let records = 0;
  let drained = false;

  while (pages < input.maxPagesPerStream) {
    const page = await readPage(input.source, input.stream, baseCursor, pageCursor);
    pages += 1;
    for (const data of page.entries) {
      const cursor = cursorFrom(data, cursorField(input.source.type));
      highWatermark = maxCursor(highWatermark, cursor);
      await input.sink.write({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: input.source.type,
        stream: input.stream,
        record_id: recordId(data),
        cursor,
        extracted_at: input.now().toISOString(),
        data,
      });
      records += 1;
    }
    // Per-page checkpoint: pin the committed cursor at the run's base and persist
    // the resume token so a mid-stream failure resumes HERE rather than
    // restarting (restart re-emits duplicates; advancing per-page would skip
    // older pages on descending streams).
    if (!page.nextCursor) {
      drained = true;
      break;
    }
    await input.stateStore.setStreamState(input.source.source_id, input.stream, {
      cursor: baseCursor,
      resumePageCursor: page.nextCursor,
      pendingHighWatermark: highWatermark,
      updated_at: input.now().toISOString(),
    });
    pageCursor = page.nextCursor;
  }

  if (!drained) {
    // Reaching the manual-sync page cap is a resumable pause, not a completed
    // stream. The per-page checkpoint above retains the next page token while
    // keeping the committed cursor pinned at baseCursor; finalizing here would
    // clear that token and silently discard every unread page.
    return {
      stream: input.stream,
      records,
      pages,
      cursor: baseCursor,
      status: "partial",
      error: "max_pages_per_stream_reached",
    };
  }

  // Fully drained — now it is safe to advance the committed cursor to the
  // high-watermark and clear the resume token.
  const nextState: PullStreamState = {
    cursor: highWatermark,
    resumePageCursor: null,
    pendingHighWatermark: null,
    updated_at: input.now().toISOString(),
  };
  await input.stateStore.setStreamState(input.source.source_id, input.stream, nextState);
  return { stream: input.stream, records, pages, cursor: nextState.cursor, status: "success" };
}

async function readPage(
  source: PullSource<Record<string, unknown>>,
  stream: PullStreamName,
  cursor: PullCursor | null,
  pageCursor: string | undefined,
): Promise<{ entries: Record<string, unknown>[]; nextCursor?: string }> {
  if (source.type === "chargebee") {
    const response = await safeDashboardFetch(chargebeeStreamUrl(source.config, stream, cursor, pageCursor), {
      headers: {
        accept: "application/json",
        authorization: basicAuthHeader(requireString(source.config.api_key, "Chargebee api_key is required.")),
      },
      cache: "no-store",
      // Chargebee API calls do not need redirects. Keeping them manual prevents
      // the runtime from replaying the Basic credential to a Location target.
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(chargebeeErrorMessage(response.status));
    }
    const body = await parsePullJson<{
      list?: Array<Record<string, unknown>>;
      next_offset?: string;
    }>(response, "Chargebee");
    return {
      entries: (body.list ?? []).map((entry) => entry[chargebeeResourceKey(stream)] ?? entry) as Record<string, unknown>[],
      ...(body.next_offset ? { nextCursor: body.next_offset } : {}),
    };
  }
  if (source.type === "stripe") {
    const response = await safeDashboardFetch(stripeStreamUrl(source.config, stream, cursor, pageCursor), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${requireString(source.config.api_key, "Stripe api_key is required.")}`,
      },
      cache: "no-store",
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Stripe connection failed with HTTP ${response.status}.`);
    }
    const body = await parsePullJson<{
      data?: Array<Record<string, unknown>>;
      has_more?: boolean;
    }>(response, "Stripe");
    const last = body.data?.[body.data.length - 1];
    const lastId = last && typeof last.id === "string" ? last.id : undefined;
    return {
      entries: body.data ?? [],
      ...(body.has_more && lastId ? { nextCursor: lastId } : {}),
    };
  }

  // Defensive guard: readPage only handles SaaS HTTP pulls (chargebee/stripe/
  // shopify). DB pulls (postgres/mongodb/bigquery) run through a separate
  // connector path and must never reach here. Without this guard, any other
  // type silently fell through to the Shopify branch below and threw the
  // misleading "Shopify shop is required." — which is exactly how a MongoDB
  // source's first sync surfaced a Shopify error. Fail loudly and accurately
  // instead so the real dispatch bug is diagnosable.
  if (source.type !== "shopify") {
    throw new Error(
      `pull_sync_dispatch_error: readPage has no SaaS fetcher for source type "${source.type}" ` +
        "(DB pulls must not reach readPage — check the SaaS-vs-DB connector dispatch).",
    );
  }
  // SSRF guard: the Link-header pageCursor is attacker-controllable (Shopify's
  // response can be poisoned by a MITM / compromised upstream). We attach the
  // shop access token to this request, so before dialing we MUST confirm the
  // cursor still points at the source's own myshopify.com host — otherwise a
  // crafted Link header exfiltrates the token to an arbitrary URL (audit).
  const shopHost = shopifyShopHost(source.config);
  const targetUrl = pageCursor ?? shopifyStreamUrl(source.config, stream, cursor);
  if (pageCursor) assertSameShopifyHost(targetUrl, shopHost);
  const response = await safeDashboardFetch(targetUrl, {
    headers: {
      accept: "application/json",
      "x-shopify-access-token": requireString(source.config.access_token, "Shopify access_token is required."),
    },
    cache: "no-store",
    redirect: "manual",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Shopify connection failed with HTTP ${response.status}.`);
  }
  const body = await parsePullJson<Record<string, unknown[] | undefined>>(response, "Shopify");
  return {
    entries: (body[stream] ?? []) as Record<string, unknown>[],
    ...(nextLink(response.headers.get("link")) ? { nextCursor: nextLink(response.headers.get("link")) } : {}),
  };
}

function chargebeeListUrl(site: string, domain: string | undefined, stream: string, limit: number): string {
  const url = new URL(`/api/v2/${stream}`, chargebeeApiBaseUrl(site, domain));
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function chargebeeStreamUrl(
  config: Record<string, unknown>,
  stream: PullStreamName,
  cursor: PullCursor | null,
  offset?: string,
): string {
  const site = requireString(config.site, "Chargebee site is required.");
  const domain = typeof config.domain === "string" ? config.domain : undefined;
  const url = new URL(chargebeeListUrl(site, domain, stream, pageSize(config.page_size)));
  url.searchParams.set("sort_by[asc]", "updated_at");
  if (cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set("updated_at[after]", String(afterCursorValue(cursor.value)));
  }
  if (offset) url.searchParams.set("offset", offset);
  return url.toString();
}

function stripeStreamUrl(
  config: Record<string, unknown>,
  stream: PullStreamName,
  cursor: PullCursor | null,
  startingAfter?: string,
): string {
  const url = new URL(`/v1/${stream}`, "https://api.stripe.com");
  url.searchParams.set("limit", String(pageSize(config.page_size)));
  if (cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set("created[gt]", String(afterCursorValue(cursor.value)));
  }
  if (startingAfter) url.searchParams.set("starting_after", startingAfter);
  return url.toString();
}

function shopifyStreamUrl(config: Record<string, unknown>, stream: PullStreamName, cursor: PullCursor | null): string {
  const shop = shopifyShopHost(config);
  const version = typeof config.api_version === "string" ? config.api_version : "2026-04";
  const url = new URL(`/admin/api/${version}/${stream}.json`, `https://${shop}`);
  url.searchParams.set("limit", String(shopifyPageSize(config.page_size)));
  if (cursor?.value !== null && cursor?.value !== undefined) {
    url.searchParams.set("updated_at_min", afterIsoCursor(cursor.value));
  }
  return url.toString();
}

/**
 * Normalise + validate the configured Shopify shop to a bare myshopify.com
 * hostname. Mirrors the pull-connectors shopify connector's shopBaseUrl check.
 * Used both to build the first-page URL and as the expected host for the
 * pagination SSRF guard below.
 */
function shopifyShopHost(config: Record<string, unknown>): string {
  const shop = requireString(config.shop, "Shopify shop is required.")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("Shopify shop must be a myshopify.com hostname.");
  }
  return shop;
}

/**
 * Reject a paginated Shopify URL whose host isn't the source's own shop. The
 * Link-header `next` URL is untrusted; we only follow it with the access token
 * if it stays on https://<shop>.myshopify.com — defeating token exfiltration
 * via a poisoned Link header.
 */
function assertSameShopifyHost(rawUrl: string, expectedHost: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Shopify pagination cursor is not a valid URL.");
  }
  if (parsed.protocol !== "https:" || parsed.host.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error(
      `Shopify pagination cursor host "${parsed.host}" does not match the source shop "${expectedHost}".`,
    );
  }
}

function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function afterIsoCursor(value: string | number): string {
  // Exact (inclusive) watermark, not +1s — the +1s skipped records sharing the
  // watermark's whole-second updated_at; re-fetched boundary rows dedup on the
  // deterministic pull event_id. (Mirror of the connector's afterIsoCursor.)
  if (typeof value === "number") return new Date(value).toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

function afterCursorValue(value: string | number): string | number {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : value;
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function chargebeeErrorMessage(status: number): string {
  if (status === 401 || status === 403) return `Chargebee rejected the API key (${status}).`;
  if (status === 404) return `Chargebee site was not found (${status}). Check the site prefix.`;
  return `Chargebee connection failed with HTTP ${status}.`;
}

async function parsePullJson<T>(
  response: { json(): Promise<unknown> },
  provider: string,
): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    // Response.json() SyntaxErrors can include an excerpt of the invalid body.
    throw new Error(`${provider} returned invalid JSON.`);
  }
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function selectedStreams(type: PullSourceType, config: Record<string, unknown>): PullStreamName[] {
  const configured = Array.isArray(config.streams) ? config.streams : [];
  const names = configured
    .filter((stream) => stream && typeof stream === "object" && (stream as { selected?: unknown }).selected !== false)
    .map((stream) => (stream as { name?: unknown }).name)
    .filter((value): value is PullStreamName => isStreamForType(type, value));
  if (names.length > 0) return names;
  if (type === "stripe") return ["customers", "subscriptions", "invoices", "payment_intents"];
  if (type === "shopify") return ["customers", "orders", "products"];
  return ["customers", "subscriptions", "invoices"];
}

function isStreamForType(type: PullSourceType, value: unknown): value is PullStreamName {
  if (type === "stripe") return value === "customers" || value === "subscriptions" || value === "invoices" || value === "payment_intents";
  if (type === "shopify") return value === "customers" || value === "orders" || value === "products";
  return value === "customers" || value === "subscriptions" || value === "invoices";
}

function pageSize(value: unknown): number {
  if (typeof value !== "number") return 100;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function shopifyPageSize(value: unknown): number {
  if (typeof value !== "number") return 250;
  return Math.min(250, Math.max(1, Math.floor(value)));
}

function chargebeeResourceKey(stream: PullStreamName): string {
  if (stream === "customers") return "customer";
  if (stream === "subscriptions") return "subscription";
  return "invoice";
}

function cursorField(type: PullSourceType): string {
  return type === "stripe" ? "created" : "updated_at";
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

function isCursor(value: unknown): value is PullStreamState["cursor"] {
  return value === null
    || !!value
      && typeof value === "object"
      && ("value" in value)
      && (
        typeof (value as { value?: unknown }).value === "string"
        || typeof (value as { value?: unknown }).value === "number"
        || (value as { value?: unknown }).value === null
      );
}

function safePullDiagnostic(value: unknown): string {
  return sanitizeConnectorDiagnosticForStorage(
    value instanceof Error ? value.message : value,
    500,
  ) || "pull_sync_failed";
}
