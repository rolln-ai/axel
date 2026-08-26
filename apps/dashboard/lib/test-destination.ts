"use server";

import "server-only";
import { Pool } from "pg";
import { MongoClient } from "mongodb";
import { withWorkspaceMutation } from "./with-mutation";
import type { ActionState } from "./action-data";
import {
  connectionHostSsrfReason,
  isTlsCertVerificationError,
  pgSslOption,
  validateDestinationUrl,
  withMongoTlsNoVerify,
  withNoVerifySslMode,
} from "@axel/shared";
import { schemaFor, type DestinationType } from "./destination-defaults";
import {
  readDestinationValues,
  validateDestinationType,
  validateDestinationValues,
} from "./destination-validation";
import { formValue } from "./form";
import {
  parseServiceAccountJson,
  mintGoogleAccessToken,
  BIGQUERY_API_ROOT,
  BIGQUERY_SCOPE,
} from "./bigquery-auth";

/**
 * Pre-create connectivity probe for the destination form. Catches three
 * common foot-guns before the operator persists an encrypted credential
 * blob and only finds out it's broken at first delivery:
 *
 *   1. A required field is empty (typed wrong type, switched type without
 *      filling new fields).
 *   2. A connection string is malformed (whitespace in userinfo, missing
 *      scheme).
 *   3. The remote service rejects the credentials we'd actually use, or
 *      isn't reachable from Vercel egress.
 *
 * Tests are best-effort. A false positive ("ok" but delivery fails later)
 * is acceptable; a false negative is not — so each probe is conservative,
 * uses the same auth path the connector will, and fails open on edge
 * cases the operator can't fix from this dialog (e.g. R2's shared bucket).
 */

const PROBE_TIMEOUT_MS = 8_000;

export interface TestDestinationResult {
  ok: boolean;
  message: string;
  /**
   * Set when the probe failed specifically because the database's TLS
   * certificate chain couldn't be verified (self-signed / private-CA). The UI
   * uses this to surface the "connect without certificate verification" toggle.
   */
  certError?: boolean;
  /**
   * Tri-state for the pre-flight gate (block-on-definite-failure policy):
   *   - "fail" — a provable problem (auth denied, table exists but no write
   *     access). The gate BLOCKS pipeline creation.
   *   - "warn" — couldn't fully verify (e.g. a brand-new BigQuery table we
   *     can't test in advance). The gate ALLOWS but surfaces the caveat.
   *   - "pass" — verified green.
   * The create-time gate blocks only on `severity === "fail"`; "warn" and
   * legacy returns without a severity are allowed through.
   */
  severity?: "pass" | "warn" | "fail";
}

/** A BigQuery write target, parsed from a route binding's `dataset.table`. */
interface BqTarget {
  dataset: string;
  table: string;
}

function parseBqTarget(raw: string): BqTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return { dataset: trimmed.slice(0, dot), table: trimmed.slice(dot + 1) };
}

export async function testDestination(formData: FormData): Promise<TestDestinationResult> {
  // Same auth requirement as createDestination — don't let unauthenticated
  // callers use the dashboard as a port scanner. And the same ROLE gate: the
  // dialog only renders for owner/admin, but server actions are directly
  // POST-able, so without this a member could make the server open outbound
  // connections to hosts they supply.
  return withWorkspaceMutation<TestDestinationResult>(
    // Gate rejections surface as a blocking "fail" probe result.
    { gateError: (message) => ({ ok: false, severity: "fail", message }) },
    async () => {

    const type = formData.get("type");
    if (typeof type !== "string" || !validateDestinationType(type)) {
      return { ok: false, message: "Pick a destination type." };
    }

    const name = formValue(formData, "name");
    if (!name) return { ok: false, message: "Missing required field: Name." };

    const schema = schemaFor(type);
    // RAW values so validateDestinationValues can flag paste-error whitespace
    // (the old local copy trimmed first, which silently defeated that check).
    const values = readDestinationValues(formData, type);

    for (const field of schema.fields) {
      if (field.required === false) continue;
      if (!values[field.key]?.trim()) {
        return { ok: false, message: `Missing required field: ${field.label}.` };
      }
    }

    const shapeError = validateDestinationValues(type, values);
    if (shapeError) return { ok: false, severity: "fail", message: shapeError };
    trimValues(values);

    // The standalone destination form carries no route target, but if a probe
    // form ever includes dataset/table, write-check against it.
    const target =
      values.dataset && values.table ? { dataset: values.dataset, table: values.table } : null;
    try {
      return await runProbe(type, values, {
        target,
        pgSslNoVerify: formData.get("pg_ssl_no_verify") === "true",
        mongoTlsNoVerify: formData.get("mongo_tls_no_verify") === "true",
      });
    } catch (err) {
      return { ok: false, severity: "fail", message: err instanceof Error ? err.message : String(err) };
    }
    },
  );
}

