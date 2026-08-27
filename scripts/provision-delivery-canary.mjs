#!/usr/bin/env node
/**
 * Reconcile the isolated production delivery canary and its least-privilege
 * Postgres writer. Secrets are accepted only through environment variables.
 * This script never prints a query result, credential, token, hash, or DSN.
 *
 * Required environment variables:
 *   DATABASE_URL
 *   CREDENTIALS_MASTER_KEY
 *   AXEL_CANARY_SOURCE_TOKEN
 *   AXEL_CANARY_WRITER_PASSWORD
 *
 * Build @axel/shared before running so this script uses the same crypto, AAD,
 * SSRF, and TLS policy as the production runtimes.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CANARY_RESOURCES = Object.freeze({
  workspaceId: "ws_delivery_canary",
  workspaceName: "Axel production delivery canary",
  workspaceSlug: "axel-production-delivery-canary",
  sourceId: "src_delivery_canary",
  sourceName: "Production delivery canary",
  routeId: "route_delivery_canary",
  destinationId: "dst_delivery_canary_postgres",
  destinationName: "Production delivery canary receipts",
  credentialId: "cred_delivery_canary_postgres",
  roleName: "axel_delivery_canary_writer",
  receiptTable: "delivery_canary_receipts",
});

export const CANARY_BINDING = Object.freeze({
  table: CANARY_RESOURCES.receiptTable,
  mode: "jsonb_blob",
  payload_column: "payload",
});

const STRIPPED_CONNECTION_PARAMETERS = new Set([
  "options",
  "passfile",
  "password",
  "role",
  "service",
  "servicefile",
  "session_authorization",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslrootcert",
  "user",
]);

export class CanaryProvisionError extends Error {
  constructor(code) {
    super(code);
    this.name = "CanaryProvisionError";
    this.code = code;
  }
}

function fail(code) {
  throw new CanaryProvisionError(code);
}

function requireEnv(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) fail(`missing_env:${key}`);
  return value;
}

function assertSecretShape(value, key, { minBytes, maxBytes, pattern }) {
  const bytes = Buffer.byteLength(value, "utf8");
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (bytes < minBytes || bytes > maxBytes || hasControlCharacter) {
    fail(`invalid_env:${key}`);
  }
  if (pattern && !pattern.test(value)) fail(`invalid_env:${key}`);
}

/** Parse and validate required operator inputs without reading a dotenv file. */
export function readProvisionEnvironment(env) {
  const databaseUrl = requireEnv(env, "DATABASE_URL");
  const masterKey = requireEnv(env, "CREDENTIALS_MASTER_KEY");
  const sourceToken = requireEnv(env, "AXEL_CANARY_SOURCE_TOKEN");
  const writerPassword = requireEnv(env, "AXEL_CANARY_WRITER_PASSWORD");

  assertSecretShape(sourceToken, "AXEL_CANARY_SOURCE_TOKEN", {
    minBytes: 36,
    maxBytes: 132,
    pattern: /^axt_[A-Za-z0-9_-]{32,128}$/,
  });
  assertSecretShape(writerPassword, "AXEL_CANARY_WRITER_PASSWORD", {
    minBytes: 32,
    maxBytes: 256,
  });
  if (sourceToken === writerPassword || sourceToken === masterKey || writerPassword === masterKey) {
    fail("canary_secrets_must_be_distinct");
  }

  return {
    databaseUrl,
    masterKey,
    sourceToken,
    writerPassword,
    controlPlaneSslVerify: env.CONTROL_PLANE_DB_SSL_VERIFY,
  };
}

/**
 * Derive the destination DSN from DATABASE_URL without carrying the control
 * plane user, password, passfile, service, or role-switch options across.
 */
export function buildWriterConnectionString(databaseUrl, writerPassword) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("invalid_env:DATABASE_URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    fail("invalid_env:DATABASE_URL");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    fail("invalid_env:DATABASE_URL");
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (STRIPPED_CONNECTION_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.username = CANARY_RESOURCES.roleName;
  parsed.password = writerPassword;
  parsed.hash = "";
  parsed.searchParams.set("application_name", CANARY_RESOURCES.roleName);
  return parsed.toString();
}

/** Build the only payload shape accepted by migration 0073. */
export function buildVerificationPayload(now = new Date(), entropy = randomBytes(6).toString("hex")) {
  const seconds = Math.floor(now.getTime() / 1_000);
  if (!/^[0-9a-f]{12}$/.test(entropy)) fail("invalid_verification_entropy");
  return {
    event_type: "axel.delivery_canary",
    axel_canary_probe_id: `axel_canary_${seconds}_${entropy}`,
    sent_at: now.toISOString(),
    expected_runtime: "native",
  };
}

/** Use the production shared envelope code and bind it to the fixed row IDs. */
export async function buildEncryptedCredential(config, shared) {
  const writerConnectionString = buildWriterConnectionString(
    config.databaseUrl,
    config.writerPassword,
  );
  const ssrfReason = shared.connectionHostSsrfReason(writerConnectionString);
  if (ssrfReason) fail("database_url_not_safe_for_destination");

  const plaintext = JSON.stringify({ connection_string: writerConnectionString });
  const masterKey = shared.parseHexMasterKey(config.masterKey);
  try {
    const encrypted = await shared.encryptCredentialV2(
      plaintext,
      masterKey,
      shared.credentialAadString(
        CANARY_RESOURCES.workspaceId,
        CANARY_RESOURCES.destinationId,
      ),
    );
    if (encrypted.encryption_version !== 2) fail("credential_encryption_not_v2");
    const digest = createHash("sha256").update(plaintext).digest("hex");
    return {
      writerConnectionString,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.auth_tag),
      encryptionVersion: encrypted.encryption_version,
      fingerprintLast4: plaintext.slice(-4),
      fingerprintSha256Prefix: digest.slice(0, 8),
    };
  } finally {
    masterKey.fill(0);
  }
}

