import { extractEventTypeFromBody, QUEUE_SPILL_KEY_PREFIX, redactJsonPayload } from "@axel/shared";
import type { QueueMessage, Source, WorkspacePlanState } from "@axel/shared";
import type { PlanCache } from "./plan-cache.js";
import type { SourceCache } from "./source-cache.js";

/**
 * Admin endpoint surface for the ingest worker.
 *
 * Routes:
 *   POST /admin/source-cache/invalidate   — drop an entry by source_id
 *   POST /admin/source-cache/put          — write a fresh source config
 *   POST /admin/workspace-payloads/delete-batch — delete one native R2 page
 *   POST /admin/trigger-event             — synthesize a webhook event for a
 *                                            source as if it had arrived via
 *                                            the public /in/<source_id> path.
 *                                            Used by the AXE-26 CLI's `axel
 *                                            trigger` command (and the
 *                                            dashboard's "send test event").
 *
 * The dashboard uses `put` on createSource / setSourceStatus / rotateSourceToken
 * so that sources created in the control plane immediately become resolvable
 * at the edge — without us having to give the worker a Postgres client.
 *
 * Auth: a single shared admin token (env `ADMIN_TOKEN`) compared in
 * constant time. This is a service-to-service interface, not a customer
 * one. Cloudflare Access in front of `/admin/*` would be the production
 * hardening path.
 */

export interface AdminContext {
  cache: SourceCache | null;
  adminToken: string | undefined;
}

export interface InvalidatePayload {
  source_id?: unknown;
}

export interface PutPayload {
  source_id?: unknown;
  source?: unknown;
  /** Optional override TTL in seconds; defaults to 1 year (KV max). */
  ttl_seconds?: unknown;
}

function isSource(value: unknown): value is Source {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // AXE-23 — provider/signing_secret are optional but if present must
  // match the supported set so the worker never tries to dispatch an
  // unknown provider verifier.
  const providerOk =
    v.provider === undefined
    || v.provider === "custom"
    || v.provider === "stripe"
    || v.provider === "github"
    || v.provider === "shopify"
    || v.provider === "chargebee";
  const signingSecretOk =
    (v.signing_secret === undefined || typeof v.signing_secret === "string")
    && (v.signing_secret_previous === undefined || typeof v.signing_secret_previous === "string");
  const redactPathsOk =
    v.redact_paths === undefined
    || (Array.isArray(v.redact_paths) && v.redact_paths.every((p) => typeof p === "string"));
  return (
    typeof v.source_id === "string"
    && typeof v.workspace_id === "string"
    && typeof v.name === "string"
    && typeof v.secret_token === "string"
    && (v.status === "active" || v.status === "disabled")
    && providerOk
    && signingSecretOk
    && redactPathsOk
  );
}

export async function handleSourceCachePut(
  request: Request,
  ctx: AdminContext,
): Promise<Response> {
  const authError = checkAdminAuth(request, ctx);
  if (authError) return authError;
  if (!ctx.cache) return new Response(null, { status: 204 });

  let body: PutPayload;
  try {
    body = (await request.json()) as PutPayload;
  } catch {
    return adminJson({ error: "invalid_json" }, 400);
  }

  const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
  if (!sourceId) return adminJson({ error: "missing_source_id" }, 400);
  if (!isSource(body.source)) return adminJson({ error: "invalid_source_shape" }, 400);
  // The body must agree with itself — ID in the source matches ID in the path.
  if (body.source.source_id !== sourceId) {
    return adminJson({ error: "source_id_mismatch" }, 400);
  }

  // KV TTL is set on write, never refreshed by reads. With no Postgres
  // fallback in `lookupSourceUncached`, a TTL'd entry means the source 404s
  // until something in the dashboard re-PUTs it (createSource /
  // setSourceStatus / rotateSourceToken). 1 year is KV's max — anything
  // shorter risks live sources going dark on quiet weekends.
  const ttl = typeof body.ttl_seconds === "number" && body.ttl_seconds > 0
    ? Math.floor(body.ttl_seconds)
    : 31_536_000;
  await ctx.cache.put(sourceId, { kind: "hit", source: body.source }, ttl);
  return new Response(null, { status: 204 });
}