/**
 * Automatic pre-flight for the source→pipeline wizard's NEW-destination path.
 * Reads the wizard's own field names (`new_destination_type`, `dest_field_*`,
 * `new_destination_target`) and runs the same probes as the Test button, so a
 * pipeline can't go live to a destination we can prove is broken. Existing
 * destinations were validated at their own create time, so they pass here
 * (write-checking an existing destination against a per-route target is a
 * follow-up); the "Just create source" skip path has nothing to check.
 */
export async function preflightPipelineDestination(
  formData: FormData,
): Promise<TestDestinationResult> {
  // Same role gate as testDestination — this probe opens outbound
  // connections too, and the wizard that renders it is owner/admin-only.
  return withWorkspaceMutation<TestDestinationResult>(
    // Gate rejections surface as a blocking "fail" probe result.
    { gateError: (message) => ({ ok: false, severity: "fail", message }) },
    async () => {

    const intent = formData.get("action_intent");
    const mode =
      intent === "skip" ? "skip" : String(formData.get("destination_mode") ?? "");
    if (mode === "skip") {
      return { ok: true, severity: "pass", message: "Source only — no destination to check." };
    }
    if (mode === "existing") {
      return { ok: true, severity: "pass", message: "Using an existing destination." };
    }

    const type = formData.get("new_destination_type");
    if (typeof type !== "string" || !validateDestinationType(type)) {
      return { ok: false, severity: "fail", message: "Pick a destination type." };
    }
    const schema = schemaFor(type);
    // RAW values (see testDestination) — same whitespace/SSRF gate the
    // create path runs, then trimmed for the probes.
    const values = readDestinationValues(formData, type, { prefix: "dest_field_" });
    for (const field of schema.fields) {
      if (field.required === false) continue;
      if (!values[field.key]?.trim()) {
        return { ok: false, severity: "fail", message: `Missing required field: ${field.label}.` };
      }
    }
    const shapeError = validateDestinationValues(type, values);
    if (shapeError) return { ok: false, severity: "fail", message: shapeError };
    trimValues(values);

    const target = parseBqTarget(String(formData.get("new_destination_target") ?? ""));
    try {
      return await runProbe(type, values, {
        target,
        pgSslNoVerify: formData.get("dest_field_pg_ssl_no_verify") === "true",
        mongoTlsNoVerify: formData.get("dest_field_mongo_tls_no_verify") === "true",
      });
    } catch (err) {
      return { ok: false, severity: "fail", message: err instanceof Error ? err.message : String(err) };
    }
    },
  );
}

/** Dispatch to the per-type probe. Shared by the Test button and the wizard gate. */
async function runProbe(
  type: DestinationType,
  values: Record<string, string>,
  opts: { target: BqTarget | null; pgSslNoVerify: boolean; mongoTlsNoVerify: boolean },
): Promise<TestDestinationResult> {
  switch (type) {
    case "webhook":
    case "http":
      return probeHttp(values);
    case "postgres":
      return probePostgres(values, opts.pgSslNoVerify);
    case "mongodb":
      return probeMongo(values, opts.mongoTlsNoVerify);
    case "s3":
      return {
        ok: true,
        severity: "pass",
        message:
          "S3 credentials accepted for format — actual bucket reachability is confirmed on first delivery. For S3-compatible providers, make sure the endpoint URL and signing region match their docs.",
      };
    case "r2":
      return {
        ok: true,
        severity: "pass",
        message: "Cloudflare R2 uses Axel's shared bucket — no remote credentials to test.",
      };
    case "databricks_sql":
      return probeDatabricksSql(values);
    case "databricks_volume":
      return probeDatabricksVolume(values);
    case "bigquery":
      return probeBigQuery(values, opts.target);
    default:
      return { ok: false, severity: "fail", message: "Unknown destination type." };
  }
}