function assertBooleanRow(row, keys, code) {
  if (!row || keys.some((key) => row[key] !== true)) fail(code);
}

function assertIdentity(rows, expected, code) {
  if (rows.length === 0) return;
  if (rows.length !== 1) fail(code);
  const row = rows[0];
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) fail(code);
  }
}

async function assertResourceIdentities(client) {
  const workspace = await client.query(
    `/* canary:identity-workspace */
     SELECT id, name, slug, stripe_customer_id, stripe_subscription_id
       FROM workspaces
      WHERE id = $1 OR slug = $2
      FOR UPDATE`,
    [CANARY_RESOURCES.workspaceId, CANARY_RESOURCES.workspaceSlug],
  );
  assertIdentity(
    workspace.rows,
    {
      id: CANARY_RESOURCES.workspaceId,
      name: CANARY_RESOURCES.workspaceName,
      slug: CANARY_RESOURCES.workspaceSlug,
      stripe_customer_id: null,
      stripe_subscription_id: null,
    },
    "workspace_identity_collision",
  );

  const source = await client.query(
    `/* canary:identity-source */
     SELECT id, workspace_id, name
       FROM sources
      WHERE id = $1
         OR (workspace_id = $2 AND lower(name) = lower($3))
      FOR UPDATE`,
    [CANARY_RESOURCES.sourceId, CANARY_RESOURCES.workspaceId, CANARY_RESOURCES.sourceName],
  );
  assertIdentity(
    source.rows,
    {
      id: CANARY_RESOURCES.sourceId,
      workspace_id: CANARY_RESOURCES.workspaceId,
      name: CANARY_RESOURCES.sourceName,
    },
    "source_identity_collision",
  );

  const route = await client.query(
    `/* canary:identity-route */
     SELECT id, workspace_id, source_id
       FROM routes
      WHERE id = $1
      FOR UPDATE`,
    [CANARY_RESOURCES.routeId],
  );
  assertIdentity(
    route.rows,
    {
      id: CANARY_RESOURCES.routeId,
      workspace_id: CANARY_RESOURCES.workspaceId,
      source_id: CANARY_RESOURCES.sourceId,
    },
    "route_identity_collision",
  );

  const destination = await client.query(
    `/* canary:identity-destination */
     SELECT id, workspace_id, name, type
       FROM destinations
      WHERE id = $1
         OR (workspace_id = $2 AND lower(name) = lower($3))
      FOR UPDATE`,
    [
      CANARY_RESOURCES.destinationId,
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.destinationName,
    ],
  );
  assertIdentity(
    destination.rows,
    {
      id: CANARY_RESOURCES.destinationId,
      workspace_id: CANARY_RESOURCES.workspaceId,
      name: CANARY_RESOURCES.destinationName,
      type: "postgres",
    },
    "destination_identity_collision",
  );

  const credential = await client.query(
    `/* canary:identity-credential */
     SELECT id, workspace_id, destination_id
       FROM destination_credentials
      WHERE id = $1
      FOR UPDATE`,
    [CANARY_RESOURCES.credentialId],
  );
  assertIdentity(
    credential.rows,
    {
      id: CANARY_RESOURCES.credentialId,
      workspace_id: CANARY_RESOURCES.workspaceId,
      destination_id: CANARY_RESOURCES.destinationId,
    },
    "credential_identity_collision",
  );

  const isolation = await client.query(
    `/* canary:identity-isolation */
     SELECT
       NOT EXISTS (
         SELECT 1 FROM workspace_members WHERE workspace_id = $1
       ) AS no_members,
       NOT EXISTS (
         SELECT 1 FROM sources WHERE workspace_id = $1 AND id <> $2
       ) AS no_other_sources,
       NOT EXISTS (
         SELECT 1 FROM routes WHERE workspace_id = $1 AND id <> $3
       ) AS no_other_routes,
       NOT EXISTS (
         SELECT 1 FROM destinations WHERE workspace_id = $1 AND id <> $4
       ) AS no_other_destinations,
       NOT EXISTS (
         SELECT 1
           FROM route_destinations
          WHERE (route_id = $3 AND destination_id <> $4)
             OR (destination_id = $4 AND route_id <> $3)
       ) AS no_other_bindings`,
    [
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.sourceId,
      CANARY_RESOURCES.routeId,
      CANARY_RESOURCES.destinationId,
    ],
  );
  assertBooleanRow(
    isolation.rows[0],
    [
      "no_members",
      "no_other_sources",
      "no_other_routes",
      "no_other_destinations",
      "no_other_bindings",
    ],
    "canary_workspace_not_isolated",
  );
}