export interface WorkspacePlanPutPayload {
  workspace_id?: unknown;
  state?: unknown;
  /** Optional override TTL in seconds; defaults to 300 (5 min). */
  ttl_seconds?: unknown;
}

function isWorkspacePlanState(value: unknown): value is WorkspacePlanState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspace_id === "string"
    && (v.plan === "free" || v.plan === "pro" || v.plan === "enterprise")
    && (v.gate === "accept" || v.gate === "reject_quota" || v.gate === "reject_suspended")
    && typeof v.computed_at === "string"
  );
}

export interface WorkspacePlanPutContext {
  planCache: PlanCache | null;
  adminToken: string | undefined;
}

export async function handleWorkspacePlanPut(
  request: Request,
  ctx: WorkspacePlanPutContext,
): Promise<Response> {
  const authError = checkAdminAuth(request, { cache: null, adminToken: ctx.adminToken });
  if (authError) return authError;
  if (!ctx.planCache) return new Response(null, { status: 204 });

  let body: WorkspacePlanPutPayload;
  try {
    body = (await request.json()) as WorkspacePlanPutPayload;
  } catch {
    return adminJson({ error: "invalid_json" }, 400);
  }

  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  if (!workspaceId) return adminJson({ error: "missing_workspace_id" }, 400);
  if (!isWorkspacePlanState(body.state)) return adminJson({ error: "invalid_state_shape" }, 400);
  if (body.state.workspace_id !== workspaceId) {
    return adminJson({ error: "workspace_id_mismatch" }, 400);
  }

  // Default 5 min — the dashboard re-pushes after every hourly
  // rollup + every Stripe webhook, so this TTL is the safety net,
  // not the primary refresh mechanism.
  const ttl = typeof body.ttl_seconds === "number" && body.ttl_seconds > 0
    ? Math.floor(body.ttl_seconds)
    : 300;
  await ctx.planCache.put(workspaceId, body.state, ttl);
  return new Response(null, { status: 204 });
}

export async function handleSourceCacheInvalidate(
  request: Request,
  ctx: AdminContext,
): Promise<Response> {
  const authError = checkAdminAuth(request, ctx);
  if (authError) return authError;
  if (!ctx.cache) return new Response(null, { status: 204 });

  let body: InvalidatePayload;
  try {
    body = (await request.json()) as InvalidatePayload;
  } catch {
    return adminJson({ error: "invalid_json" }, 400);
  }

  const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
  if (!sourceId) {
    return adminJson({ error: "missing_source_id" }, 400);
  }

  await ctx.cache.invalidate(sourceId);
  return new Response(null, { status: 204 });
}

/**
 * Trigger-event payload for `POST /admin/trigger-event`.
 *
 * The worker mints a synthetic event and runs it through the same
 * R2-write + queue-enqueue path the public /in/<source_id> endpoint
 * uses, but skips the customer-facing checks (token, signature, rate
 * limit) since admin-token auth is enough. `is_test` is forced true so
 * downstream consumers can render these events distinctly from
 * production traffic.
 */
export interface TriggerEventPayload {
  source_id?: unknown;
  /** Inline JSON body — serialised to bytes server-side. */
  body?: unknown;
  /** Optional headers to capture alongside the event. */
  headers?: Record<string, string>;
  content_type?: unknown;
  /** Marker the caller can populate (e.g. "cli" or "dashboard"). */
  actor_kind?: unknown;
}

