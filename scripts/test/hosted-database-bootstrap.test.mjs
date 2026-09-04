import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
} from "../database-service-access-profiles.mjs";
import { controlPlanePgSslOption } from "../control-plane-pg.mjs";
import {
  HOSTED_CANARY_POLICY,
  HostedDatabaseBootstrapError,
  finalizeHostedDatabaseOwner,
  hostedDatabaseBootstrapBlockers,
  hostedDatabaseBootstrapOptionsFromEnv,
  parseHostedDatabaseBootstrapArguments,
  prepareHostedDatabaseBootstrap,
} from "../hosted-database-bootstrap.mjs";

const PASSWORD_A = "A".repeat(48);
const PASSWORD_B = "B".repeat(48);

function options(overrides = {}) {
  return {
    phase: "prepare",
    apply: true,
    ownerRole: "axel_owner",
    migrationLoginRole: "axel_migrator_20260827",
    verifyCapabilityRole: "axel_verify",
    verifyLoginRole: "axel_verify_20260827",
    canary: HOSTED_CANARY_POLICY,
    migrationPassword: PASSWORD_A,
    verifyPassword: PASSWORD_B,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    pg17: true,
    tlsEncrypted: true,
    sessionUnswitched: true,
    providerAdmin: true,
    ownerPresent: true,
    ownerTransitional: true,
    ownerFinalAttributes: false,
    ownerPasswordCleared: false,
    ownerFinal: false,
    ownerOwnsDatabase: true,
    ownerOwnsPublicSchema: true,
    ownerOtherSessions: 2,
    unexpectedRelations: 0,
    missingRelations: 0,
    unexpectedSequences: 0,
    missingSequences: 0,
    relationsNotOwnerOwned: 0,
    migrationLedgerPresent: true,
    providerOwnedExtensionRoutines: 149,
    providerOwnedExtensionTypes: 8,
    unsafeRoutineOwners: 0,
    unsafeTypeOwners: 0,
    securityDefinerRoutines: 0,
    publicExecuteRoutines: 0,
    otherDatabasePublicPrivileges: 0,
    canarySafe: true,
    existingBootstrapRoleCount: 0,
    bootstrapRolesReady: false,
    ...overrides,
  };
}

function clusterRow({
  providerAdmin = true,
  final = false,
  passwordCleared = final,
  sessions = 2,
} = {}) {
  return {
    pg17: true,
    tls_encrypted: true,
    session_unswitched: true,
    provider_admin: providerAdmin,
    owner_present: true,
    owner_nosuper: true,
    owner_inherit: !final,
    owner_createrole: true,
    owner_createdb: !final,
    owner_login: !final,
    owner_noreplication: true,
    owner_nobypassrls: true,
    owner_config_empty: true,
    owner_password_cleared: passwordCleared,
    owner_owns_database: true,
    owner_owns_public_schema: true,
    owner_other_sessions: sessions,
  };
}

function canaryRow() {
  return Object.fromEntries([
    "present",
    "attributes_safe",
    "configuration_safe",
    "membership_safe",
    "database_acl_safe",
    "schema_acl_safe",
    "column_acl_safe",
    "relation_acl_safe",
    "routine_acl_safe",
    "owns_no_objects",
  ].map((key) => [key, true]));
}