async function assertSchemaReady(client) {
  const result = await client.query(
    `/* canary:schema-preflight */
     SELECT
       to_regclass('public.delivery_canary_receipts') IS NOT NULL AS table_exists,
       EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'delivery_canary_receipts'
            AND column_name = 'payload'
            AND data_type = 'jsonb'
            AND is_nullable = 'NO'
       ) AS payload_column_ok,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.delivery_canary_receipts')
            AND conname = 'delivery_canary_receipts_shape_check'
            AND convalidated
       ) AS shape_check_ok,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.delivery_canary_receipts')
            AND conname = 'delivery_canary_receipts_size_check'
            AND convalidated
       ) AS size_check_ok`,
  );
  assertBooleanRow(
    result.rows[0],
    ["table_exists", "payload_column_ok", "shape_check_ok", "size_check_ok"],
    "migration_0073_not_ready",
  );
}

async function assertRoleOwnsNoObjects(client) {
  const result = await client.query(
    `/* canary:role-ownership-preflight */
     SELECT NOT EXISTS (
       SELECT 1
         FROM pg_roles r
        WHERE r.rolname = $1
          AND (
            EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)
            OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
            OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
            OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid)
            OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid)
          )
     ) AS owns_nothing`,
    [CANARY_RESOURCES.roleName],
  );
  assertBooleanRow(result.rows[0], ["owns_nothing"], "canary_role_owns_database_objects");
}

async function assertRoleHasSafeSecurityAttributes(client) {
  const result = await client.query(
    `/* canary:role-attributes-preflight */
     SELECT NOT COALESCE(
       bool_or(
         rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
       ),
       false
     ) AS security_attributes_ok
       FROM pg_roles
      WHERE rolname = $1`,
    [CANARY_RESOURCES.roleName],
  );
  assertBooleanRow(
    result.rows[0],
    ["security_attributes_ok"],
    "canary_role_has_forbidden_security_attributes",
  );
}