export interface TriggerEventDeps {
  cache: { get(sourceId: string): Promise<{ kind: "hit"; source: Source } | { kind: "miss" } | undefined> } | null;
  adminToken: string | undefined;
  /** R2 bucket for raw payload storage. */
  rawPayloads: R2Bucket;
  /**
   * Resolves a queue binding for a shard index. We re-use the same
   * `queueForShard` helper the public ingest path uses so admin-triggered
   * events land in exactly the same queue partition.
   */
  queueForShard: (shard: number) => Queue<unknown>;
  /** Generates a UUIDv7 — provided so tests can inject a deterministic id. */
  uuid: () => string;
  /** Computes the shard index from an event id (re-uses shared helper). */
  shardFor: (eventId: string) => number;
  /**
   * Execution context so erasure indexing runs after the 202 (mirrors the
   * public path's `ctx.waitUntil`). Optional: when absent (e.g. in tests) the
   * indexing is awaited inline instead.
   */
  ctx?: { waitUntil(promise: Promise<unknown>): void };
  /**
   * GDPR erasure indexer, injected from index.ts (which owns `env`). Called
   * with the ORIGINAL pre-redaction body so the derived subject_ids match the
   * public path byte-for-byte. Optional + best-effort: must never throw.
   */
  indexSubjects?: (args: {
    source: Source;
    rawBody: Uint8Array;
    headers: Record<string, string>;
    query: Record<string, string>;
    eventId: string;
    r2Key: string;
    receivedAt: string;
  }) => Promise<void>;
  /**
   * ClickHouse `events` insert, injected from index.ts (which owns `env`).
   * The public /in/<id> path logs every accepted event to ClickHouse via
   * `logEventToClickhouse`; without the same insert here, triggered/seeded
   * events never get an `events` row, so they are invisible to every
   * FROM-events surface (usage analytics, the event inspector, and all the
   * Data Contract samplers) regardless of the event_type stamp on the queue
   * message. Best-effort + fire-and-forget: must never block or fail the 202
   * (the underlying helper already swallows ClickHouse failures).
   */
  logEvent?: (message: QueueMessage) => Promise<void>;
}

