import { readBoundedJsonResponse, type Source } from "@axel/shared";
import { lookupSourceFromDeliveryService, type DeliverySourceLookupEnv } from "./source-lookup-http.js";
import { isSourceLookupFailureReason, SourceLookupUnavailableError } from "./source-lookup-error.js";

const STATE_KEY = "source-authority";
const INTERNAL_URL = "https://source-authority.internal/";
const POSITIVE_REFRESH_MS = 5 * 60 * 1_000;
const NEGATIVE_REFRESH_MS = 30 * 1_000;

type AuthorityState =
  | {
      version: 1;
      sourceIdDigest: string;
      status: "fenced";
      fenceToken: string;
      /** Drift fences may be reconciled by the legacy post-commit invalidation route. */
      fenceKind: "mutation" | "drift";
    }
  | {
      version: 1;
      sourceIdDigest: string;
      /** Legacy dashboards cannot supply committed config; resolve retries the origin. */
      status: "refresh_required";
    }
  | {
      version: 1;
      sourceIdDigest: string;
      status: "ready";
      /** SHA-256 of the canonical committed config. Secrets never enter SQLite. */
      sourceFingerprint: string;
      sourcePresent: boolean;
      expiresAt: number;
      authorizationVersion: string;
    };

interface HotSourceConfig {
  source: Source | null;
  sourceFingerprint: string;
  expiresAt: number;
  authorizationVersion: string;
}

type AuthorityOperation =
  | { op: "resolve"; source_id: string }
  | { op: "confirm"; source_id: string; authorization_version: string }
  | { op: "fence"; source_id: string; fence_token: string }
  | { op: "sync"; source_id: string; fence_token: string; source: Source | null }
  | { op: "bootstrap"; source_id: string; source: Source }
  | { op: "legacy_invalidate"; source_id: string };

export interface SourceAuthorityStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface SourceAuthorityNamespaceLike {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SourceAuthorityStubLike;
}

export interface SourceAuthorityEnv extends DeliverySourceLookupEnv {
  SOURCE_AUTHORITY?: SourceAuthorityNamespaceLike;
  /** Hosted profiles set true so a missing binding is an outage, not a silent downgrade. */
  SOURCE_AUTHORITY_REQUIRED?: string;
  DEV_MODE?: string;
}

export interface SourceAuthorityResolution {
  source: Source | null;
  /** Present only when a hosted Durable Object must confirm before the write. */
  authorizationVersion?: string;
}

export function isSource(value: unknown): value is Source {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const providerOk =
    source.provider === undefined
    || source.provider === "custom"
    || source.provider === "stripe"
    || source.provider === "github"
    || source.provider === "shopify"
    || source.provider === "chargebee";
  const signingSecretOk =
    (source.signing_secret === undefined || typeof source.signing_secret === "string")
    && (source.signing_secret_previous === undefined || typeof source.signing_secret_previous === "string");
  const redactPathsOk =
    source.redact_paths === undefined
    || (Array.isArray(source.redact_paths) && source.redact_paths.every((path) => typeof path === "string"));
  const optionalNumber = (entry: unknown) => (
    entry === undefined || (typeof entry === "number" && Number.isFinite(entry))
  );
  const optionalString = (entry: unknown) => entry === undefined || typeof entry === "string";
  const optionalStringArray = (entry: unknown) => (
    entry === undefined
    || (Array.isArray(entry) && entry.every((item) => typeof item === "string"))
  );
  const subjectPathsOk = source.subject_key_paths === undefined
    || source.subject_key_paths === null
    || (Array.isArray(source.subject_key_paths) && source.subject_key_paths.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const path = entry as Record<string, unknown>;
      return (
        (path.loc === "body" || path.loc === "header" || path.loc === "query")
        && typeof path.path === "string"
        && (path.kind === undefined || typeof path.kind === "string")
      );
    }));
  return (
    typeof source.source_id === "string"
    && typeof source.workspace_id === "string"
    && typeof source.name === "string"
    && typeof source.secret_token === "string"
    && (source.url_token_hash === undefined
      || (typeof source.url_token_hash === "string" && /^[0-9a-f]{64}$/.test(source.url_token_hash)))
    && (source.status === "active" || source.status === "disabled")
    && providerOk
    && signingSecretOk
    && redactPathsOk
    && optionalNumber(source.max_body_bytes)
    && optionalNumber(source.max_body_depth)
    && optionalNumber(source.max_events_per_minute)
    && (source.field_selection === null || optionalStringArray(source.field_selection))
    && (source.ordering_enabled === undefined || typeof source.ordering_enabled === "boolean")
    && optionalString(source.ordering_key_header)
    && optionalString(source.ordering_key_path)
    && subjectPathsOk
    && optionalStringArray(source.inbound_ip_allowlist)
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function validFenceToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function authorityStub(namespace: SourceAuthorityNamespaceLike, sourceId: string): SourceAuthorityStubLike {
  return namespace.get(namespace.idFromName(sourceId));
}

async function authorityRequest(
  namespace: SourceAuthorityNamespaceLike,
  sourceId: string,
  operation: AuthorityOperation,
): Promise<Response> {
  return authorityStub(namespace, sourceId).fetch(INTERNAL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(operation),
  });
}