async function reconcileRole(client, writerPassword, passwordState) {
  await assertRoleOwnsNoObjects(client);
  // Managed Postgres operators commonly have CREATEROLE without superuser.
  // PostgreSQL allows secure attributes on CREATE ROLE, but even a no-op
  // ALTER ... NOSUPERUSER/NOREPLICATION/NOBYPASSRLS requires superuser, and
  // ALTER ... NOCREATEDB requires CREATEDB. Fail closed above if an existing
  // role has any protected attribute, then avoid asking the provider for
  // privileges the operator should not have.
  await assertRoleHasSafeSecurityAttributes(client);
  await client.query(
    `DO $canary_role$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'axel_delivery_canary_writer') THEN
         CREATE ROLE axel_delivery_canary_writer
           LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
           NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
       END IF;
     END
     $canary_role$`,
  );

  await client.query(
    `DO $canary_memberships$
     DECLARE membership record;
     BEGIN
       FOR membership IN
         SELECT parent.rolname AS parent_name
          FROM pg_auth_members m
          JOIN pg_roles parent ON parent.oid = m.roleid
          JOIN pg_roles child ON child.oid = m.member
          WHERE child.rolname = 'axel_delivery_canary_writer'
            AND m.grantor = current_user::regrole
       LOOP
         EXECUTE format(
           'REVOKE %I FROM axel_delivery_canary_writer',
           membership.parent_name
         );
       END LOOP;

       FOR membership IN
         SELECT child.rolname AS child_name
          FROM pg_auth_members m
          JOIN pg_roles parent ON parent.oid = m.roleid
          JOIN pg_roles child ON child.oid = m.member
          WHERE parent.rolname = 'axel_delivery_canary_writer'
            AND m.grantor = current_user::regrole
       LOOP
         EXECUTE format(
           'REVOKE axel_delivery_canary_writer FROM %I',
           membership.child_name
         );
       END LOOP;
     END
     $canary_memberships$`,
  );

  await client.query(
    `ALTER ROLE axel_delivery_canary_writer
       LOGIN NOCREATEROLE NOINHERIT
       CONNECTION LIMIT 4 VALID UNTIL 'infinity'`,
  );
  await client.query("ALTER ROLE axel_delivery_canary_writer RESET ALL");
  await client.query(
    `DO $canary_role_settings$
     DECLARE target_database record;
     BEGIN
       FOR target_database IN
         SELECT d.datname
           FROM pg_db_role_setting s
           JOIN pg_roles r ON r.oid = s.setrole
           JOIN pg_database d ON d.oid = s.setdatabase
          WHERE r.rolname = 'axel_delivery_canary_writer'
       LOOP
         EXECUTE format(
           'ALTER ROLE axel_delivery_canary_writer IN DATABASE %I RESET ALL',
           target_database.datname
         );
       END LOOP;
     END
     $canary_role_settings$`,
  );
  await client.query(
    "ALTER ROLE axel_delivery_canary_writer SET search_path = pg_catalog, public",
  );
  await client.query("ALTER ROLE axel_delivery_canary_writer SET statement_timeout = '10s'");
  await client.query(
    "ALTER ROLE axel_delivery_canary_writer SET idle_in_transaction_session_timeout = '15s'",
  );

  passwordState.active = true;
  const configured = await client.query(
    `SELECT octet_length(
       set_config('axel.canary_role_password', $1, false)
     ) > 0 AS configured`,
    [writerPassword],
  );
  assertBooleanRow(configured.rows[0], ["configured"], "role_password_handoff_failed");
  await client.query(
    `DO $canary_password$
     DECLARE role_password text := current_setting('axel.canary_role_password', true);
     BEGIN
       IF role_password IS NULL OR octet_length(role_password) < 32 THEN
         RAISE EXCEPTION 'canary role password is unavailable';
       END IF;
       EXECUTE format(
         'ALTER ROLE axel_delivery_canary_writer PASSWORD %L',
         role_password
       );
     END
     $canary_password$`,
  );
  const cleared = await client.query(
    `SELECT set_config('axel.canary_role_password', '', false) = '' AS cleared`,
  );
  passwordState.active = false;
  assertBooleanRow(cleared.rows[0], ["cleared"], "role_password_clear_failed");

  await client.query(
    `DO $canary_privileges$
     DECLARE target record;
     BEGIN
       FOR target IN
         SELECT DISTINCT d.datname
           FROM pg_database d
           CROSS JOIN LATERAL aclexplode(
             COALESCE(d.datacl, acldefault('d', d.datdba))
           ) acl
           JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname = 'axel_delivery_canary_writer'
       LOOP
         EXECUTE format(
           'REVOKE ALL PRIVILEGES ON DATABASE %I FROM axel_delivery_canary_writer',
           target.datname
         );
       END LOOP;

       FOR target IN
         SELECT nspname
           FROM pg_namespace
          WHERE nspname !~ '^pg_'
            AND nspname <> 'information_schema'
       LOOP
         EXECUTE format(
           'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM axel_delivery_canary_writer',
           target.nspname
         );
         EXECUTE format(
           'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM axel_delivery_canary_writer',
           target.nspname
         );
         EXECUTE format(
           'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM axel_delivery_canary_writer',
           target.nspname
         );
         EXECUTE format(
           'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM axel_delivery_canary_writer',
           target.nspname
         );
       END LOOP;

       EXECUTE format(
         'GRANT CONNECT ON DATABASE %I TO axel_delivery_canary_writer',
         current_database()
       );
     END
     $canary_privileges$`,
  );
  await client.query("GRANT USAGE ON SCHEMA public TO axel_delivery_canary_writer");
  await client.query(
    `GRANT INSERT (payload) ON TABLE public.delivery_canary_receipts
       TO axel_delivery_canary_writer`,
  );
}

async function clearPasswordSetting(client, passwordState) {
  if (!passwordState.active) return;
  try {
    await client.query("SELECT set_config('axel.canary_role_password', '', false)");
  } catch {
    // Closing the connection below clears the session-local custom setting.
  }
  passwordState.active = false;
}