export async function handleTriggerEvent(
  request: Request,
  deps: TriggerEventDeps,
): Promise<Response> {
  const authError = checkAdminAuth(request, { cache: null, adminToken: deps.adminToken });
  if (authError) return authError;

  let payload: TriggerEventPayload;
  try {
    payload = (await request.json()) as TriggerEventPayload;
  } catch {
    return adminJson({ error: "invalid_json" }, 400);
  }

  const sourceId = typeof payload.source_id === "string" ? payload.source_id.trim() : "";
  if (!sourceId) return adminJson({ error: "missing_source_id" }, 400);

  // Resolve source from cache only — the admin endpoint shouldn't have
  // its own Postgres handle, and the dashboard always pushes a source
  // to the cache as part of createSource. If the cache has nothing
  // for this id, the operator hasn't created the source yet (or the
  // KV TTL expired without a refresh).
  if (!deps.cache) return adminJson({ error: "cache_not_configured" }, 503);
  const cached = await deps.cache.get(sourceId);
  if (!cached || cached.kind === "miss") {
    return adminJson({ error: "unknown_source" }, 404);
  }
  const source = cached.source;
  if (source.status !== "active") {
    return adminJson({ error: "source_disabled" }, 403);
  }

  const contentType =
    typeof payload.content_type === "string" && payload.content_type.length > 0
      ? payload.content_type
      : (payload.headers?.["content-type"] ?? "application/json");
  const bodyText = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? {});
  const bodyBytes = new TextEncoder().encode(bodyText);

  // PII redaction — mask configured paths BEFORE the durable R2 write, exactly
  // as the public /in/<id> path does (index.ts). Test events are fanned out to
  // real destinations, so an unredacted store here would both persist and
  // deliver PII the source asked us to mask. No-op without redact_paths; the
  // raw bytes are still used for subject extraction below (subject_id is a hash).
  const storedBody =
    source.redact_paths && source.redact_paths.length > 0
      ? redactJsonPayload(bodyBytes, source.redact_paths)
      : bodyBytes;

  const eventId = deps.uuid();
  const receivedAt = new Date().toISOString();
  const r2Key = `events/${source.workspace_id}/${receivedAt.slice(0, 10)}/${eventId}`;

  await deps.rawPayloads.put(r2Key, storedBody, {
    httpMetadata: { contentType },
    customMetadata: {
      event_id: eventId,
      workspace_id: source.workspace_id,
      source_id: source.source_id,
      received_at: receivedAt,
      is_test: "true",
      actor_kind: typeof payload.actor_kind === "string" ? payload.actor_kind : "admin",
    },
  });

  const headers: Record<string, string> = {
    "x-axel-test": "1",
    "content-type": contentType,
    ...(payload.headers ?? {}),
  };
  // Stamp the event type the SAME way the public /in/<id> path does (index.ts):
  // derive it from the ORIGINAL body bytes + headers, and only include the
  // field when one was found so the message stays byte-identical to baseline
  // for untyped sources. Without this, triggered/test events all land in the
  // untyped '' bucket and are invisible to Data Contract type discovery.
  const eventType = extractEventTypeFromBody(bodyBytes, headers);
  const message: QueueMessage = {
    event_id: eventId,
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    r2_key: r2Key,
    received_at: receivedAt,
    content_type: contentType,
    size_bytes: storedBody.byteLength,
    shard: deps.shardFor(eventId),
    headers,
    query: {} as Record<string, string>,
    is_test: true,
    ...(eventType ? { event_type: eventType } : {}),
  };
  await deps.queueForShard(message.shard).send(message);

  // ClickHouse analytics/event-index row — SAME insert the public /in/<id>
  // path fires after its durable R2 + queue writes. Every sampler and
  // inspection surface reads `FROM events`, so skipping this made triggered/
  // seeded events invisible to Data Contract type discovery no matter how the
  // queue message was stamped. Fire-and-forget after the durable writes.
  if (deps.logEvent) {
    const logging = deps.logEvent(message);
    if (deps.ctx) deps.ctx.waitUntil(logging);
    else await logging.catch(() => undefined);
  }

  // GDPR erasure index — derive subject_ids from the ORIGINAL body so an
  // erasure request can later locate this (durably-stored) test event, exactly
  // as the public path does via ctx.waitUntil. No-op for sources without
  // subject_key_paths. Best-effort: never block or fail the 202.
  if (deps.indexSubjects) {
    const indexing = deps.indexSubjects({
      source,
      rawBody: bodyBytes,
      headers,
      query: {},
      eventId,
      r2Key,
      receivedAt,
    });
    if (deps.ctx) deps.ctx.waitUntil(indexing);
    else await indexing.catch(() => undefined);
  }

  return adminJson({ event_id: eventId, received_at: receivedAt, source_id: source.source_id }, 202);
}

export interface WorkspacePayloadDeleteBatchContext {
  adminToken: string | undefined;
  rawPayloads: R2Bucket;
}

const WORKSPACE_PAYLOAD_LIST_PAGES = 6;
const WORKSPACE_PAYLOAD_DELETE_CONCURRENCY = 2;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCanonicalDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!;
}

/**
 * Delete one strongly-consistent R2 listing page for a deleting workspace.
 *
 * The dashboard cannot use Cloudflare's object REST API one key at a time for
 * million-event workspaces within a serverless timeout. The ingest Worker
 * already owns the native R2 binding, whose array delete removes one listing
 * page in one operation. We collect a small fixed number of stable cursor
 * pages before deleting, then remove two pages at a time. Each successful call
 * durably shrinks the prefix, so a later cron resumes from bucket state.
 */
