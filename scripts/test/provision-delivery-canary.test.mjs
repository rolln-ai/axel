import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CANARY_BINDING,
  CANARY_RESOURCES,
  CanaryProvisionError,
  buildEncryptedCredential,
  buildVerificationPayload,
  buildWriterConnectionString,
  readProvisionEnvironment,
  reconcileCanaryAdminState,
  verifyWriterClient,
} from "../provision-delivery-canary.mjs";

const fixture = Object.freeze({
  databaseUrl: `postgresql://control:${["admin", "fixture", "password"].join("-")}@db.example.test/axel?sslmode=verify-full&options=-c%20role%3Downer&user=owner`,
  masterKey: ["ab", "cd"].join("").repeat(16),
  sourceToken: `axt_${"sourcefixture".repeat(4)}`,
  writerPassword: ["writer", "fixture", "password", "long", "enough"].join("-"),
});

function config(overrides = {}) {
  return {
    databaseUrl: fixture.databaseUrl,
    masterKey: fixture.masterKey,
    sourceToken: fixture.sourceToken,
    writerPassword: fixture.writerPassword,
    controlPlaneSslVerify: "true",
    ...overrides,
  };
}

function credential() {
  return {
    writerConnectionString: buildWriterConnectionString(
      fixture.databaseUrl,
      fixture.writerPassword,
    ),
    ciphertext: Buffer.from([1, 2, 3]),
    nonce: Buffer.alloc(12, 4),
    authTag: Buffer.alloc(16, 5),
    encryptionVersion: 2,
    fingerprintLast4: "safe",
    fingerprintSha256Prefix: "0123abcd",
  };
}