async function reconcileControlPlaneResources(client, sourceTokenHash, credential) {
  await client.query(
    `INSERT INTO workspaces
       (id, name, slug, timezone, raw_payload_retention_days,
        dead_letter_retention_days, replay_request_retention_days,
        audit_log_retention_days, billing_exempt, status, plan, billing_status)
     VALUES ($1, $2, $3, 'UTC', 1, 7, 7, 30, true, 'active', 'free', 'ok')
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       slug = EXCLUDED.slug,
       timezone = EXCLUDED.timezone,
       raw_payload_retention_days = EXCLUDED.raw_payload_retention_days,
       dead_letter_retention_days = EXCLUDED.dead_letter_retention_days,
       replay_request_retention_days = EXCLUDED.replay_request_retention_days,
       audit_log_retention_days = EXCLUDED.audit_log_retention_days,
       billing_exempt = EXCLUDED.billing_exempt,
       status = EXCLUDED.status,
       plan = EXCLUDED.plan,
       billing_status = EXCLUDED.billing_status,
       suspended_at = NULL,
       suspended_by_user_id = NULL,
       suspension_reason = NULL,
       deleted_at = NULL,
       usage_flushed_at = NULL`,
    [
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.workspaceName,
      CANARY_RESOURCES.workspaceSlug,
    ],
  );

  await client.query(
    `INSERT INTO sources
       (id, workspace_id, name, secret_token_hash, status, provider,
        signing_secret_ciphertext, signing_secret_fingerprint,
        signing_secret_previous_ciphertext, signing_secret_previous_fingerprint,
        signing_secret_rotated_at, transient_mode, raw_payload_retention_days,
        max_body_bytes, max_body_depth, max_events_per_minute,
        inbound_ip_allowlist, ordering_enabled, ordering_key_header,
        ordering_key_path, subject_key_paths, subject_indexing_active_since,
        redact_paths, field_selection)
     VALUES
       ($1, $2, $3, $4, 'active', 'custom',
        NULL, NULL, NULL, NULL, NULL, true, 0,
        2048, 8, 12, '{}', false, NULL, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       name = EXCLUDED.name,
       secret_token_hash = EXCLUDED.secret_token_hash,
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       signing_secret_ciphertext = NULL,
       signing_secret_fingerprint = NULL,
       signing_secret_previous_ciphertext = NULL,
       signing_secret_previous_fingerprint = NULL,
       signing_secret_rotated_at = NULL,
       transient_mode = true,
       raw_payload_retention_days = 0,
       max_body_bytes = EXCLUDED.max_body_bytes,
       max_body_depth = EXCLUDED.max_body_depth,
       max_events_per_minute = EXCLUDED.max_events_per_minute,
       inbound_ip_allowlist = '{}',
       ordering_enabled = false,
       ordering_key_header = NULL,
       ordering_key_path = NULL,
       subject_key_paths = NULL,
       subject_indexing_active_since = NULL,
       redact_paths = NULL,
       field_selection = NULL,
       updated_at = now()`,
    [
      CANARY_RESOURCES.sourceId,
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.sourceName,
      sourceTokenHash,
    ],
  );

  await client.query(
    `INSERT INTO routes
       (id, workspace_id, source_id, status, engine, filter_expression,
        transform_script, pipeline_graph, error_reason, error_message)
     VALUES ($1, $2, $3, 'active', 'declarative', NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       source_id = EXCLUDED.source_id,
       status = 'active',
       engine = 'declarative',
       filter_expression = NULL,
       transform_script = NULL,
       pipeline_graph = NULL,
       error_reason = NULL,
       error_message = NULL,
       updated_at = now()`,
    [CANARY_RESOURCES.routeId, CANARY_RESOURCES.workspaceId, CANARY_RESOURCES.sourceId],
  );

  await client.query(
    `INSERT INTO destinations
       (id, workspace_id, type, name, config, credentials_ref, status,
        circuit_state, circuit_opened_at, circuit_half_open_at,
        circuit_consecutive_failures, delivery_paused, delivery_paused_at,
        delivery_paused_reason, retry_after_until)
     VALUES ($1, $2, 'postgres', $3, '{}'::jsonb, NULL, 'active',
             'closed', NULL, NULL, 0, false, NULL, NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       type = 'postgres',
       name = EXCLUDED.name,
       config = '{}'::jsonb,
       status = 'active',
       circuit_state = 'closed',
       circuit_opened_at = NULL,
       circuit_half_open_at = NULL,
       circuit_consecutive_failures = 0,
       delivery_paused = false,
       delivery_paused_at = NULL,
       delivery_paused_reason = NULL,
       retry_after_until = NULL,
       updated_at = now()`,
    [
      CANARY_RESOURCES.destinationId,
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.destinationName,
    ],
  );

  await client.query(
    `INSERT INTO destination_credentials
       (id, destination_id, workspace_id, ciphertext, nonce, auth_tag,
        fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       destination_id = EXCLUDED.destination_id,
       workspace_id = EXCLUDED.workspace_id,
       ciphertext = EXCLUDED.ciphertext,
       nonce = EXCLUDED.nonce,
       auth_tag = EXCLUDED.auth_tag,
       fingerprint_last4 = EXCLUDED.fingerprint_last4,
       fingerprint_sha256_prefix = EXCLUDED.fingerprint_sha256_prefix,
       encryption_version = EXCLUDED.encryption_version,
       created_at = now()`,
    [
      CANARY_RESOURCES.credentialId,
      CANARY_RESOURCES.destinationId,
      CANARY_RESOURCES.workspaceId,
      credential.ciphertext,
      credential.nonce,
      credential.authTag,
      credential.fingerprintLast4,
      credential.fingerprintSha256Prefix,
      credential.encryptionVersion,
    ],
  );
  await client.query(
    `UPDATE destinations
        SET credentials_ref = $1, updated_at = now()
      WHERE id = $2 AND workspace_id = $3`,
    [
      CANARY_RESOURCES.credentialId,
      CANARY_RESOURCES.destinationId,
      CANARY_RESOURCES.workspaceId,
    ],
  );
  await client.query(
    `DELETE FROM destination_credentials
      WHERE destination_id = $1 AND id <> $2`,
    [CANARY_RESOURCES.destinationId, CANARY_RESOURCES.credentialId],
  );

  await client.query(
    `INSERT INTO route_destinations (route_id, destination_id, binding)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (route_id, destination_id) DO UPDATE SET
       binding = EXCLUDED.binding`,
    [
      CANARY_RESOURCES.routeId,
      CANARY_RESOURCES.destinationId,
      JSON.stringify(CANARY_BINDING),
    ],
  );
}