/**
 * Probes expect clean values; validation ran on the raw strings (and already
 * trimmed textarea secrets in place), so trim the rest before dispatch.
 */
function trimValues(values: Record<string, string>): void {
  for (const key of Object.keys(values)) {
    values[key] = (values[key] ?? "").trim();
  }
}

async function probeHttp(values: Record<string, string>): Promise<TestDestinationResult> {
  const url = values.url;
  if (!url) return { ok: false, message: "Missing receiver URL." };
  // Audit-pass2 — SSRF gate. Without this an authenticated dashboard
  // user could use the probe surface as a port scanner against the
  // Vercel host's private network (e.g. 169.254.169.254 metadata).
  // Same rules as the connector-time check at delivery.
  const ssrf = validateDestinationUrl(url);
  if (ssrf) return { ok: false, message: ssrf };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `Receiver URL is malformed: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: `Receiver URL must use http or https (got ${parsed.protocol}).` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // HEAD with redirect:"manual" — any HTTP response (incl. 405/404/401)
    // means we reached the receiver. Only DNS/TCP/TLS failures throw.
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "manual",
    });
    if (parsed.protocol === "http:") {
      return {
        ok: true,
        message: `Reachable. ${parsed.host} returned HTTP ${res.status} on HEAD. Axel will deliver via ${values.method ?? "POST"}; the receiver will see real events at ingest time. Warning: this is a plain-HTTP (not HTTPS) endpoint, so signed payloads — including the HMAC Signature header — will be sent in the clear. Use HTTPS in production.`,
      };
    }
    return {
      ok: true,
      message: `Reachable. ${parsed.host} returned HTTP ${res.status} on HEAD. Axel will deliver via ${values.method ?? "POST"}; the receiver will see real events at ingest time.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        message: `Connection timed out after ${PROBE_TIMEOUT_MS / 1000}s — host unreachable from Vercel egress, or firewalled.`,
      };
    }
    return {
      ok: false,
      message: `Couldn't reach ${parsed.host}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probePostgres(
  values: Record<string, string>,
  noVerify = false,
): Promise<TestDestinationResult> {
  const rawConnStr = values.connection_string;
  // `table` is a per-route binding, not part of the Postgres destination schema
  // (which only carries connection_string). Treat it as optional: when present
  // (e.g. an explicit probe) verify it exists; otherwise just confirm the
  // connection is reachable — requiring it here made Test Connection always fail.
  const table = values.table;
  if (!rawConnStr) return { ok: false, message: "Missing connection string." };
  // SSRF guard — the probe opens a real socket, so block private/link-local/
  // metadata hosts (parity with probeMongo; an authenticated user must not be
  // able to use this as a port scanner against Vercel's egress network).
  const pgSsrf = connectionHostSsrfReason(rawConnStr);
  if (pgSsrf) return { ok: false, message: pgSsrf };

  // When the operator has ticked "connect without certificate verification",
  // probe with the exact DSN we'll persist (sslmode=no-verify) so the test's
  // TLS posture matches delivery's.
  const connStr = noVerify ? withNoVerifySslMode(rawConnStr) : rawConnStr;
  const pool = new Pool({
    connectionString: connStr,
    ssl: pgSslOption(connStr),
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await pool.query("SELECT 1");
    if (!table) {
      return { ok: true, message: "Connected to Postgres. Credentials and connectivity verified." };
    }
    // to_regclass returns the table's oid if it exists and is visible to
    // this role, else NULL. Doesn't scan, doesn't lock.
    const r = await pool.query<{ oid: string | null }>(
      `SELECT to_regclass($1)::text AS oid`,
      [table],
    );
    if (!r.rows[0]?.oid) {
      return {
        ok: false,
        message: `Connected, but table "${table}" doesn't exist (or this role can't see it). Create it before pointing Axel at it.`,
      };
    }
    return { ok: true, message: `Connected to Postgres. Table "${table}" is visible to this role.` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A cert-chain verification failure is recoverable from this dialog: the DB
    // (e.g. Railway's proxy, Heroku Postgres) presents a self-signed/private-CA
    // cert. Flag it so the UI can offer the no-verify toggle instead of leaving
    // the operator to decode "self-signed certificate in certificate chain".
    if (!noVerify && isTlsCertVerificationError(err)) {
      return {
        ok: false,
        certError: true,
        message: `Postgres rejected the probe: ${detail}. This database presents a self-signed or private-CA certificate. If you trust the network path to it, enable "Connect without certificate verification" below and test again.`,
      };
    }
    return { ok: false, message: `Postgres rejected the probe: ${detail}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function probeMongo(
  values: Record<string, string>,
  noVerify = false,
): Promise<TestDestinationResult> {
  const rawConnStr = values.connection_string;
  const database = values.database;
  if (!rawConnStr) return { ok: false, message: "Missing connection string." };
  if (!database) return { ok: false, message: "Missing database." };
  const mongoSsrf = connectionHostSsrfReason(rawConnStr);
  if (mongoSsrf) return { ok: false, message: mongoSsrf };

  // Probe with the exact URI we'll persist when the operator ticked "connect
  // without certificate verification", so the test's TLS posture matches delivery.
  const connStr = noVerify ? withMongoTlsNoVerify(rawConnStr) : rawConnStr;
  const client = new MongoClient(connStr, {
    serverSelectionTimeoutMS: PROBE_TIMEOUT_MS,
    connectTimeoutMS: PROBE_TIMEOUT_MS,
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    await client.db(database).command({ ping: 1 });
    return { ok: true, message: `Connected to MongoDB and pinged "${database}".` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Same recoverable case as Postgres: a self-signed / private-CA Mongo (e.g. a
    // self-hosted replica set) fails chain verification. Flag it so the UI can
    // offer the toggle rather than leave the operator to decode the TLS error.
    if (!noVerify && isTlsCertVerificationError(err)) {
      return {
        ok: false,
        certError: true,
        message: `MongoDB rejected the probe: ${detail}. This database presents a self-signed or private-CA certificate. If you trust the network path to it, enable "Connect without certificate verification" below and test again.`,
      };
    }
    return { ok: false, message: `MongoDB rejected the probe: ${detail}` };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Connectivity-only probe for the New Source wizard's Destination step. Unlike
 * `testDestination` (used by the standalone destination form) this does NOT
 * require a table/database — in the pipeline wizard the table is chosen per
 * route later, so this just answers "can we reach it with these credentials?".
 *
 * Reads the wizard's field names (`new_destination_type` + `dest_field_*`) and
 * returns an ActionState so it can drive a `useActionState` Test button.
 */
export async function testNewDestinationConnection(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // The wizard's manual "Test connection" button shares one code path with the
  // automatic create-time gate — same probes, same messages, including the
  // BigQuery write check (which the old inline version skipped).
  const result = await preflightPipelineDestination(formData);
  // fail → error; warn/pass (and any legacy no-severity ok:false) → notice, so
  // an unverifiable-but-not-broken result reads as informational, not a wall.
  const isError = result.severity === "fail" || (!result.severity && !result.ok);
  return isError ? { error: result.message } : { notice: result.message };
}

function normalizeWorkspaceHost(input: string): string {
  return input.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

async function probeDatabricksSql(values: Record<string, string>): Promise<TestDestinationResult> {
  const host = normalizeWorkspaceHost(values.workspace_host ?? "");
  const warehouseId = values.warehouse_id;
  const token = values.access_token;
  if (!host) return { ok: false, message: "Missing workspace host." };
  const sqlSsrf = validateDestinationUrl(`https://${host}`);
  if (sqlSsrf) return { ok: false, message: sqlSsrf };
  if (!warehouseId) return { ok: false, message: "Missing SQL warehouse ID." };
  if (!token) return { ok: false, message: "Missing access token." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://${host}/api/2.0/sql/warehouses/${encodeURIComponent(warehouseId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: "Databricks rejected the access token (HTTP 401/403). Check the token has SQL Warehouse access and isn't expired.",
      };
    }
    if (res.status === 404) {
      return { ok: false, message: `Warehouse ${warehouseId} not found in this workspace.` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, message: `Databricks returned HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { state?: string; name?: string };
    const state = data.state ?? "UNKNOWN";
    const name = data.name ?? warehouseId;
    return {
      ok: true,
      message: `Connected. Warehouse "${name}" state: ${state}. Auto-starts on first query if STOPPED.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, message: `Databricks workspace ${host} unreachable after ${PROBE_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, message: `Databricks error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function probeDatabricksVolume(values: Record<string, string>): Promise<TestDestinationResult> {
  const host = normalizeWorkspaceHost(values.workspace_host ?? "");
  const catalog = values.catalog;
  const schemaName = values.schema_name;
  // `volume` is a per-route binding, NOT part of the databricks_volume
  // destination schema (which only has workspace_host/catalog/schema_name/
  // access_token) — so requiring it made Test Connection fail every time.
  // Treat it as optional: probe the specific volume when supplied, otherwise
  // verify the catalog/schema is reachable to the token.
  const volume = values.volume;
  const token = values.access_token;
  if (!host) return { ok: false, message: "Missing workspace host." };
  const volSsrf = validateDestinationUrl(`https://${host}`);
  if (volSsrf) return { ok: false, message: volSsrf };
  if (!catalog || !schemaName) {
    return { ok: false, message: "Missing catalog or schema." };
  }
  if (!token) return { ok: false, message: "Missing access token." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // The Unity Catalog volume metadata endpoint resolves the full name and
    // tells us up-front whether the token can see it. Cheaper and clearer
    // than poking the Files API listing endpoint. Without a volume, list the
    // schema's volumes to confirm token + catalog/schema visibility.
    const fullName = volume ? `${catalog}.${schemaName}.${volume}` : null;
    const url = fullName
      ? `https://${host}/api/2.1/unity-catalog/volumes/${encodeURIComponent(fullName)}`
      : `https://${host}/api/2.1/unity-catalog/volumes?catalog_name=${encodeURIComponent(catalog)}&schema_name=${encodeURIComponent(schemaName)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: "Databricks rejected the access token (HTTP 401/403). Token needs READ VOLUME on the volume; WRITE VOLUME for Axel to actually deliver.",
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: fullName
          ? `Volume "${fullName}" doesn't exist (or the token can't see it). Create it in the Catalog Explorer first.`
          : `Catalog/schema "${catalog}.${schemaName}" not found (or the token can't see it).`,
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, message: `Databricks returned HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return {
      ok: true,
      message: fullName
        ? `Connected. Volume "${fullName}" is visible to the token.`
        : `Connected to ${catalog}.${schemaName}. Token is valid; the per-route volume is checked at delivery.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, message: `Databricks workspace ${host} unreachable after ${PROBE_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, message: `Databricks error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function probeBigQuery(
  values: Record<string, string>,
  target?: BqTarget | null,
): Promise<TestDestinationResult> {
  const projectId = (values.project_id ?? "").trim();
  // Prefer the route target; fall back to a legacy dataset on the config.
  const dataset = (target?.dataset ?? values.dataset ?? "").trim();
  const table = (target?.table ?? values.table ?? "").trim();
  const saJson = values.service_account_json ?? "";
  if (!projectId) return { ok: false, severity: "fail", message: "Missing Project ID." };
  if (!saJson) return { ok: false, severity: "fail", message: "Missing service account key JSON." };

  let sa: ReturnType<typeof parseServiceAccountJson>;
  try {
    sa = parseServiceAccountJson(saJson);
  } catch (err) {
    return { ok: false, severity: "fail", message: err instanceof Error ? err.message : String(err) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Mint a token with the service-account key (same auth path the connector uses).
    let token: string;
    try {
      token = await mintGoogleAccessToken(sa, BIGQUERY_SCOPE);
    } catch (err) {
      return { ok: false, severity: "fail", message: err instanceof Error ? err.message : String(err) };
    }
    if (!dataset) {
      return {
        ok: true,
        severity: "pass",
        message:
          "BigQuery credentials accepted. Choose a target dataset.table on the route to check dataset access and write permission.",
      };
    }
    // Read check: can the SA see the dataset at all?
    const res = await fetch(
      `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset)}`,
      { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        severity: "fail",
        message: `The service account can't access dataset ${projectId}.${dataset} (HTTP ${res.status}). Grant it BigQuery Data Editor on the dataset, then retry.`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        severity: "fail",
        message: `Dataset ${projectId}.${dataset} not found (or the service account can't see it). Axel creates tables, not datasets — create the dataset in BigQuery first.`,
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, severity: "fail", message: `BigQuery returned HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    // Dataset is readable. Now the part that actually bit us: can it WRITE?
    if (!table) {
      return {
        ok: true,
        severity: "warn",
        message: `Dataset ${projectId}.${dataset} is reachable. Pick a table to verify write access.`,
      };
    }
    return await bqCheckWrite(token, projectId, dataset, table, controller.signal);
  } catch (err) {
    // Transient/unreachable — can't verify, but not a provable failure, so
    // "warn" (don't block a valid setup on a momentary blip).
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, severity: "warn", message: `Couldn't reach BigQuery within ${PROBE_TIMEOUT_MS / 1000}s to verify write access — check the destination if deliveries fail.` };
    }
    return { ok: false, severity: "warn", message: `Couldn't verify BigQuery write access: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify the service account can actually write to the target table — the
 * check the old probe skipped, which let a read-only (Data Viewer) key pass
 * setup and dead-letter every delivery.
 *
 * BigQuery has no dataset-level testIamPermissions, and table-level
 * testIamPermissions on a table that doesn't exist yet returns an EMPTY set
 * rather than the inherited permission. So we can only PROVE write access for
 * a table that already exists; for a not-yet-created table we return "warn"
 * (Axel creates it on first delivery, which needs Data Editor on the dataset —
 * unverifiable in advance) rather than a false green.
 */
async function bqCheckWrite(
  token: string,
  projectId: string,
  dataset: string,
  table: string,
  signal: AbortSignal,
): Promise<TestDestinationResult> {
  const base =
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}` +
    `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`;
  const fq = `${projectId}.${dataset}.${table}`;

  const permRes = await fetch(`${base}:testIamPermissions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ permissions: ["bigquery.tables.updateData"] }),
    signal,
  });
  if (permRes.ok) {
    const body = (await permRes.json().catch(() => ({}))) as { permissions?: string[] };
    if (body.permissions?.includes("bigquery.tables.updateData")) {
      return { ok: true, severity: "pass", message: `Verified: the service account can write to ${fq}.` };
    }
  }

  // Empty permission set is ambiguous — no write access, OR the table doesn't
  // exist yet. A GET disambiguates.
  const getRes = await fetch(base, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (getRes.status === 200) {
    return {
      ok: false,
      severity: "fail",
      message: `The service account can read but not write to ${fq} (missing bigquery.tables.updateData). Grant it BigQuery Data Editor on the ${dataset} dataset, then retry.`,
    };
  }
  if (getRes.status === 404) {
    return {
      ok: true,
      severity: "warn",
      message: `Credentials and dataset ${projectId}.${dataset} look good. The table "${table}" doesn't exist yet — Axel creates it on the first delivery, which needs BigQuery Data Editor on the dataset. That write permission can't be verified in advance for a table that doesn't exist, so double-check the role if deliveries fail.`,
    };
  }
  if (getRes.status === 401 || getRes.status === 403) {
    return {
      ok: false,
      severity: "fail",
      message: `The service account can't access table ${fq} (HTTP ${getRes.status}). Grant it BigQuery Data Editor on the ${dataset} dataset, then retry.`,
    };
  }
  const body = await getRes.text().catch(() => "");
  return {
    ok: false,
    severity: "fail",
    message: `BigQuery returned HTTP ${getRes.status} checking ${fq}: ${body.slice(0, 200)}`,
  };
}
