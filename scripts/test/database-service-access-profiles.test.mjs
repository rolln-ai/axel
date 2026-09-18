import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
  DATABASE_SERVICE_PROFILE_NAMES,
  databaseServiceAccessProfile,
} from "../database-service-access-profiles.mjs";
import {
  postgresScramSha256Verifier,
  validateDatabaseServiceProvisionOptions,
} from "../provision-database-service-roles.mjs";
import { validateDatabaseServiceRoleOptions } from "../verify-database-service-role.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/provision-database-service-roles.mjs");

function validOptions(overrides = {}) {
  const registry = Object.fromEntries(
    DATABASE_SERVICE_PROFILE_NAMES.map((profile) => {
      const stem = profile.replaceAll("-", "_");
      return [profile, {
        capabilityRole: `axel_${stem}`,
        loginRole: `axel_${stem}_20260827`,
        existingLoginRoles: [],
      }];
    }),
  );
  const serviceParents = DATABASE_SERVICE_PROFILE_NAMES.flatMap((profile) => [
    registry[profile].capabilityRole,
    registry[profile].loginRole,
  ]);
  return {
    profile: "dashboard",
    registry,
    ownerRole: "axel_owner",
    migrationLoginRoles: ["axel_migrator"],
    verifyCapabilityRole: "axel_verify",
    verifyLoginRoles: ["axel_verify_20260827"],
    ownerParentRoles: [
      "axel_delivery_canary_writer",
      "axel_verify",
      "axel_verify_20260827",
      ...serviceParents,
    ],
    legacyCapabilityRole: "axel_runtime",
    legacyLoginRoles: [],
    requireFinalState: true,
    ...overrides,
  };
}

test("profiles enumerate the reviewed schema and never grant migration-ledger access", () => {
  assert.equal(new Set(APPLICATION_TABLES).size, APPLICATION_TABLES.length);
  assert.equal(new Set(APPLICATION_SEQUENCES).size, APPLICATION_SEQUENCES.length);
  assert.equal(APPLICATION_TABLES.includes("schema_migrations"), false);
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    const profile = databaseServiceAccessProfile(profileName);
    assert.equal(Object.hasOwn(profile.tables, "schema_migrations"), false);
    for (const privileges of Object.values(profile.tables)) {
      assert.equal(privileges.includes("TRUNCATE"), false);
      assert.equal(privileges.includes("REFERENCES"), false);
      assert.equal(privileges.includes("TRIGGER"), false);
    }
    for (const privileges of Object.values(profile.sequences)) {
      assert.deepEqual(privileges, ["USAGE"]);
    }
  }
});

test("delivery-native can index erasure subjects without receiving broader erasure access", () => {
  const profile = databaseServiceAccessProfile("delivery-native");
  assert.deepEqual(profile.tables.erasure_subjects, ["INSERT"]);
  assert.deepEqual(profile.sequences.erasure_subjects_id_seq, ["USAGE"]);
  assert.equal(profile.tables.erasure_subjects.includes("SELECT"), false);
  assert.equal(profile.tables.erasure_subjects.includes("DELETE"), false);
});

test("delivery-workers does not inherit the optional native queue profile", () => {
  const profile = databaseServiceAccessProfile("delivery-workers");
  assert.equal(Object.hasOwn(profile.tables, "queue_quarantine"), false);
  assert.equal(Object.hasOwn(profile.sequences, "queue_quarantine_id_seq"), false);
});

test("role registry rejects injections, overlap, and the legacy broad role", () => {
  assert.throws(
    () => validateDatabaseServiceRoleOptions(validOptions({ profile: "ingest" })),
    /database_service_profile_invalid/,
  );
  const injected = validOptions();
  injected.registry.dashboard.capabilityRole = "axel_dashboard;RESET ROLE";
  assert.throws(() => validateDatabaseServiceRoleOptions(injected), /role_name_invalid/);
  const collision = validOptions();
  collision.registry.dashboard.loginRole = collision.registry.dashboard.capabilityRole;
  assert.throws(
    () => validateDatabaseServiceRoleOptions(collision),
    /database_service_/,
  );
  const legacyCollision = validOptions();
  legacyCollision.registry.dashboard.capabilityRole = "axel_runtime";
  assert.throws(
    () => validateDatabaseServiceRoleOptions(legacyCollision),
    /database_service_/,
  );
});

test("pending grants are limited to the reviewed triage grants during owner preflight", () => {
  const pending = ["dead_letters|UPDATE", "dead_letter_mutes|SELECT"];
  assert.deepEqual(
    validateDatabaseServiceRoleOptions(validOptions({
      requireIdentity: false, managedOwnerLogin: true, migrationLoginRoles: [], pendingGrants: pending,
    })).pendingGrants,
    pending,
  );
  assert.throws(
    () => validateDatabaseServiceRoleOptions(validOptions({
      requireIdentity: false, managedOwnerLogin: true, migrationLoginRoles: [], pendingGrants: ["dead_letters|DELETE"],
    })),
    /database_service_pending_grants_invalid/,
  );
  assert.throws(
    () => validateDatabaseServiceRoleOptions(validOptions({ pendingGrants: pending })),
    /database_service_pending_grants_invalid/,
  );
});

test("only the exact owner can be the bounded transitional login", () => {
  assert.equal(
    validateDatabaseServiceRoleOptions(validOptions({
      requireFinalState: false,
      transitionalOwnerLoginRole: "axel_owner",
    })).transitionalOwnerLoginRole,
    "axel_owner",
  );
  assert.throws(
    () => validateDatabaseServiceRoleOptions(validOptions({
      requireFinalState: false,
      transitionalOwnerLoginRole: "axel_other_owner",
    })),
    /database_service_transitional_owner_role_invalid/,
  );
  assert.throws(
    () => validateDatabaseServiceRoleOptions(validOptions({
      transitionalOwnerLoginRole: "axel_owner",
    })),
    /database_service_transitional_owner_role_invalid/,
  );
});

test("provisioning requires five distinct strong passwords and creates SCRAM locally", () => {
  const options = validOptions();
  const passwords = Object.fromEntries(
    DATABASE_SERVICE_PROFILE_NAMES.map((profile, index) => [
      profile,
      `ServiceCredential_${index}_abcdefghijklmnopqrstuvwxyz0123456789`,
    ]),
  );
  assert.equal(
    validateDatabaseServiceProvisionOptions({ ...options, passwords }).passwords.dashboard,
    passwords.dashboard,
  );
  assert.match(
    postgresScramSha256Verifier("correct-horse-battery-staple", Buffer.alloc(16, 1)),
    /^SCRAM-SHA-256\$4096:/,
  );
  assert.throws(
    () => validateDatabaseServiceProvisionOptions({
      ...options,
      passwords: { ...passwords, dashboard: "short" },
    }),
    /database_service_password_invalid/,
  );
  assert.throws(
    () => validateDatabaseServiceProvisionOptions({
      ...options,
      passwords: { ...passwords, dashboard: passwords["delivery-native"] },
    }),
    /database_service_passwords_must_be_distinct/,
  );
});

test("provisioning CLI collapses errors without printing candidate credentials", () => {
  const sentinel = "ServiceCredential_sentinel_abcdefghijklmnopqrstuvwxyz";
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: `postgresql://invalid:${sentinel}@127.0.0.1:1/axel`,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "database_service_role_provisioning_failed\n");
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
});