async function assertReconciledState(client, sourceTokenHash, credential) {
  const state = await client.query(
    `/* canary:state-verification */
     SELECT
       EXISTS (
         SELECT 1 FROM workspaces
          WHERE id = $1 AND name = $2 AND slug = $3
            AND timezone = 'UTC' AND raw_payload_retention_days = 1
            AND dead_letter_retention_days = 7
            AND replay_request_retention_days = 7
            AND audit_log_retention_days = 30
            AND billing_exempt AND status = 'active'
            AND plan = 'free' AND billing_status = 'ok'
            AND stripe_customer_id IS NULL
            AND stripe_subscription_id IS NULL
            AND suspended_at IS NULL AND deleted_at IS NULL
       ) AS workspace_ok,
       EXISTS (
         SELECT 1 FROM sources
          WHERE id = $4 AND workspace_id = $1 AND name = $5
            AND secret_token_hash = $6 AND status = 'active'
            AND provider = 'custom' AND transient_mode
            AND raw_payload_retention_days = 0
            AND signing_secret_ciphertext IS NULL
            AND signing_secret_previous_ciphertext IS NULL
       ) AS source_ok,
       EXISTS (
         SELECT 1 FROM routes
          WHERE id = $7 AND workspace_id = $1 AND source_id = $4
            AND status = 'active' AND engine = 'declarative'
            AND filter_expression IS NULL AND transform_script IS NULL
            AND pipeline_graph IS NULL
       ) AS route_ok,
       EXISTS (
         SELECT 1 FROM destinations
          WHERE id = $8 AND workspace_id = $1 AND name = $9
            AND type = 'postgres' AND config = '{}'::jsonb
            AND credentials_ref = $10 AND status = 'active'
            AND circuit_state = 'closed' AND NOT delivery_paused
       ) AS destination_ok,
       EXISTS (
         SELECT 1 FROM destination_credentials
          WHERE id = $10 AND destination_id = $8 AND workspace_id = $1
            AND encryption_version = 2
            AND fingerprint_last4 = $11
            AND fingerprint_sha256_prefix = $12
       ) AS credential_ok,
       NOT EXISTS (
         SELECT 1 FROM destination_credentials
          WHERE destination_id = $8 AND id <> $10
       ) AS no_stale_credentials,
       EXISTS (
         SELECT 1 FROM route_destinations
          WHERE route_id = $7 AND destination_id = $8
            AND binding = $13::jsonb
       ) AS binding_ok`,
    [
      CANARY_RESOURCES.workspaceId,
      CANARY_RESOURCES.workspaceName,
      CANARY_RESOURCES.workspaceSlug,
      CANARY_RESOURCES.sourceId,
      CANARY_RESOURCES.sourceName,
      sourceTokenHash,
      CANARY_RESOURCES.routeId,
      CANARY_RESOURCES.destinationId,
      CANARY_RESOURCES.destinationName,
      CANARY_RESOURCES.credentialId,
      credential.fingerprintLast4,
      credential.fingerprintSha256Prefix,
      JSON.stringify(CANARY_BINDING),
    ],
  );
  assertBooleanRow(
    state.rows[0],
    [
      "workspace_ok",
      "source_ok",
      "route_ok",
      "destination_ok",
      "credential_ok",
      "no_stale_credentials",
      "binding_ok",
    ],
    "canary_state_verification_failed",
  );
}

