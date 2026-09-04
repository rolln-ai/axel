/**
 * AXE-30 — workspace configuration export (config-as-code).
 *
 * GET /api/v1/config returns a redacted, versioned, JSON-shaped
 * snapshot of every routable resource in the workspace: sources,
 * destinations, routes, and their attachments. Suitable for
 * `axel config pull > workspace.json`, code review, env promotion,
 * or kicking off a Terraform import later.
 *
 * Redaction rules:
 *   - secret_token_hash is omitted (token plaintext lost at create
 *     time; the hash isn't useful elsewhere).
 *   - signing_secret_ciphertext is omitted (decryptable only with
 *     CREDENTIALS_MASTER_KEY, which lives on the dashboard host).
 *   - destination credentials are referenced by `credentials_ref`
 *     so the apply side knows it needs to re-set them; the
 *     ciphertext never leaves the dashboard host.
 *
 * Re-applying: walk the JSON in dependency order (sources →
 * destinations → routes → attachments) and POST each resource via
 * the matching /api/v1 endpoint. The TF provider (deferred) will
 * wrap this for declarative apply.
 */
import { type NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { apiOk, withApiAuth } from "../../../../lib/api-router";

interface ExportedConfig {
  version: 1;
  exported_at: string;
  workspace_id: string;
  sources: Array<Record<string, unknown>>;
  destinations: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
}

export async function GET(req: NextRequest) {
  // AXE-audit — `admin` scope required. The export contains every
  // destination config jsonb in the workspace; even with redacted
  // secrets, a `read`-scope key (handed to a CI bot) shouldn't be
  // able to enumerate the full topology + cred fingerprints.
  return withApiAuth(req, "admin", async (ctx) => {
    const [sources, destinations, routes, attachments] = await Promise.all([
      db().query<{
        id: string;
        name: string | null;
        status: string;
        provider: string;
        max_body_bytes: number | null;
        max_body_depth: number | null;
        max_events_per_minute: number | null;
        field_selection: string[] | null;
        inbound_ip_allowlist: string[];
        transient_mode: boolean;
        raw_payload_retention_days: number | null;
      }>(
        `SELECT id, name, status, provider,
                max_body_bytes, max_body_depth, max_events_per_minute,
                field_selection, inbound_ip_allowlist,
                transient_mode, raw_payload_retention_days
           FROM sources
          WHERE workspace_id = $1
          ORDER BY created_at`,
        [ctx.workspace_id],
      ),
      db().query<{
        id: string;
        name: string | null;
        type: string;
        status: string;
        config: Record<string, unknown>;
        credentials_ref: string | null;
        rate_limit_rps: number | null;
        request_timeout_ms: number | null;
        circuit_threshold_failures: number;
        circuit_cooldown_seconds: number;
      }>(
        `SELECT id, name, type, status, config, credentials_ref,
                rate_limit_rps, request_timeout_ms,
                circuit_threshold_failures, circuit_cooldown_seconds
           FROM destinations
          WHERE workspace_id = $1
          ORDER BY created_at`,
        [ctx.workspace_id],
      ),
      db().query<{
        id: string;
        source_id: string;
        status: string;
        filter_expression: string | null;
        transform_script: string | null;
        engine: string;
      }>(
        `SELECT id, source_id, status, filter_expression, transform_script, engine
           FROM routes
          WHERE workspace_id = $1
          ORDER BY created_at`,
        [ctx.workspace_id],
      ),
      db().query<{
        route_id: string;
        destination_id: string;
        binding: Record<string, unknown> | null;
      }>(
        `SELECT rd.route_id, rd.destination_id, rd.binding
           FROM route_destinations rd
           JOIN routes r ON r.id = rd.route_id
          WHERE r.workspace_id = $1`,
        [ctx.workspace_id],
      ),
    ]);
    const attachByRoute = new Map<string, string[]>();
    const bindingsByRoute = new Map<string, Record<string, Record<string, unknown> | null>>();
    for (const row of attachments.rows) {
      const list = attachByRoute.get(row.route_id) ?? [];
      list.push(row.destination_id);
      attachByRoute.set(row.route_id, list);
      const bindings = bindingsByRoute.get(row.route_id) ?? {};
      bindings[row.destination_id] = row.binding;
      bindingsByRoute.set(row.route_id, bindings);
    }
    const config: ExportedConfig = {
      version: 1,
      exported_at: new Date().toISOString(),
      workspace_id: ctx.workspace_id,
      sources: sources.rows.map((r) => redactSource(r)),
      destinations: destinations.rows.map((r) => redactDestination(r)),
      routes: routes.rows.map((r) => ({
        ...r,
        destination_ids: attachByRoute.get(r.id) ?? [],
        destination_bindings: bindingsByRoute.get(r.id) ?? {},
      })),
    };
    return apiOk(config);
  });
}

function redactSource(row: Record<string, unknown>): Record<string, unknown> {
  // Drop nothing — sources don't have plaintext secrets in the row.
  // (Signing-secret ciphertext is queried separately and not selected
  // here.) Keep the row intact for round-trippability.
  return row;
}

function redactDestination(row: Record<string, unknown>): Record<string, unknown> {
  const config = (row.config as Record<string, unknown> | null) ?? null;
  const redactedConfig = config ? redactConfigSecrets(config) : config;
  // Header values are credentials regardless of how innocuous their names
  // look. Preserve names for structural review, but never export a value.
  if (redactedConfig && typeof redactedConfig === "object" && redactedConfig !== null) {
    const cfg = redactedConfig as Record<string, unknown>;
    if (cfg.headers && typeof cfg.headers === "object" && cfg.headers !== null) {
      const headers = cfg.headers as Record<string, unknown>;
      const redactedHeaders: Record<string, unknown> = {};
      for (const key of Object.keys(headers)) {
        redactedHeaders[key] = "[REDACTED]";
      }
      cfg.headers = redactedHeaders;
    }
  }
  return {
    ...row,
    config: redactedConfig,
    credentials_ref: row.credentials_ref ? "[REDACTED — re-set via POST /destinations]" : null,
  };
}

function redactConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  // AXE-audit — flipped from denylist to allowlist. Anything not on
  // this list is replaced with [REDACTED] to guard against future
  // connectors adding new secret-shaped fields the denylist hasn't
  // heard of yet. If a connector legitimately needs a new SAFE
  // field exported, add it here explicitly.
  const SAFE_KEYS = new Set<string>([
    // Common config (non-secret)
    // Destination URLs can be credentials themselves (Slack/Discord webhook
    // paths, signed query strings, userinfo). They are intentionally omitted
    // from the allowlist and therefore exported as [REDACTED].
    "method",
    "auth_type",
    "preset",
    "headers",        // already-built (non-secret) header dictionary
    "api_key_header", // header *name* not value
    "basic_user",     // username is not the secret
    "signing_algorithm",
    "timeoutMs",
    "timeout_ms",
    "max_retries",
    "fingerprint_last4",
    "fingerprint_sha256_prefix",
    // Mongo / Postgres / S3 / R2 / BigQuery — only structural fields
    "database",
    "collection",
    "table",
    "schema",
    "bucket",
    "keyPrefix",
    "key_prefix",
    "region",
    "project_id",
    "dataset",
    "idempotency_field",
    "host",
    "port",
    "user",
    "ssl",
    // Databricks
    "warehouse_id",
    "catalog",
    "volume",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (SAFE_KEYS.has(k)) {
      out[k] = v;
    } else if (v === null || v === undefined || v === "") {
      out[k] = v;
    } else {
      out[k] = "[REDACTED]";
    }
  }
  return out;
}