async function authorityUnavailableError(response: Response): Promise<SourceLookupUnavailableError> {
  let diagnostic: unknown;
  try {
    diagnostic = await readBoundedJsonResponse(response, 1024);
  } catch { /* Only fixed diagnostic codes may cross the authority boundary. */ }
  if (diagnostic && typeof diagnostic === "object" && "reason" in diagnostic
    && isSourceLookupFailureReason(diagnostic.reason)) {
    const status = "http_status" in diagnostic ? diagnostic.http_status : undefined;
    return new SourceLookupUnavailableError("source authority lookup failed", diagnostic.reason,
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
  }
  return new SourceLookupUnavailableError("source authority unavailable", "authority_unavailable");
}

/**
 * Resolve source authorization through the per-source Durable Object. The
 * worker calls this for every hosted ingest request. A missing binding uses the
 * authenticated origin lookup directly and never falls back to a positive KV
 * entry.
 */
export async function resolveSourceWithAuthority(
  env: SourceAuthorityEnv,
  sourceId: string,
  directLookup: (sourceId: string) => Promise<Source | null>,
): Promise<Source | null> {
  return (await beginSourceAuthorizationWithAuthority(env, sourceId, directLookup)).source;
}

export async function beginSourceAuthorizationWithAuthority(
  env: SourceAuthorityEnv,
  sourceId: string,
  directLookup: (sourceId: string) => Promise<Source | null>,
): Promise<SourceAuthorityResolution> {
  if (env.DEV_MODE === "true") {
    return { source: await directLookup(sourceId) };
  }
  if (!env.SOURCE_AUTHORITY) {
    if (env.SOURCE_AUTHORITY_REQUIRED === "true") {
      throw new SourceLookupUnavailableError("required source authority binding is unavailable", "authority_unavailable");
    }
    return { source: await directLookup(sourceId) };
  }

  let response: Response;
  try {
    response = await authorityRequest(env.SOURCE_AUTHORITY, sourceId, {
      op: "resolve",
      source_id: sourceId,
    });
  } catch {
    throw new SourceLookupUnavailableError("source authority request failed", "authority_unavailable");
  }
  if (response.status === 423) {
    let fenceKind: "mutation" | "drift" | undefined;
    try {
      const body = await readBoundedJsonResponse(response, 1024);
      if (body && typeof body === "object" && "fence_kind" in body) {
        const kind = (body as { fence_kind: unknown }).fence_kind;
        if (kind === "mutation" || kind === "drift") fenceKind = kind;
      }
    } catch { /* Body is advisory only; proceed without fence_kind on parse failure. */ }
    throw new SourceLookupUnavailableError("source authorization is temporarily fenced", "source_fenced", undefined, fenceKind);
  }
  if (response.status === 503) {
    throw await authorityUnavailableError(response);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceLookupUnavailableError("source authority returned an invalid status");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SourceLookupUnavailableError("source authority returned invalid JSON");
  }
  if (!body || typeof body !== "object" || !("source" in body)) {
    throw new SourceLookupUnavailableError("source authority returned an invalid payload");
  }
  const source = (body as { source: unknown }).source;
  const authorizationVersion = (body as { authorization_version?: unknown }).authorization_version;
  if (!validFenceToken(authorizationVersion)) {
    throw new SourceLookupUnavailableError("source authority omitted its authorization version");
  }
  if (source === null) return { source: null, authorizationVersion };
  if (!isSource(source) || source.source_id !== sourceId) {
    throw new SourceLookupUnavailableError("source authority returned an invalid source");
  }
  return { source, authorizationVersion };
}

/**
 * Confirm that no fence or committed config change landed while the worker was
 * reading and verifying the request. Direct-origin profiles have no version
 * and need no second call.
 */
export async function confirmSourceAuthorizationWithAuthority(
  env: SourceAuthorityEnv,
  sourceId: string,
  authorizationVersion: string | undefined,
): Promise<void> {
  if (!authorizationVersion) return;
  if (!env.SOURCE_AUTHORITY || env.DEV_MODE === "true") {
    throw new SourceLookupUnavailableError("source authority confirmation is unavailable", "authority_unavailable");
  }
  let response: Response;
  try {
    response = await authorityRequest(env.SOURCE_AUTHORITY, sourceId, {
      op: "confirm",
      source_id: sourceId,
      authorization_version: authorizationVersion,
    });
  } catch {
    throw new SourceLookupUnavailableError("source authority confirmation failed", "authority_unavailable");
  }
  if (response.status === 503) {
    throw await authorityUnavailableError(response);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceLookupUnavailableError("source authorization changed during request verification",
      response.status === 423 ? "authorization_changed" : "authority_unavailable", response.status);
  }
  await response.body?.cancel().catch(() => undefined);
}

export interface SourceAuthorityAdminClient {
  fence(sourceId: string, fenceToken: string): Promise<void>;
  sync(sourceId: string, fenceToken: string, source: Source | null): Promise<void>;
  bootstrap(sourceId: string, source: Source): Promise<void>;
  invalidate(sourceId: string): Promise<void>;
}

export function sourceAuthorityAdminClient(
  namespace: SourceAuthorityNamespaceLike | undefined,
  required = false,
): SourceAuthorityAdminClient | null {
  if (!namespace) {
    if (!required) return null;
    const unavailable = async (): Promise<void> => {
      throw new Error("required_source_authority_binding_unavailable");
    };
    return {
      fence: unavailable,
      sync: unavailable,
      bootstrap: unavailable,
      invalidate: unavailable,
    };
  }

  const requireSuccess = async (response: Response, error: string): Promise<void> => {
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await response.body?.cancel().catch(() => undefined);
    throw new Error(error);
  };

  return {
    async fence(sourceId, fenceToken) {
      const response = await authorityRequest(namespace, sourceId, {
        op: "fence",
        source_id: sourceId,
        fence_token: fenceToken,
      });
      await requireSuccess(response, "source_authority_fence_failed");
    },
    async sync(sourceId, fenceToken, source) {
      const response = await authorityRequest(namespace, sourceId, {
        op: "sync",
        source_id: sourceId,
        fence_token: fenceToken,
        source,
      });
      await requireSuccess(response, "source_authority_sync_failed");
    },
    async bootstrap(sourceId, source) {
      const response = await authorityRequest(namespace, sourceId, {
        op: "bootstrap",
        source_id: sourceId,
        source,
      });
      await requireSuccess(response, "source_authority_bootstrap_failed");
    },
    async invalidate(sourceId) {
      const response = await authorityRequest(namespace, sourceId, {
        op: "legacy_invalidate",
        source_id: sourceId,
      });
      await requireSuccess(response, "source_authority_invalidate_failed");
    },
  };
}

/**
 * SQLite-backed, one-instance-per-source authorization state. Resolve, final
 * confirmation, and fencing are serialized. A successful fence therefore
 * follows every earlier authorization decision, while requests that have not
 * reached final confirmation fail closed.
 *
 * SQLite stores only the fence or a digest of committed config. The full
 * source, including signing secrets, is held only in this live object and is
 * discarded on a fence or cache expiry.
 */
export class SourceAuthorityDurableObject {
  private tail: Promise<void> = Promise.resolve();
  private hotSource: HotSourceConfig | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: DeliverySourceLookupEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.serialized(async () => {
      let operation: AuthorityOperation;
      try {
        operation = (await request.json()) as AuthorityOperation;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!validId(operation.source_id)) return json({ error: "invalid_source_id" }, 400);

      switch (operation.op) {
        case "resolve":
          return this.resolve(operation.source_id);
        case "confirm":
          return this.confirm(operation.source_id, operation.authorization_version);
        case "fence":
          if (!validFenceToken(operation.fence_token)) {
            return json({ error: "invalid_fence_token" }, 400);
          }
          await this.storeFence(operation.source_id, operation.fence_token);
          return new Response(null, { status: 204 });
        case "sync":
          return this.sync(operation);
        case "bootstrap":
          return this.bootstrap(operation);
        case "legacy_invalidate":
          return this.legacyInvalidate(operation.source_id);
        default:
          return json({ error: "unknown_op" }, 400);
      }
    }).catch((error: unknown) => {
      if (!(error instanceof SourceLookupUnavailableError)) throw error;
      return json({ error: "source_lookup_unavailable", reason: error.reason, http_status: error.httpStatus }, 503);
    });
  }

  private async resolve(sourceId: string): Promise<Response> {
    const stored = await this.readState(sourceId);
    if (stored?.status === "fenced") {
      this.hotSource = undefined;
      return json({ error: "source_fenced" }, 423);
    }
    if (stored?.status === "refresh_required") {
      const refreshed = await this.loadCommittedSource(sourceId);
      return json({
        source: refreshed.source,
        authorization_version: refreshed.authorizationVersion,
      });
    }
    if (
      stored?.status === "ready"
      && !stored.sourcePresent
      && stored.expiresAt > Date.now()
    ) {
      return json({
        source: null,
        authorization_version: stored.authorizationVersion,
      });
    }

    const hot = this.hotSource;
    if (
      stored?.status === "ready"
      && hot
      && hot.authorizationVersion === stored.authorizationVersion
      && hot.sourceFingerprint === stored.sourceFingerprint
      && hot.expiresAt > Date.now()
    ) {
      return json({
        source: hot.source,
        authorization_version: stored.authorizationVersion,
      });
    }

    this.hotSource = undefined;
    const source = await lookupSourceFromDeliveryService(this.env, sourceId);
    const fingerprint = await sourceFingerprint(source);
    if (
      stored?.status === "ready"
      && stored.sourcePresent
      && (source === null || stored.sourceFingerprint !== fingerprint)
    ) {
      // Origin state changed without the required pre-commit fence. Persist a
      // fence so a transient cold start cannot accept the uncoordinated state.
      await this.storeFence(
        sourceId,
        `drift_${crypto.randomUUID().replaceAll("-", "")}`,
        "drift",
      );
      return json({ error: "source_config_drift" }, 423);
    }

    // Refreshing identical committed config must not revoke an in-flight
    // request. Fences, syncs, and legacy invalidation still issue new versions.
    const unchanged = stored?.status === "ready" && stored.sourceFingerprint === fingerprint;
    const ready = unchanged && stored.expiresAt > Date.now()
      ? stored
      : await this.storeReady(sourceId, source, fingerprint,
        unchanged ? stored.authorizationVersion : undefined);
    this.hotSource = {
      source,
      sourceFingerprint: fingerprint,
      expiresAt: ready.expiresAt,
      authorizationVersion: ready.authorizationVersion,
    };
    return json({ source, authorization_version: ready.authorizationVersion });
  }

  private async confirm(sourceId: string, authorizationVersion: string): Promise<Response> {
    if (!validFenceToken(authorizationVersion)) {
      return json({ error: "invalid_authorization_version" }, 400);
    }
    let stored = await this.readState(sourceId);
    if (
      stored?.status !== "ready"
      || !stored.sourcePresent
      || stored.authorizationVersion !== authorizationVersion
    ) {
      return json({ error: "authorization_changed" }, 423);
    }
    if (stored.expiresAt <= Date.now()) {
      // This runs inside the same serialized operation as the final decision.
      // Origin outages and config drift stay closed; expiry alone is not a
      // credential change. A queued fence cannot acknowledge before this ends.
      const refreshed = await this.resolve(sourceId);
      if (!refreshed.ok) return refreshed;
      await refreshed.body?.cancel();
      stored = await this.readState(sourceId);
      if (stored?.status !== "ready" || !stored.sourcePresent
        || stored.authorizationVersion !== authorizationVersion
        || stored.expiresAt <= Date.now()) {
        return json({ error: "authorization_changed" }, 423);
      }
    }
    return new Response(null, { status: 204 });
  }

  private async sync(operation: Extract<AuthorityOperation, { op: "sync" }>): Promise<Response> {
    if (!validFenceToken(operation.fence_token)) {
      return json({ error: "invalid_fence_token" }, 400);
    }
    if (operation.source !== null && (!isSource(operation.source) || operation.source.source_id !== operation.source_id)) {
      return json({ error: "invalid_source" }, 400);
    }

    const stored = await this.readState(operation.source_id);
    if (stored?.status !== "fenced" || stored.fenceToken !== operation.fence_token) {
      // An out-of-order completion means another mutation may have committed.
      // Re-fence instead of serving either caller's potentially stale config.
      await this.storeFence(operation.source_id, operation.fence_token);
      return json({ error: "fence_token_mismatch" }, 409);
    }

    await this.storeReady(operation.source_id, operation.source);
    return new Response(null, { status: 204 });
  }

  private async bootstrap(operation: Extract<AuthorityOperation, { op: "bootstrap" }>): Promise<Response> {
    if (!isSource(operation.source) || operation.source.source_id !== operation.source_id) {
      return json({ error: "invalid_source" }, 400);
    }
    const stored = await this.readState(operation.source_id);
    if (!stored) {
      await this.storeReady(operation.source_id, operation.source);
    }
    return new Response(null, { status: 204 });
  }

  /**
   * Compatibility for a dashboard version that only knows the old
   * post-commit cache invalidation endpoint. First persist a fail-closed state,
   * then reload committed config directly from the authenticated origin. If
   * the origin is unavailable, future resolves keep retrying from the
   * fail-closed state instead of stranding the source forever.
   *
   * An explicit mutation fence always wins. A legacy call may reconcile only
   * an unfenced source or a drift fence caused by the same old post-commit
   * rollout path.
   */
  private async legacyInvalidate(sourceId: string): Promise<Response> {
    const stored = await this.readState(sourceId);
    if (stored?.status === "fenced" && stored.fenceKind !== "drift") {
      return json({ error: "source_fenced" }, 423);
    }
    await this.storeRefreshRequired(sourceId);
    try {
      await this.loadCommittedSource(sourceId);
    } catch {
      return json({ error: "source_refresh_unavailable" }, 503);
    }
    return new Response(null, { status: 204 });
  }

  private async loadCommittedSource(sourceId: string): Promise<{
    source: Source | null;
    authorizationVersion: string;
  }> {
    const source = await lookupSourceFromDeliveryService(this.env, sourceId);
    const ready = await this.storeReady(sourceId, source);
    return { source, authorizationVersion: ready.authorizationVersion };
  }

  private async readState(sourceId: string): Promise<AuthorityState | undefined> {
    const stored = await this.state.storage.get<unknown>(STATE_KEY);
    if (!stored) return undefined;
    if (
      !isAuthorityState(stored)
      || stored.sourceIdDigest !== await sourceIdFingerprint(sourceId)
    ) {
      throw new SourceLookupUnavailableError("source authority state mismatch");
    }
    return stored;
  }

  private async storeFence(
    sourceId: string,
    fenceToken: string,
    fenceKind: "mutation" | "drift" = "mutation",
  ): Promise<void> {
    // Clear live secrets before attempting the durable fence. If storage is
    // unavailable, the admin request fails and this object still stays closed.
    this.hotSource = undefined;
    await this.state.storage.put<AuthorityState>(STATE_KEY, {
      version: 1,
      sourceIdDigest: await sourceIdFingerprint(sourceId),
      status: "fenced",
      fenceToken,
      fenceKind,
    });
  }

  private async storeRefreshRequired(sourceId: string): Promise<void> {
    this.hotSource = undefined;
    await this.state.storage.put<AuthorityState>(STATE_KEY, {
      version: 1,
      sourceIdDigest: await sourceIdFingerprint(sourceId),
      status: "refresh_required",
    });
  }

  private async storeReady(
    sourceId: string,
    source: Source | null,
    fingerprint?: string,
    authorizationVersion = crypto.randomUUID().replaceAll("-", ""),
  ): Promise<Extract<AuthorityState, { status: "ready" }>> {
    const sourceConfigFingerprint = fingerprint ?? await sourceFingerprint(source);
    const expiresAt = Date.now() + (source ? POSITIVE_REFRESH_MS : NEGATIVE_REFRESH_MS);
    const ready: Extract<AuthorityState, { status: "ready" }> = {
      version: 1,
      sourceIdDigest: await sourceIdFingerprint(sourceId),
      status: "ready",
      sourceFingerprint: sourceConfigFingerprint,
      sourcePresent: source !== null,
      expiresAt,
      authorizationVersion,
    };
    await this.state.storage.put<AuthorityState>(STATE_KEY, ready);
    this.hotSource = {
      source,
      sourceFingerprint: sourceConfigFingerprint,
      expiresAt,
      authorizationVersion: ready.authorizationVersion,
    };
    return ready;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isAuthorityState(value: unknown): value is AuthorityState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1
    || typeof state.sourceIdDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(state.sourceIdDigest)
  ) return false;
  if (state.status === "fenced") {
    return validFenceToken(state.fenceToken)
      && (state.fenceKind === "mutation" || state.fenceKind === "drift");
  }
  if (state.status === "refresh_required") return true;
  return (
    state.status === "ready"
    && typeof state.sourceFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(state.sourceFingerprint)
    && typeof state.sourcePresent === "boolean"
    && typeof state.expiresAt === "number"
    && Number.isFinite(state.expiresAt)
    && validFenceToken(state.authorizationVersion)
  );
}

async function sourceFingerprint(source: Source | null): Promise<string> {
  const canonical = canonicalJson(source);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`axel-source-authority-v1\0${canonical}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sourceIdFingerprint(sourceId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`axel-source-authority-id-v1\0${sourceId}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