async function assertRolePrivileges(client) {
  const result = await client.query(
    `/* canary:role-verification */
     SELECT
       EXISTS (
         SELECT 1 FROM pg_roles
          WHERE rolname = $1 AND rolcanlogin
            AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
            AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
            AND rolconnlimit = 4
       ) AS attributes_ok,
       NOT EXISTS (
         -- PostgreSQL 16 records an ADMIN-only membership for the non-superuser
         -- creator. The edge itself does not confer SET/INHERIT access and may
         -- be granted by the provider superuser, so the operator cannot revoke
         -- it. The operator remains in the trusted database-admin boundary and
         -- can administer the role. No other membership edge is accepted.
         SELECT 1
           FROM pg_auth_members m
           JOIN pg_roles parent ON parent.oid = m.roleid
           JOIN pg_roles child ON child.oid = m.member
           JOIN pg_roles grantor ON grantor.oid = m.grantor
          WHERE (parent.rolname = $1 OR child.rolname = $1)
            AND NOT (
              parent.rolname = $1
              AND child.oid = current_user::regrole
              AND m.admin_option
              AND NOT m.inherit_option
              AND NOT m.set_option
              AND grantor.rolsuper
            )
       ) AS memberships_safe,
       NOT EXISTS (
         SELECT 1
           FROM pg_database d
           CROSS JOIN LATERAL aclexplode(
             COALESCE(d.datacl, acldefault('d', d.datdba))
           ) acl
           JOIN pg_roles grantee ON grantee.oid = acl.grantee
          WHERE grantee.rolname = $1
            AND (
              d.datname <> current_database()
              OR acl.privilege_type <> 'CONNECT'
              OR acl.is_grantable
            )
       ) AS only_current_direct_database_connect,
       has_database_privilege($1::text, current_database(), 'CONNECT') AS can_connect,
       has_schema_privilege($1::text, 'public', 'USAGE') AS can_use_public,
       NOT has_schema_privilege($1::text, 'public', 'CREATE') AS cannot_create_in_public,
       has_column_privilege(
         $1::text, 'public.delivery_canary_receipts', 'payload', 'INSERT'
       ) AS can_insert_payload,
       NOT has_column_privilege(
         $1::text, 'public.delivery_canary_receipts', 'received_at', 'INSERT'
       ) AS cannot_insert_received_at,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'SELECT'
       ) AS cannot_select_receipts,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'UPDATE'
       ) AS cannot_update_receipts,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'DELETE'
       ) AS cannot_delete_receipts,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'TRUNCATE'
       ) AS cannot_truncate_receipts,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'REFERENCES'
       ) AS cannot_reference_receipts,
       NOT has_table_privilege(
         $1::text, 'public.delivery_canary_receipts', 'TRIGGER'
       ) AS cannot_trigger_receipts,
       NOT EXISTS (
         SELECT 1
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname !~ '^pg_'
            AND n.nspname <> 'information_schema'
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND c.oid <> 'public.delivery_canary_receipts'::regclass
            AND (
              has_table_privilege($1::text, c.oid, 'SELECT')
              OR has_table_privilege($1::text, c.oid, 'INSERT')
              OR has_table_privilege($1::text, c.oid, 'UPDATE')
              OR has_table_privilege($1::text, c.oid, 'DELETE')
              OR has_table_privilege($1::text, c.oid, 'TRUNCATE')
              OR has_table_privilege($1::text, c.oid, 'REFERENCES')
              OR has_table_privilege($1::text, c.oid, 'TRIGGER')
              OR has_any_column_privilege($1::text, c.oid, 'SELECT')
              OR has_any_column_privilege($1::text, c.oid, 'INSERT')
              OR has_any_column_privilege($1::text, c.oid, 'UPDATE')
              OR has_any_column_privilege($1::text, c.oid, 'REFERENCES')
            )
       ) AS no_other_user_relation_access,
       NOT EXISTS (
         SELECT 1
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname !~ '^pg_'
            AND n.nspname <> 'information_schema'
            AND p.prosecdef
            AND has_function_privilege($1::text, p.oid, 'EXECUTE')
       ) AS no_security_definer_execute`,
    [CANARY_RESOURCES.roleName],
  );
  assertBooleanRow(
    result.rows[0],
    [
      "attributes_ok",
      "memberships_safe",
      "only_current_direct_database_connect",
      "can_connect",
      "can_use_public",
      "cannot_create_in_public",
      "can_insert_payload",
      "cannot_insert_received_at",
      "cannot_select_receipts",
      "cannot_update_receipts",
      "cannot_delete_receipts",
      "cannot_truncate_receipts",
      "cannot_reference_receipts",
      "cannot_trigger_receipts",
      "no_other_user_relation_access",
      "no_security_definer_execute",
    ],
    "canary_role_privilege_verification_failed",
  );
}

/** Reconcile all admin-owned state under one advisory-locked transaction. */
export async function reconcileCanaryAdminState(client, config, credential) {
  const sourceTokenHash = createHash("sha256").update(config.sourceToken).digest("hex");
  const passwordState = { active: false };
  let transactionOpen = false;
  let stage = "begin";
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('axel:provision-delivery-canary:v1'))",
    );

    stage = "schema_preflight";
    await assertSchemaReady(client);
    stage = "identity_preflight";
    await assertResourceIdentities(client);
    stage = "role_reconciliation";
    await reconcileRole(client, config.writerPassword, passwordState);
    stage = "resource_reconciliation";
    await reconcileControlPlaneResources(client, sourceTokenHash, credential);
    stage = "state_verification";
    await assertReconciledState(client, sourceTokenHash, credential);
    stage = "role_verification";
    await assertRolePrivileges(client);
    stage = "commit";
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    await clearPasswordSetting(client, passwordState);
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof CanaryProvisionError) throw error;
    fail(`${stage}_failed`);
  }
}

