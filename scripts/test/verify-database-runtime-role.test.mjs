import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_ROLE_SQL,
  verifyDatabaseRuntimeRole,
} from "../verify-database-runtime-role.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/verify-database-runtime-role.mjs");

const validRow = {
  expected_role: true,
  effective_search_path_safe: true,
  expected_role_allowlist_safe: true,
  reviewed_acl_role_inputs_safe: true,
  login_attributes_safe: true,
  capability_attributes_safe: true,
  stable_owner_safe: true,
  capability_no_parent_memberships: true,
  capability_child_allowlist_exact: true,
  expected_login_roles_safe: true,
  database_privileges_safe: true,
  schema_privileges_safe: true,
  app_relation_privileges_exact: true,
  denied_relation_privileges_absent: true,
  direct_column_grants_absent: true,
  public_acl_grants_absent: true,
  acl_grantee_inventory_safe: true,
  stable_owner_controls_non_system_objects: true,
  owner_default_acl_inventory_safe: true,
  app_sequence_privileges_exact: true,
  denied_sequence_privileges_absent: true,
  routine_execute_denied: true,
  owns_nothing: true,
  table_count: 73,
  sequence_count: 5,
};

test("verifies the expected replaceable login and no-login capability role", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [validRow] };
    },
  };
  const result = await verifyDatabaseRuntimeRole(client, {
    expectedRole: "axel_runtime_20260827",
    capabilityRole: "axel_runtime",
    ownerRole: "axel_owner",
    verifyCapabilityRole: "axel_verify",
    existingLoginRoles: ["axel_runtime_20260826"],
    migrationLoginRoles: ["axel_migrator"],
  });
  assert.deepEqual(result, { tableCount: 73, sequenceCount: 5 });
  assert.deepEqual(calls[0].params, [
    "axel_runtime_20260827",
    "axel_runtime",
    "axel_owner",
    ["axel_runtime_20260827", "axel_runtime_20260826"],
    "axel_verify",
    ["axel_migrator"],
  ]);
  assert.match(calls[0].sql, /capability_child_allowlist_exact/);
  assert.match(calls[0].sql, /membership\.admin_option/);
  assert.match(calls[0].sql, /membership\.inherit_option/);
  assert.match(calls[0].sql, /membership\.set_option/);
  assert.match(calls[0].sql, /session_user = \$1/);
  assert.match(calls[0].sql, /has_any_column_privilege/);
  assert.match(calls[0].sql, /has_function_privilege/);
  assert.match(calls[0].sql, /pg_type/);
});

test("fails closed for a missing role or any privilege mismatch", async () => {
  await assert.rejects(
    verifyDatabaseRuntimeRole({ query: async () => ({ rows: [] }) }, {
      expectedRole: "axel_runtime_20260827",
      capabilityRole: "axel_runtime",
      ownerRole: "axel_owner",
      verifyCapabilityRole: "axel_verify",
      migrationLoginRoles: ["axel_migrator"],
    }),
    /database_runtime_role_missing/,
  );

  for (const key of Object.keys(validRow).filter((key) => typeof validRow[key] === "boolean")) {
    const row = { ...validRow, [key]: false };
    await assert.rejects(
      verifyDatabaseRuntimeRole({ query: async () => ({ rows: [row] }) }, {
        expectedRole: "axel_runtime_20260827",
        capabilityRole: "axel_runtime",
        ownerRole: "axel_owner",
        verifyCapabilityRole: "axel_verify",
        migrationLoginRoles: ["axel_migrator"],
      }),
      /database_runtime_role_privilege_mismatch/,
      key,
    );
  }
});

test("rejects role-name injection before querying", async () => {
  let queried = false;
  const client = { query: async () => { queried = true; } };
  await assert.rejects(
    verifyDatabaseRuntimeRole(client, {
      expectedRole: "runtime; RESET ROLE",
      capabilityRole: "axel_runtime",
      ownerRole: "axel_owner",
      verifyCapabilityRole: "axel_verify",
      migrationLoginRoles: ["axel_migrator"],
    }),
    /database_runtime_role_name_invalid/,
  );
  assert.equal(queried, false);
});

test("rejects duplicate, colliding, and malformed login allowlists before querying", async () => {
  let queried = false;
  const client = { query: async () => { queried = true; } };
  const invalidOptions = [
    { existingLoginRoles: ["axel_runtime_20260827"] },
    { existingLoginRoles: ["axel_runtime"] },
    { existingLoginRoles: ["axel_owner"] },
    { existingLoginRoles: ["bad role"] },
    { existingLoginRoles: "axel_runtime_20260826" },
  ];
  for (const extra of invalidOptions) {
    await assert.rejects(
      verifyDatabaseRuntimeRole(client, {
        expectedRole: "axel_runtime_20260827",
        capabilityRole: "axel_runtime",
        ownerRole: "axel_owner",
        verifyCapabilityRole: "axel_verify",
        migrationLoginRoles: ["axel_migrator"],
        ...extra,
      }),
      /database_runtime_role_(?:name|allowlist)_invalid/,
    );
  }
  assert.equal(queried, false);
});

test("CLI collapses connection failures without disclosing the credential", () => {
  const secret = "cli-secret-must-not-appear";
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_RUNTIME_URL: `postgresql://runtime:${secret}@127.0.0.1:1/axel?sslmode=disable`,
      DATABASE_RUNTIME_EXPECTED_ROLE: "axel_runtime_20260827",
      DATABASE_RUNTIME_CAPABILITY_ROLE: "axel_runtime",
      DATABASE_RUNTIME_OWNER_ROLE: "axel_owner",
      DATABASE_VERIFY_CAPABILITY_ROLE: "axel_verify",
      DATABASE_RUNTIME_EXISTING_LOGIN_ROLES: "axel_runtime_20260826",
      DATABASE_MIGRATION_LOGIN_ROLE: "axel_migrator",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "database_runtime_preflight_failed\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, "i"));
});

test("query checks only metadata, effective privileges, and ACL inventories", () => {
  assert.doesNotMatch(RUNTIME_ROLE_SQL, /SELECT\s+\*\s+FROM\s+public\./i);
  assert.doesNotMatch(RUNTIME_ROLE_SQL, /destination_credentials|personal_access_tokens|payload/i);
  assert.match(RUNTIME_ROLE_SQL, /has_table_privilege/);
  assert.match(RUNTIME_ROLE_SQL, /has_sequence_privilege/);
  assert.match(RUNTIME_ROLE_SQL, /nspname !~ '\^pg_'/);
  assert.match(RUNTIME_ROLE_SQL, /nspname <> 'information_schema'/);
  assert.match(RUNTIME_ROLE_SQL, /CROSS JOIN checked_roles/);
  assert.match(RUNTIME_ROLE_SQL, /WHERE grantee = 0/);
  assert.match(RUNTIME_ROLE_SQL, /owner_default_acl_grants/);
  assert.match(RUNTIME_ROLE_SQL, /direct_column_grants/);
});