class BootstrapClient {
  constructor({
    maintenancePrivileges = 0,
    ready = false,
    final = false,
    passwordCleared = final,
    sessions = 2,
  } = {}) {
    this.calls = [];
    this.ready = ready;
    this.final = final;
    this.passwordCleared = passwordCleared;
    this.maintenancePrivileges = maintenancePrivileges;
    this.sessions = sessions;
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes("hosted-bootstrap:cluster")) {
      return {
        rows: [clusterRow({
          final: this.final,
          passwordCleared: this.passwordCleared,
          sessions: this.sessions,
        })],
      };
    }
    if (sql.includes("hosted-bootstrap:schema")) {
      return {
        rows: [{
          unexpected_relations: 0,
          expected_relations_present: APPLICATION_TABLES.length,
          unexpected_sequences: 0,
          expected_sequences_present: APPLICATION_SEQUENCES.length,
          relations_not_owner_owned: 0,
          migration_ledger_present: true,
        }],
      };
    }
    if (sql.includes("hosted-bootstrap:extensions")) {
      return {
        rows: [{
          provider_owned_extension_routines: 149,
          provider_owned_extension_types: 8,
          unsafe_routine_owners: 0,
          unsafe_type_owners: 0,
          security_definer_routines: 0,
          public_execute_routines: 0,
        }],
      };
    }
    if (sql.includes("hosted-bootstrap:provider-boundary")) {
      return { rows: [{ other_database_public_privileges: this.maintenancePrivileges }] };
    }
    if (sql.includes("hosted-bootstrap:canary")) return { rows: [canaryRow()] };
    if (sql.includes("hosted-bootstrap:roles")) {
      if (!this.ready) return { rows: [{ existing_role_count: 0 }] };
      return {
        rows: [{
          existing_role_count: 3,
          migration_attributes_safe: true,
          verify_capability_attributes_safe: true,
          verify_login_attributes_safe: true,
          memberships_safe: true,
          direct_acl_safe: true,
        }],
      };
    }
    if (sql.includes("octet_length(set_config")) return { rows: [{ configured: true }] };
    if (sql.includes("DO $bootstrap_roles$")) this.ready = true;
    if (sql.includes("ALTER ROLE \"axel_owner\"") && sql.includes("PASSWORD NULL")) {
      this.final = true;
      this.passwordCleared = true;
    }
    return { rows: [] };
  }
}

test("bootstrap argument parsing is inspect-only by default and requires an explicit apply phase", () => {
  assert.deepEqual(parseHostedDatabaseBootstrapArguments([]), {
    phase: "inspect",
    apply: false,
  });
  assert.deepEqual(parseHostedDatabaseBootstrapArguments(["--prepare"]), {
    phase: "prepare",
    apply: false,
  });
  assert.throws(
    () => parseHostedDatabaseBootstrapArguments(["--apply"]),
    /database_hosted_bootstrap_apply_without_phase/,
  );
  assert.throws(
    () => parseHostedDatabaseBootstrapArguments(["--prepare", "--finalize"]),
    /database_hosted_bootstrap_phase_invalid/,
  );
});

test("apply mode requires an exact confirmation and distinct strong passwords", () => {
  const env = {
    DATABASE_MIGRATION_ROLE: "axel_owner",
    DATABASE_MIGRATION_LOGIN_ROLE: "axel_migrator_20260827",
    DATABASE_VERIFY_CAPABILITY_ROLE: "axel_verify",
    DATABASE_VERIFY_LOGIN_ROLE: "axel_verify_20260827",
    DATABASE_MIGRATION_PASSWORD: PASSWORD_A,
    DATABASE_VERIFY_PASSWORD: PASSWORD_B,
  };
  assert.throws(
    () => hostedDatabaseBootstrapOptionsFromEnv(env, { phase: "prepare", apply: true }),
    /database_hosted_bootstrap_confirmation_required/,
  );
  const configured = hostedDatabaseBootstrapOptionsFromEnv({
    ...env,
    AXEL_HOSTED_DATABASE_BOOTSTRAP_CONFIRM:
      "I_UNDERSTAND_THIS_CHANGES_DATABASE_ROLES",
  }, { phase: "prepare", apply: true });
  assert.equal(configured.ownerRole, "axel_owner");
  assert.equal(configured.migrationPassword, PASSWORD_A);
});

test("provider-owned extension members are accepted but PUBLIC execute and maintenance access block", () => {
  assert.deepEqual(hostedDatabaseBootstrapBlockers(snapshot()), []);
  assert.deepEqual(
    hostedDatabaseBootstrapBlockers(snapshot({ publicExecuteRoutines: 158 })),
    ["public_routine_execute_present"],
  );
  assert.deepEqual(
    hostedDatabaseBootstrapBlockers(snapshot({ otherDatabasePublicPrivileges: 2 })),
    ["provider_maintenance_database_public_access"],
  );
  assert.deepEqual(
    hostedDatabaseBootstrapBlockers(snapshot({ canarySafe: false })),
    ["canary_policy_mismatch"],
  );
  assert.deepEqual(
    hostedDatabaseBootstrapBlockers(snapshot({
      ownerTransitional: false,
      ownerFinalAttributes: true,
      ownerPasswordCleared: false,
    })),
    ["owner_password_not_cleared"],
  );
  assert.deepEqual(
    hostedDatabaseBootstrapBlockers(snapshot({
      ownerTransitional: false,
      ownerFinalAttributes: true,
      ownerPasswordCleared: false,
    }), "finalize"),
    ["bootstrap_roles_not_ready", "owner_sessions_must_be_zero"],
  );
});