async function expectInsufficientPrivilege(client, sql, params = []) {
  await client.query("SAVEPOINT canary_expected_denial");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT canary_expected_denial");
    await client.query("RELEASE SAVEPOINT canary_expected_denial");
    if (error && typeof error === "object" && error.code === "42501") return;
    fail("writer_denial_check_unexpected_error");
  }
  await client.query("ROLLBACK TO SAVEPOINT canary_expected_denial");
  await client.query("RELEASE SAVEPOINT canary_expected_denial");
  fail("writer_has_excess_privilege");
}

/**
 * Verify login, a valid INSERT, and denied operations without committing a row
 * or selecting any payload/control-plane data.
 */
export async function verifyWriterClient(client, payload = buildVerificationPayload()) {
  let transactionOpen = false;
  let stage = "writer_connect";
  try {
    await client.connect();
    stage = "writer_identity";
    const identity = await client.query("SELECT current_user = $1 AS correct_role", [
      CANARY_RESOURCES.roleName,
    ]);
    assertBooleanRow(identity.rows[0], ["correct_role"], "writer_identity_mismatch");

    await client.query("BEGIN");
    transactionOpen = true;
    stage = "writer_insert";
    await client.query(
      "INSERT INTO public.delivery_canary_receipts (payload) VALUES ($1::jsonb)",
      [JSON.stringify(payload)],
    );

    stage = "writer_denials";
    await expectInsufficientPrivilege(
      client,
      "SELECT 1 FROM public.delivery_canary_receipts WHERE false",
    );
    await expectInsufficientPrivilege(client, "SELECT 1 FROM public.workspaces WHERE false");
    await expectInsufficientPrivilege(client, "SELECT 1 FROM public.sources WHERE false");
    await expectInsufficientPrivilege(
      client,
      "SELECT 1 FROM public.destination_credentials WHERE false",
    );
    await expectInsufficientPrivilege(
      client,
      "UPDATE public.delivery_canary_receipts SET received_at = now() WHERE false",
    );
    await expectInsufficientPrivilege(
      client,
      "DELETE FROM public.delivery_canary_receipts WHERE false",
    );
    await expectInsufficientPrivilege(
      client,
      `INSERT INTO public.workspaces (id, name)
       SELECT 'ws_canary_privilege_probe', 'canary privilege probe'
       WHERE false`,
    );
    await client.query("ROLLBACK");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof CanaryProvisionError) throw error;
    fail(`${stage}_failed`);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runProvision(config, runtime) {
  const credential = await buildEncryptedCredential(config, runtime.shared);
  const adminClient = new runtime.Client({
    connectionString: config.databaseUrl,
    ssl: runtime.shared.controlPlanePgSslOption(
      config.databaseUrl,
      config.controlPlaneSslVerify,
    ),
    connectionTimeoutMillis: 10_000,
  });
  try {
    await adminClient.connect();
    await reconcileCanaryAdminState(adminClient, config, credential);
  } catch (error) {
    if (error instanceof CanaryProvisionError) throw error;
    fail("control_plane_connection_failed");
  } finally {
    await adminClient.end().catch(() => {});
  }

  const writerClient = new runtime.Client({
    connectionString: credential.writerConnectionString,
    ssl: runtime.shared.pgSslOption(credential.writerConnectionString),
    connectionTimeoutMillis: 10_000,
  });
  await verifyWriterClient(writerClient);
}

async function loadRuntime() {
  const require = createRequire(path.join(REPO_ROOT, "apps/dashboard/package.json"));
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    fail("pg_dependency_unavailable");
  }

  let shared;
  try {
    shared = await import(
      pathToFileURL(path.join(REPO_ROOT, "packages/shared/dist/index.js")).href
    );
  } catch {
    fail("shared_build_unavailable");
  }
  for (const name of [
    "connectionHostSsrfReason",
    "controlPlanePgSslOption",
    "credentialAadString",
    "encryptCredentialV2",
    "parseHexMasterKey",
    "pgSslOption",
  ]) {
    if (typeof shared[name] !== "function") fail("shared_build_incomplete");
  }
  return { Client, shared };
}

async function main() {
  if (process.argv.length !== 2) fail("arguments_not_supported_use_environment");
  const config = readProvisionEnvironment(process.env);
  const runtime = await loadRuntime();
  await runProvision(config, runtime);
  console.log("[provision-delivery-canary] reconciled and verified isolated canary");
}

const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedDirectly) {
  main().catch((error) => {
    const code = error instanceof CanaryProvisionError ? error.code : "provision_failed";
    console.error(`[provision-delivery-canary] ${code}`);
    process.exitCode = 1;
  });
}