export async function handleWorkspacePayloadDeleteBatch(
  request: Request,
  ctx: WorkspacePayloadDeleteBatchContext,
): Promise<Response> {
  const authError = checkAdminAuth(request, { cache: null, adminToken: ctx.adminToken });
  if (authError) return authError;

  let body: {
    workspace_id?: unknown;
    confirmation?: unknown;
    day?: unknown;
    extra_prefixes?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return adminJson({ error: "invalid_json" }, 400);
  }

  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    return adminJson({ error: "invalid_workspace_id" }, 400);
  }
  if (body.confirmation !== `delete:${workspaceId}`) {
    return adminJson({ error: "invalid_confirmation" }, 400);
  }
  const day = body.day === undefined ? undefined : body.day;
  if (day !== undefined && !isCanonicalDay(day)) {
    return adminJson({ error: "invalid_day" }, 400);
  }

  // Caller-supplied custom r2-destination prefixes (full teardown only). Each
  // MUST be workspace-scoped (`<segments>/<thisWorkspaceId>/`) so a compromised
  // caller cannot delete another workspace's data through this endpoint.
  const extraPrefixes: string[] = [];
  if (day === undefined && body.extra_prefixes !== undefined) {
    if (!Array.isArray(body.extra_prefixes)) {
      return adminJson({ error: "invalid_extra_prefixes" }, 400);
    }
    const scoped = new RegExp(`^[A-Za-z0-9._/-]+/${escapeRegExp(workspaceId)}/$`);
    for (const p of body.extra_prefixes) {
      if (typeof p !== "string" || !scoped.test(p)) {
        return adminJson({ error: "invalid_extra_prefixes" }, 400);
      }
      extraPrefixes.push(p);
    }
  }

  // A day-scoped delete targets one event-payload partition. A full teardown
  // (no day) must also sweep the other R2 families keyed by workspace so a
  // deleted workspace leaves nothing behind: oversized-message spills, the
  // default r2-destination mirror prefix, and any custom r2 `key_prefix`es the
  // dashboard enumerated and passed as `extra_prefixes`.
  const prefixes =
    day === undefined
      ? [
          ...new Set([
            `events/${workspaceId}/`,
            `${QUEUE_SPILL_KEY_PREFIX}/${workspaceId}/`,
            `deliveries/${workspaceId}/`,
            ...extraPrefixes,
          ]),
        ]
      : [`events/${workspaceId}/${day}/`];

  let deleted = 0;
  let complete = true;
  for (const prefix of prefixes) {
    const swept = await sweepWorkspacePrefix(ctx, prefix);
    deleted += swept.deleted;
    // The caller re-invokes until every prefix reports complete; an incomplete
    // prefix leaves `complete` false so the next tick resumes from bucket state.
    if (!swept.complete) complete = false;
  }

  return adminJson(
    {
      workspace_id: workspaceId,
      ...(day === undefined ? {} : { day }),
      deleted,
      complete,
    },
    200,
  );
}

/**
 * Delete up to WORKSPACE_PAYLOAD_LIST_PAGES listing pages of a single prefix.
 * Returns `complete: true` only when the final collected listing was not
 * truncated — R2's strong consistency makes an empty/short final page a safe
 * "prefix drained" signal for a disabled/deleting workspace.
 */
async function sweepWorkspacePrefix(
  ctx: WorkspacePayloadDeleteBatchContext,
  prefix: string,
): Promise<{ deleted: number; complete: boolean }> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let pageIndex = 0; pageIndex < WORKSPACE_PAYLOAD_LIST_PAGES; pageIndex += 1) {
    const page = await ctx.rawPayloads.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) pages.push(keys);
    if (!page.truncated) {
      complete = true;
      break;
    }
    if (!page.cursor) throw new Error("r2_list_truncated_without_cursor");
    cursor = page.cursor;
  }

  for (let index = 0; index < pages.length; index += WORKSPACE_PAYLOAD_DELETE_CONCURRENCY) {
    await Promise.all(
      pages
        .slice(index, index + WORKSPACE_PAYLOAD_DELETE_CONCURRENCY)
        .map(async (keys) => await ctx.rawPayloads.delete(keys)),
    );
  }
  const deleted = pages.reduce((total, keys) => total + keys.length, 0);
  return { deleted, complete };
}

function checkAdminAuth(request: Request, ctx: AdminContext): Response | null {
  if (!ctx.adminToken) {
    // No admin token configured = endpoint disabled. 404 not 401 — we don't
    // want to leak that the route exists in deployments without auth set.
    return adminJson({ error: "not_found" }, 404);
  }
  const presented = request.headers.get("x-axel-admin-token");
  if (!presented || !safeEqual(presented, ctx.adminToken)) {
    return adminJson({ error: "unauthorized" }, 401);
  }
  return null;
}

function adminJson(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