test("prepare is transactional, idempotent, and never places plaintext passwords in SQL", async () => {
  const client = new BootstrapClient();
  assert.deepEqual(await prepareHostedDatabaseBootstrap(client, options()), { changed: true });
  assert.ok(client.calls.some((call) => call.sql === "BEGIN"));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(client.calls.some((call) => call.sql.includes("DO $bootstrap_roles$")));
  const serialized = JSON.stringify(client.calls);
  assert.doesNotMatch(serialized, new RegExp(PASSWORD_A));
  assert.doesNotMatch(serialized, new RegExp(PASSWORD_B));

  const retry = new BootstrapClient({ ready: true });
  assert.deepEqual(await prepareHostedDatabaseBootstrap(retry, options()), { changed: false });
  assert.equal(retry.calls.some((call) => call.sql.includes("CREATE ROLE")), false);
});

test("prepare hard-stops before mutation when the provider maintenance DB remains public", async () => {
  const client = new BootstrapClient({ maintenancePrivileges: 2 });
  await assert.rejects(
    prepareHostedDatabaseBootstrap(client, options()),
    (error) => error instanceof HostedDatabaseBootstrapError
      && error.code ===
        "database_hosted_bootstrap_blocked:provider_maintenance_database_public_access",
  );
  assert.equal(client.calls.some((call) => call.sql.includes("CREATE ROLE")), false);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
});

test("finalization refuses live owner sessions and re-verifies both sides of conversion", async () => {
  const blocked = new BootstrapClient({ ready: true, sessions: 1 });
  await assert.rejects(
    finalizeHostedDatabaseOwner(blocked, options({ phase: "finalize" }), async () => {}),
    /owner_sessions_must_be_zero/,
  );
  assert.equal(blocked.final, false);

  const client = new BootstrapClient({ ready: true, sessions: 0 });
  const verificationPhases = [];
  const result = await finalizeHostedDatabaseOwner(
    client,
    options({ phase: "finalize" }),
    async (state) => verificationPhases.push(state),
  );
  assert.deepEqual(result, { changed: true });
  assert.deepEqual(verificationPhases, [
    { transitionalOwner: true },
    { transitionalOwner: false },
  ]);
  assert.ok(client.calls.some((call) =>
    call.sql.includes("ALTER ROLE \"axel_owner\"") && call.sql.includes("PASSWORD NULL")));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));

  const stalePassword = new BootstrapClient({
    ready: true,
    final: true,
    passwordCleared: false,
    sessions: 0,
  });
  assert.deepEqual(
    await finalizeHostedDatabaseOwner(
      stalePassword,
      options({ phase: "finalize" }),
      async () => {},
    ),
    { changed: true },
  );
  assert.ok(stalePassword.calls.some((call) =>
    call.sql.includes("ALTER ROLE \"axel_owner\"") && call.sql.includes("PASSWORD NULL")));
});

test("standalone control-plane TLS matches the application policy", () => {
  assert.equal(
    controlPlanePgSslOption("postgresql://role@127.0.0.1/db", "true"),
    false,
  );
  assert.deepEqual(
    controlPlanePgSslOption("postgresql://role@localhost.invalid/db", "true"),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    controlPlanePgSslOption("postgresql://role@db.example.test/db", undefined),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    controlPlanePgSslOption("postgresql://role@db.example.test/db", "true"),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    controlPlanePgSslOption(
      "postgresql://role@db.example.test/db?sslmode=no-verify",
      "true",
    ),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    controlPlanePgSslOption("postgresql://role@db.example.test/db?sslmode=verify-full", "false"),
    { rejectUnauthorized: true },
  );
});

test("migration runner honors the control-plane verification opt-in", () => {
  const source = readFileSync(new URL("../run-migrations.sh", import.meta.url), "utf8");
  assert.match(source, /CONTROL_PLANE_DB_SSL_VERIFY/);
  assert.match(source, /export PGSSLMODE=verify-full/);
  assert.match(source, /export PGSSLMODE=require/);
});