function allTrue(keys) {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

class FakeAdminClient {
  constructor({
    existing = false,
    collision = null,
    ownsObjects = false,
    forbiddenRoleAttributes = false,
    rolePrivilegeOverrides = {},
  } = {}) {
    this.existing = existing;
    this.collision = collision;
    this.ownsObjects = ownsObjects;
    this.forbiddenRoleAttributes = forbiddenRoleAttributes;
    this.rolePrivilegeOverrides = rolePrivilegeOverrides;
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes("canary:schema-preflight")) {
      return {
        rows: [
          allTrue(["table_exists", "payload_column_ok", "shape_check_ok", "size_check_ok"]),
        ],
      };
    }
    if (sql.includes("canary:identity-workspace")) {
      if (this.collision === "workspace") {
        return { rows: [{ id: "ws_someone_else", name: "Other", slug: CANARY_RESOURCES.workspaceSlug }] };
      }
      return {
        rows: this.existing
          ? [{
              id: CANARY_RESOURCES.workspaceId,
              name: CANARY_RESOURCES.workspaceName,
              slug: CANARY_RESOURCES.workspaceSlug,
              stripe_customer_id: null,
              stripe_subscription_id: null,
            }]
          : [],
      };
    }
    if (sql.includes("canary:identity-source")) {
      return {
        rows: this.existing
          ? [{
              id: CANARY_RESOURCES.sourceId,
              workspace_id: CANARY_RESOURCES.workspaceId,
              name: CANARY_RESOURCES.sourceName,
            }]
          : [],
      };
    }
    if (sql.includes("canary:identity-route")) {
      return {
        rows: this.existing
          ? [{
              id: CANARY_RESOURCES.routeId,
              workspace_id: CANARY_RESOURCES.workspaceId,
              source_id: CANARY_RESOURCES.sourceId,
            }]
          : [],
      };
    }
    if (sql.includes("canary:identity-destination")) {
      return {
        rows: this.existing
          ? [{
              id: CANARY_RESOURCES.destinationId,
              workspace_id: CANARY_RESOURCES.workspaceId,
              name: CANARY_RESOURCES.destinationName,
              type: "postgres",
            }]
          : [],
      };
    }
    if (sql.includes("canary:identity-credential")) {
      return {
        rows: this.existing
          ? [{
              id: CANARY_RESOURCES.credentialId,
              workspace_id: CANARY_RESOURCES.workspaceId,
              destination_id: CANARY_RESOURCES.destinationId,
            }]
          : [],
      };
    }
    if (sql.includes("canary:identity-isolation")) {
      return {
        rows: [
          allTrue([
            "no_members",
            "no_other_sources",
            "no_other_routes",
            "no_other_destinations",
            "no_other_bindings",
          ]),
        ],
      };
    }
    if (sql.includes("canary:role-ownership-preflight")) {
      return { rows: [{ owns_nothing: !this.ownsObjects }] };
    }
    if (sql.includes("canary:role-attributes-preflight")) {
      return { rows: [{ security_attributes_ok: !this.forbiddenRoleAttributes }] };
    }
    if (sql.includes("octet_length(") && sql.includes("set_config")) {
      return { rows: [{ configured: true }] };
    }
    if (sql.includes("AS cleared")) return { rows: [{ cleared: true }] };
    if (sql.includes("canary:state-verification")) {
      return {
        rows: [
          allTrue([
            "workspace_ok",
            "source_ok",
            "route_ok",
            "destination_ok",
            "credential_ok",
            "no_stale_credentials",
            "binding_ok",
          ]),
        ],
      };
    }
    if (sql.includes("canary:role-verification")) {
      return {
        rows: [
          {
            ...allTrue([
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
            ]),
            ...this.rolePrivilegeOverrides,
          },
        ],
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

class FakeWriterClient {
  constructor({ allowDeniedOperation = false } = {}) {
    this.allowDeniedOperation = allowDeniedOperation;
    this.calls = [];
    this.connected = false;
    this.ended = false;
  }

  async connect() {
    this.connected = true;
  }

  async end() {
    this.ended = true;
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes("current_user = $1")) return { rows: [{ correct_role: true }] };
    const expectedDenial =
      /^SELECT 1 FROM public\./.test(sql) ||
      /^UPDATE public\./.test(sql) ||
      /^DELETE FROM public\./.test(sql) ||
      /^INSERT INTO public\.workspaces/.test(sql);
    if (expectedDenial && !this.allowDeniedOperation) {
      const error = new Error("redacted fixture denial");
      error.code = "42501";
      throw error;
    }
    return { rows: [], rowCount: 1 };
  }
}

test("environment validation requires distinct, strong env-only credentials", () => {
  const parsed = readProvisionEnvironment({
    DATABASE_URL: fixture.databaseUrl,
    CREDENTIALS_MASTER_KEY: fixture.masterKey,
    AXEL_CANARY_SOURCE_TOKEN: fixture.sourceToken,
    AXEL_CANARY_WRITER_PASSWORD: fixture.writerPassword,
    CONTROL_PLANE_DB_SSL_VERIFY: "true",
  });
  assert.equal(parsed.databaseUrl, fixture.databaseUrl);
  assert.equal(parsed.controlPlaneSslVerify, "true");

  assert.throws(
    () => readProvisionEnvironment({}),
    (error) => error instanceof CanaryProvisionError && error.code === "missing_env:DATABASE_URL",
  );
  assert.throws(
    () => readProvisionEnvironment({
      DATABASE_URL: fixture.databaseUrl,
      CREDENTIALS_MASTER_KEY: fixture.masterKey,
      AXEL_CANARY_SOURCE_TOKEN: "short",
      AXEL_CANARY_WRITER_PASSWORD: fixture.writerPassword,
    }),
    /invalid_env:AXEL_CANARY_SOURCE_TOKEN/,
  );
  assert.throws(
    () => readProvisionEnvironment({
      DATABASE_URL: fixture.databaseUrl,
      CREDENTIALS_MASTER_KEY: fixture.masterKey,
      AXEL_CANARY_SOURCE_TOKEN: fixture.sourceToken,
      AXEL_CANARY_WRITER_PASSWORD: fixture.sourceToken,
    }),
    /canary_secrets_must_be_distinct/,
  );
});

test("writer DSN drops control-plane identity and role-switch parameters", () => {
  const result = new URL(buildWriterConnectionString(fixture.databaseUrl, fixture.writerPassword));
  assert.equal(result.username, CANARY_RESOURCES.roleName);
  assert.equal(result.password, fixture.writerPassword);
  assert.equal(result.searchParams.get("sslmode"), "verify-full");
  assert.equal(result.searchParams.get("application_name"), CANARY_RESOURCES.roleName);
  for (const key of ["options", "passfile", "password", "role", "service", "user"]) {
    assert.equal(result.searchParams.has(key), false);
  }
  assert.doesNotMatch(result.toString(), /control/);
  assert.throws(
    () => buildWriterConnectionString("https://db.example.test/axel", fixture.writerPassword),
    /invalid_env:DATABASE_URL/,
  );
});

test("credential builder uses shared v2 crypto with canonical AAD and clears key bytes", async () => {
  let encryptedInput;
  let keyReference;
  let receivedAad;
  const fakeShared = {
    connectionHostSsrfReason: () => null,
    parseHexMasterKey: () => {
      keyReference = new Uint8Array(32).fill(9);
      return keyReference;
    },
    credentialAadString: (workspaceId, destinationId) => {
      receivedAad = `axel:cred:v2:${workspaceId}:${destinationId}`;
      return receivedAad;
    },
    encryptCredentialV2: async (plaintext, key, aad) => {
      encryptedInput = JSON.parse(plaintext);
      assert.equal(key, keyReference);
      assert.equal(aad, receivedAad);
      return {
        ciphertext: new Uint8Array([1, 2]),
        nonce: new Uint8Array(12),
        auth_tag: new Uint8Array(16),
        encryption_version: 2,
      };
    },
  };

  const built = await buildEncryptedCredential(config(), fakeShared);
  assert.equal(built.encryptionVersion, 2);
  assert.equal(
    receivedAad,
    `axel:cred:v2:${CANARY_RESOURCES.workspaceId}:${CANARY_RESOURCES.destinationId}`,
  );
  const credentialUrl = new URL(encryptedInput.connection_string);
  assert.equal(credentialUrl.username, CANARY_RESOURCES.roleName);
  assert.equal(credentialUrl.password, fixture.writerPassword);
  assert.deepEqual([...keyReference], new Array(32).fill(0));
});

test("admin reconciliation is idempotent, parameterizes secrets, and grants only payload INSERT", async () => {
  for (const existing of [false, true]) {
    const client = new FakeAdminClient({ existing });
    await reconcileCanaryAdminState(client, config(), credential());
    const sql = client.calls.map((call) => call.sql).join("\n");

    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /ON CONFLICT \(id\) DO UPDATE/);
    assert.match(sql, /GRANT INSERT \(payload\)/);
    assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
    assert.match(sql, /NOREPLICATION NOBYPASSRLS/);
    assert.match(sql, /canary:role-attributes-preflight/);
    assert.match(sql, /rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication/);
    assert.match(sql, /AND m\.grantor = current_user::regrole/);
    assert.match(sql, /AND NOT m\.inherit_option/);
    assert.match(sql, /AND NOT m\.set_option/);
    assert.match(sql, /AND grantor\.rolsuper/);
    const roleAlter = client.calls.find((call) =>
      /ALTER ROLE axel_delivery_canary_writer\s+LOGIN/.test(call.sql)
    );
    assert(roleAlter);
    assert.doesNotMatch(
      roleAlter.sql,
      /NOSUPERUSER|NOCREATEDB|NOREPLICATION|NOBYPASSRLS/,
    );
    assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES/);
    assert.match(sql, /aclexplode/);
    assert.match(
      sql,
      /SELECT DISTINCT d\.datname[\s\S]*WHERE grantee\.rolname = 'axel_delivery_canary_writer'/,
    );
    assert.doesNotMatch(sql, /FOR target IN SELECT datname FROM pg_database/);
    assert.match(sql, /has_function_privilege\(\$1::text, p\.oid, 'EXECUTE'\)/);
    assert.match(sql, /p\.prosecdef/);
    assert.doesNotMatch(sql, /EXCEPTION WHEN insufficient_privilege/);
    assert.doesNotMatch(sql, /GRANT (SELECT|UPDATE|DELETE|ALL)/);
    assert.doesNotMatch(sql, new RegExp(fixture.sourceToken));
    assert.doesNotMatch(sql, new RegExp(fixture.writerPassword));
    assert.doesNotMatch(sql, new RegExp(fixture.masterKey));
    assert.equal(client.calls.at(-1).sql, "COMMIT");
    assert.deepEqual(CANARY_BINDING, {
      table: "delivery_canary_receipts",
      mode: "jsonb_blob",
      payload_column: "payload",
    });
  }
});

test("identity collision and unexpected role ownership fail before mutation", async () => {
  const collision = new FakeAdminClient({ collision: "workspace" });
  await assert.rejects(
    reconcileCanaryAdminState(collision, config(), credential()),
    /workspace_identity_collision/,
  );
  assert.equal(collision.calls.some((call) => /CREATE ROLE/.test(call.sql)), false);
  assert.equal(collision.calls.at(-1).sql, "ROLLBACK");

  const owner = new FakeAdminClient({ ownsObjects: true });
  await assert.rejects(
    reconcileCanaryAdminState(owner, config(), credential()),
    /canary_role_owns_database_objects/,
  );
  assert.equal(owner.calls.some((call) => /CREATE ROLE/.test(call.sql)), false);
  assert.equal(owner.calls.at(-1).sql, "ROLLBACK");

  const privilegedRole = new FakeAdminClient({ forbiddenRoleAttributes: true });
  await assert.rejects(
    reconcileCanaryAdminState(privilegedRole, config(), credential()),
    /canary_role_has_forbidden_security_attributes/,
  );
  assert.equal(privilegedRole.calls.some((call) => /CREATE ROLE/.test(call.sql)), false);
  assert.equal(privilegedRole.calls.at(-1).sql, "ROLLBACK");
});

test("admin reconciliation rejects cross-database grants and executable definer routines", async () => {
  for (const rolePrivilegeOverrides of [
    { memberships_safe: false },
    { only_current_direct_database_connect: false },
    { no_security_definer_execute: false },
  ]) {
    const client = new FakeAdminClient({ rolePrivilegeOverrides });
    await assert.rejects(
      reconcileCanaryAdminState(client, config(), credential()),
      /canary_role_privilege_verification_failed/,
    );
    assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  }
});

test("writer verification inserts a valid payload and proves denied access without reading rows", async () => {
  const writer = new FakeWriterClient();
  const payload = buildVerificationPayload(
    new Date("2026-08-27T12:00:00.000Z"),
    "0123456789ab",
  );
  await verifyWriterClient(writer, payload);
  assert.equal(writer.connected, true);
  assert.equal(writer.ended, true);
  assert.equal(
    writer.calls.filter((call) => /INSERT INTO public\.delivery_canary_receipts/.test(call.sql)).length,
    1,
  );
  assert.equal(writer.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(
    writer.calls.some((call) => /SELECT 1 FROM public\.destination_credentials WHERE false/.test(call.sql)),
    true,
  );
  assert.equal(
    writer.calls.some((call) => /SELECT (?!1 FROM)/.test(call.sql)),
    true,
    "the only non-constant SELECT is the boolean current_user identity check",
  );
});

test("writer verification fails closed if a forbidden read succeeds", async () => {
  const writer = new FakeWriterClient({ allowDeniedOperation: true });
  await assert.rejects(verifyWriterClient(writer), /writer_has_excess_privilege/);
  assert.equal(writer.ended, true);
  assert.equal(writer.calls.some((call) => call.sql === "ROLLBACK"), true);
});

test("runbook keeps migration, secret installation, rollout, and monitoring fail-safe", async () => {
  const runbook = await readFile(
    new URL("../../docs/runbook-delivery-canary.md", import.meta.url),
    "utf8",
  );
  const migration = runbook.indexOf("gh workflow run migrate-postgres-run.yml");
  const provisioner = runbook.indexOf("node scripts/provision-delivery-canary.mjs");
  const clearAdminSecrets = runbook.indexOf(
    "unset DATABASE_URL CREDENTIALS_MASTER_KEY AXEL_CANARY_WRITER_PASSWORD",
  );
  const firstGitHubWrite = runbook.indexOf("gh secret set AXEL_CANARY_INGEST_URL");
  const deployVercel = runbook.indexOf("gh workflow run deploy-vercel.yml");
  const syncRender = runbook.indexOf("gh workflow run sync-render-secrets.yml");
  const deployRender = runbook.indexOf("gh workflow run deploy-render.yml");
  const deployCloudflare = runbook.indexOf("gh workflow run deploy-cloudflare.yml");

  assert(migration >= 0 && migration < provisioner);
  assert(clearAdminSecrets > provisioner && clearAdminSecrets < firstGitHubWrite);
  assert(
    deployVercel >= 0
      && deployVercel < syncRender
      && syncRender < deployRender
      && deployRender < deployCloudflare,
  );
  assert.match(runbook, /previously absent\s+`sync:false` values/);
  assert.match(runbook, /\[skip render\]/);
  assert.match(runbook, /for github_environment in Monitoring Production/);
  assert.match(runbook, /no\s+required reviewers and no wait timer/);
  assert.match(runbook, /npx --yes vercel@58\.4\.0 env add/);
  assert.match(runbook, /export -n AXEL_CANARY_SOURCE_TOKEN/);
  assert.match(runbook, /export -n DELIVERY_CANARY_RECEIPT_TOKEN/);
  assert.match(runbook, /export VERCEL_TOKEN/);
  assert.doesNotMatch(runbook, /^export DELIVERY_CANARY_RECEIPT_TOKEN$/m);
  assert.doesNotMatch(runbook, /--token ["']?\$VERCEL_TOKEN/);
  assert.match(runbook, /production-delivery-canary/);
  assert.match(runbook, /full 72 hours/);
});
