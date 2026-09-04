import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  postgresScramSha256Verifier,
  validateDatabaseAccessInputs,
} from "../provision-database-access-roles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/provision-database-access-roles.mjs");

const strongRuntimePassword = "runtime-credential-with-more-than-forty-characters-2026";
const strongVerifyPassword = "verify-credential-with-more-than-forty-characters-2026";

function valid(overrides = {}) {
  return {
    migrationRole: "axel_owner",
    migrationLoginRole: "axel_migrator",
    migrationExistingLoginRoles: [],
    runtimeCapabilityRole: "axel_runtime",
    runtimeLoginRole: "axel_runtime_20260827",
    runtimeExistingLoginRoles: [],
    runtimePassword: strongRuntimePassword,
    verifyCapabilityRole: "axel_verify",
    verifyLoginRole: "axel_verify_20260827",
    verifyExistingLoginRoles: [],
    verifyPassword: strongVerifyPassword,
    ...overrides,
  };
}

test("accepts distinct fixed-form roles and strong env-only passwords", () => {
  assert.deepEqual(validateDatabaseAccessInputs(valid()), valid());
});

test("derives a PostgreSQL SCRAM verifier locally before any database query", () => {
  assert.equal(
    postgresScramSha256Verifier("correct-horse-battery-staple", Buffer.alloc(16, 1)),
    "SCRAM-SHA-256$4096:AQEBAQEBAQEBAQEBAQEBAQ==$A8IPD+BuWf/8RdgFAHagu9QmP4DAUmRDlB62pdD79vo=:gvYZxUGbT+YJiAmT85y4D+lSFszZdI+RttQ1uinwwI0=",
  );
  assert.throws(
    () => postgresScramSha256Verifier("password", Buffer.alloc(8)),
    /database_scram_verifier_input_invalid/,
  );
});

test("rejects role-name injection and collisions", () => {
  for (const key of [
    "migrationRole",
    "migrationLoginRole",
    "runtimeCapabilityRole",
    "runtimeLoginRole",
    "verifyCapabilityRole",
    "verifyLoginRole",
  ]) {
    assert.throws(
      () => validateDatabaseAccessInputs(valid({ [key]: "role; RESET ROLE" })),
      /_role_invalid/,
      key,
    );
  }
  assert.throws(
    () => validateDatabaseAccessInputs(valid({ verifyLoginRole: "axel_runtime_20260827" })),
    /database_role_names_must_be_distinct/,
  );
  assert.throws(
    () => validateDatabaseAccessInputs(valid({ runtimeExistingLoginRoles: ["unsafe;role"] })),
    /database_runtime_existing_login_roles_invalid/,
  );
});

test("rejects weak, line-bearing, or reused passwords", () => {
  assert.throws(
    () => validateDatabaseAccessInputs(valid({ runtimePassword: "too-short" })),
    /database_runtime_password_invalid/,
  );
  assert.throws(
    () => validateDatabaseAccessInputs(valid({ verifyPassword: `${strongVerifyPassword}\n` })),
    /database_verify_password_invalid/,
  );
  assert.throws(
    () => validateDatabaseAccessInputs(valid({ verifyPassword: strongRuntimePassword })),
    /database_role_passwords_must_be_distinct/,
  );
});

test("CLI collapses failures without disclosing database credentials", () => {
  const migrationPassword = "MigrationCredential_20260827_abcdefghijklmnopqrstuvwxyz";
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL:
        `postgresql://axel_owner:${migrationPassword}@127.0.0.1:1/axel?sslmode=disable`,
      DATABASE_MIGRATION_ROLE: "axel_owner",
      DATABASE_MIGRATION_LOGIN_ROLE: "axel_migrator",
      DATABASE_RUNTIME_LOGIN_ROLE: "axel_runtime_20260827",
      DATABASE_RUNTIME_PASSWORD: strongRuntimePassword,
      DATABASE_VERIFY_LOGIN_ROLE: "axel_verify_20260827",
      DATABASE_VERIFY_PASSWORD: strongVerifyPassword,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "database_access_role_provisioning_failed\n");
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp([migrationPassword, strongRuntimePassword, strongVerifyPassword].join("|"), "i"),
  );
});
