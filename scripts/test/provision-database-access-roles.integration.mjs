import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionDatabaseAccessRoles } from "../provision-database-access-roles.mjs";
import { verifyDatabaseRuntimeRole } from "../verify-database-runtime-role.mjs";
import {
  connectDisposablePostgres,
  connectPostgres,
} from "./postgres-integration-test-helpers.mjs";

const CONTAINER_NAME = `axel-pg17-access-${process.pid}`;
const ADMIN_PASSWORD = "disposable-admin-only";
const MIGRATOR_PASSWORD = "disposable-migrator-only";
const RUNTIME_PASSWORD = "RuntimeCredential_20260827_abcdefghijklmnopqrstuvwxyz";
const VERIFY_PASSWORD = "VerifyCredential_20260827_abcdefghijklmnopqrstuvwxyz";
const ROTATED_RUNTIME_PASSWORD = "RuntimeCredential_20260828_abcdefghijklmnopqrstuvwxyz";
const ROTATED_VERIFY_PASSWORD = "VerifyCredential_20260828_abcdefghijklmnopqrstuvwxyz";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const METADATA_ROLE_SQL = readFileSync(
  path.join(ROOT, "scripts/verify-database-metadata-role.sql"),
  "utf8",
);
const PSQL_SAFE = path.join(ROOT, "scripts/psql-safe.mjs");
let reviewedMigrationLoginRoles = ["axel_migrator"];

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function expectDenied(client, sql) {
  await assert.rejects(
    client.query(sql),
    (error) => error?.code === "42501" || error?.code === "25006",
  );
}

function runtimeVerificationOptions(expectedRole, existingLoginRoles = []) {
  return {
    expectedRole,
    capabilityRole: "axel_runtime",
    ownerRole: "axel_owner",
    verifyCapabilityRole: "axel_verify",
    existingLoginRoles,
    migrationLoginRoles: reviewedMigrationLoginRoles,
  };
}

async function expectRuntimeVerificationDenied(client, expectedRole, existingLoginRoles = []) {
  await assert.rejects(
    verifyDatabaseRuntimeRole(
      client,
      runtimeVerificationOptions(expectedRole, existingLoginRoles),
    ),
    /database_runtime_role_privilege_mismatch/,
  );
}

async function metadataRoleVerdict(client, expectedRole, existingLoginRoles = []) {
  assert.match(expectedRole, /^[a-z][a-z0-9_]{2,62}$/);
  for (const role of existingLoginRoles) assert.match(role, /^[a-z][a-z0-9_]{2,62}$/);
  const sql = METADATA_ROLE_SQL
    .replaceAll(":'expected_role'", `'${expectedRole}'`)
    .replaceAll(":'capability_role'", "'axel_verify'")
    .replaceAll(":'owner_role'", "'axel_owner'")
    .replaceAll(":'existing_login_roles'", `'${existingLoginRoles.join(",")}'`)
    .replaceAll(":'runtime_capability_role'", "'axel_runtime'")
    .replaceAll(":'migration_login_roles'", `'${reviewedMigrationLoginRoles.join(",")}'`);
  const result = await client.query(sql);
  assert.equal(result.rows.length, 1);
  return Number(Object.values(result.rows[0])[0]);
}

test("provisions replaceable runtime and metadata-only roles on PostgreSQL 17", async () => {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
    "postgres",
    "-c",
    "log_statement=all",
    "-c",
    "log_parameter_max_length_on_error=-1",
  );

  const clients = [];
  let phase = "container_start";
  try {
    const portOutput = docker("port", CONTAINER_NAME, "5432/tcp").trim();
    const port = Number(portOutput.slice(portOutput.lastIndexOf(":") + 1));
    assert.ok(Number.isSafeInteger(port) && port > 0);

    const admin = await connectDisposablePostgres(
      `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/postgres?sslmode=disable`,
    );
    clients.push(admin);
    await admin.query(`
      CREATE ROLE axel_owner NOLOGIN NOINHERIT CREATEROLE
        NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;
      CREATE ROLE axel_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT axel_owner TO axel_migrator
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    `);
    await admin.query("CREATE DATABASE axel OWNER axel_owner");
    await admin.query(`
      REVOKE ALL PRIVILEGES ON DATABASE axel FROM PUBLIC;
      GRANT CONNECT ON DATABASE axel TO axel_migrator;
    `);

    const migratorBaseUrl =
      `postgresql://axel_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`;
    const ownerUrl = new URL(migratorBaseUrl);
    ownerUrl.searchParams.set("options", "-crole=axel_owner -csearch_path=pg_catalog,public");
    phase = "owner_setup";
    const owner = await connectPostgres(ownerUrl.href);
    clients.push(owner);
    const adminAxel = await connectPostgres(
      `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(adminAxel);
    await owner.query(`
      ALTER SCHEMA public OWNER TO axel_owner;
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
      CREATE TABLE public.schema_migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL
      );
      CREATE TABLE public.app_table (
        id bigserial PRIMARY KEY,
        value text
      );
      CREATE FUNCTION public.existing_acl_probe()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
      GRANT CREATE ON SCHEMA public TO PUBLIC;
      GRANT SELECT (value) ON TABLE public.app_table TO PUBLIC;
      GRANT SELECT ON SEQUENCE public.app_table_id_seq TO PUBLIC;
    `);
    await owner.query("GRANT CREATE, TEMPORARY ON DATABASE axel TO PUBLIC");

    phase = "unsafe_owner_rejected";
    await admin.query("ALTER ROLE axel_owner SUPERUSER");
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_role_provisioning_authority_invalid_owner_attributes_safe/,
    );
    await admin.query("ALTER ROLE axel_owner NOSUPERUSER");

    phase = "disguised_session_user_rejected";
    await assert.rejects(
      provisionDatabaseAccessRoles(adminAxel, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_role_provisioning_authority_invalid_session_user/,
    );

    phase = "rogue_owner_child_rejected";
    await admin.query(`
      CREATE ROLE axel_rogue_migrator LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT axel_owner TO axel_rogue_migrator
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      GRANT CONNECT ON DATABASE axel TO axel_rogue_migrator;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_migration_login_role_collision/,
    );
    await admin.query(`
      REVOKE CONNECT ON DATABASE axel FROM axel_rogue_migrator;
      REVOKE axel_owner FROM axel_rogue_migrator;
      DROP ROLE axel_rogue_migrator;
    `);

    phase = "rogue_owner_parent_rejected";
    await admin.query(`
      CREATE ROLE axel_powerful_parent NOLOGIN NOINHERIT CREATEROLE
        NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;
      GRANT axel_powerful_parent TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_role_provisioning_authority_invalid_owner_parent_memberships_safe/,
    );
    await admin.query(`
      REVOKE axel_powerful_parent FROM axel_owner;
      DROP ROLE axel_powerful_parent;
    `);

    phase = "unrelated_acl_rejected";
    await admin.query(`
      CREATE ROLE axel_unrelated_reader NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    `);
    await owner.query("GRANT SELECT ON TABLE public.app_table TO axel_unrelated_reader");
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_public_acl_grantee_collision/,
    );
    await owner.query("REVOKE SELECT ON TABLE public.app_table FROM axel_unrelated_reader");
    await admin.query("DROP ROLE axel_unrelated_reader");

    const detailSentinel = "detail-row-material-must-not-appear";
    const psqlFailure = spawnSync(
      process.execPath,
      [
        PSQL_SAFE,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE TEMP TABLE detail_probe(value text UNIQUE); INSERT INTO detail_probe VALUES ('${detailSentinel}'), ('${detailSentinel}')`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: migratorBaseUrl,
          DATABASE_MIGRATION_ROLE: "axel_owner",
          DATABASE_MIGRATION_ROLE_REQUIRED: "1",
        },
      },
    );
    assert.notEqual(psqlFailure.status, 0);
    assert.equal(psqlFailure.stdout, "");
    assert.equal(psqlFailure.stderr, "psql_safe_command_failed\n");
    assert.equal(`${psqlFailure.stdout}${psqlFailure.stderr}`.includes(detailSentinel), false);

    phase = "initial_provision";
    const provisioned = await provisionDatabaseAccessRoles(owner, {
      migrationRole: "axel_owner",
      migrationLoginRole: "axel_migrator",
      migrationExistingLoginRoles: [],
      runtimeCapabilityRole: "axel_runtime",
      runtimeLoginRole: "axel_runtime_20260827",
      runtimePassword: RUNTIME_PASSWORD,
      verifyCapabilityRole: "axel_verify",
      verifyLoginRole: "axel_verify_20260827",
      verifyPassword: VERIFY_PASSWORD,
    });
    assert.deepEqual(provisioned, { tableCount: 2, sequenceCount: 1 });

    phase = "initial_runtime";
    const runtime = await connectPostgres(
      `postgresql://axel_runtime_20260827:${RUNTIME_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(runtime);
    assert.deepEqual(
      await verifyDatabaseRuntimeRole(
        runtime,
        runtimeVerificationOptions("axel_runtime_20260827"),
      ),
      { tableCount: 1, sequenceCount: 1 },
    );
    await runtime.query("INSERT INTO public.app_table(value) VALUES ('test-only')");
    await expectDenied(runtime, "SELECT * FROM public.schema_migrations");
    await expectDenied(runtime, "TRUNCATE public.app_table");
    await expectDenied(runtime, "CREATE TABLE public.runtime_owned(id integer)");
    await expectDenied(runtime, "CREATE TEMP TABLE runtime_temp(id integer)");
    await expectDenied(runtime, "SELECT public.existing_acl_probe()");

    phase = "migration_identity";
    const identities = await owner.query("SELECT current_user, session_user");
    assert.deepEqual(identities.rows[0], {
      current_user: "axel_owner",
      session_user: "axel_migrator",
    });
    await owner.query("CREATE TABLE public.future_acl_probe(id bigserial PRIMARY KEY)");
    await runtime.query("INSERT INTO public.future_acl_probe DEFAULT VALUES");
    const ownership = await owner.query(`
      SELECT tableowner FROM pg_tables
       WHERE schemaname = 'public' AND tablename = 'future_acl_probe'
    `);
    assert.equal(ownership.rows[0]?.tableowner, "axel_owner");
    const migratorOwnership = await owner.query(`
      SELECT count(*)::integer AS count
        FROM pg_class relation
        JOIN pg_roles role ON role.oid = relation.relowner
       WHERE role.rolname = 'axel_migrator'
    `);
    assert.equal(migratorOwnership.rows[0]?.count, 0);

    phase = "initial_verifier";
    const verifier = await connectPostgres(
      `postgresql://axel_verify_20260827:${VERIFY_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(verifier);
    const catalog = await verifier.query("SELECT to_regclass('public.app_table') IS NOT NULL AS exists");
    assert.equal(catalog.rows[0]?.exists, true);
    await expectDenied(verifier, "SELECT * FROM public.app_table");
    await expectDenied(verifier, "CREATE TEMP TABLE verify_temp(id integer)");
    await expectDenied(verifier, "SELECT public.existing_acl_probe()");
    assert.equal(await metadataRoleVerdict(verifier, "axel_verify_20260827"), 1);

    phase = "scram_and_future_defaults";
    const scramPasswords = await admin.query(`
      SELECT count(*)::integer AS count
        FROM pg_authid
       WHERE rolname = ANY($1::text[])
         AND rolpassword LIKE 'SCRAM-SHA-256$%'
    `, [["axel_runtime_20260827", "axel_verify_20260827"]]);
    assert.equal(scramPasswords.rows[0]?.count, 2);

    await owner.query(`
      CREATE FUNCTION public.future_acl_probe_routine()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
    `);
    await expectDenied(runtime, "SELECT public.future_acl_probe_routine()");
    await expectDenied(verifier, "SELECT public.future_acl_probe_routine()");

    phase = "cross_database_ownership_collision";
    await admin.query(`
      CREATE EXTENSION postgres_fdw;
      CREATE SERVER axel_runtime_owned_server FOREIGN DATA WRAPPER postgres_fdw;
      ALTER SERVER axel_runtime_owned_server OWNER TO axel_runtime;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_capability_role_collision/,
    );
    await admin.query(`
      ALTER SERVER axel_runtime_owned_server OWNER TO postgres;
      DROP SERVER axel_runtime_owned_server;
      DROP EXTENSION postgres_fdw;
    `);

    phase = "private_acl_collision";
    await owner.query(`
      CREATE SCHEMA private_probe;
      CREATE TABLE private_probe.hidden_data(id integer);
      GRANT USAGE ON SCHEMA private_probe TO axel_runtime;
      GRANT SELECT ON TABLE private_probe.hidden_data TO axel_runtime;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_capability_role_collision/,
    );
    await owner.query(`
      REVOKE SELECT ON TABLE private_probe.hidden_data FROM axel_runtime;
      REVOKE USAGE ON SCHEMA private_probe FROM axel_runtime;
      DROP SCHEMA private_probe CASCADE;
    `);

    phase = "unexpected_child_collision";
    await admin.query(`
      CREATE ROLE axel_unrelated_child NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      GRANT axel_runtime TO axel_unrelated_child
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_capability_role_collision/,
    );
    await admin.query("REVOKE axel_runtime FROM axel_unrelated_child; DROP ROLE axel_unrelated_child");

    phase = "capability_collision";
    await admin.query(`
      CREATE ROLE axel_parent NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      GRANT axel_parent TO axel_runtime
        WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
    `);
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_capability_role_collision/,
    );
    await admin.query("REVOKE axel_parent FROM axel_runtime; DROP ROLE axel_parent");

    phase = "unsafe_existing_login_rejected";
    await admin.query("ALTER ROLE axel_runtime_20260827 CREATEDB");
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_existing_login_role_collision/,
    );
    await admin.query("ALTER ROLE axel_runtime_20260827 NOCREATEDB");

    phase = "unsafe_schema_default_rejected";
    await owner.query(
      "ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO axel_runtime",
    );
    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_capability_role_collision_has_no_external_acl_dependencies/,
    );
    await owner.query(
      "ALTER DEFAULT PRIVILEGES REVOKE CREATE ON SCHEMAS FROM axel_runtime",
    );

    phase = "seed_privilege_drift";
    await owner.query("GRANT CREATE, TEMPORARY ON DATABASE axel TO PUBLIC, axel_runtime, axel_verify");
    await owner.query(`
      GRANT CREATE ON SCHEMA public TO PUBLIC, axel_runtime, axel_verify;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
        TO PUBLIC, axel_runtime, axel_verify;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
        TO PUBLIC, axel_runtime, axel_verify;
      GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public
        TO PUBLIC, axel_runtime, axel_verify;
      GRANT SELECT (value) ON TABLE public.app_table TO axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES
        GRANT ALL PRIVILEGES ON TABLES TO PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES
        GRANT ALL PRIVILEGES ON SEQUENCES TO PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES
        GRANT ALL PRIVILEGES ON ROUTINES TO PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL PRIVILEGES ON TABLES TO PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL PRIVILEGES ON SEQUENCES TO PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL PRIVILEGES ON ROUTINES TO PUBLIC, axel_runtime, axel_verify;
    `);

    await assert.rejects(
      provisionDatabaseAccessRoles(owner, {
        migrationRole: "axel_owner",
        migrationLoginRole: "axel_migrator",
        migrationExistingLoginRoles: [],
        runtimeCapabilityRole: "axel_runtime",
        runtimeLoginRole: "axel_runtime_blocked",
        runtimeExistingLoginRoles: ["axel_runtime_20260827"],
        runtimePassword: "RuntimeCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
        verifyCapabilityRole: "axel_verify",
        verifyLoginRole: "axel_verify_blocked",
        verifyExistingLoginRoles: ["axel_verify_20260827"],
        verifyPassword: "VerifyCredential_Blocked_abcdefghijklmnopqrstuvwxyz",
      }),
      /database_role_provisioning_authority_invalid_public_schema_exclusive/,
    );
    await owner.query("REVOKE CREATE ON SCHEMA public FROM axel_runtime, axel_verify");
    await owner.query(`
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON ROUTINES FROM PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, axel_runtime, axel_verify;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE ALL PRIVILEGES ON ROUTINES FROM PUBLIC, axel_runtime, axel_verify;
    `);

    phase = "reviewed_old_migration_login";
    await admin.query(`
      CREATE ROLE axel_migrator_previous LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT axel_owner TO axel_migrator_previous
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      GRANT CONNECT ON DATABASE axel TO axel_migrator_previous;
    `);
    reviewedMigrationLoginRoles = ["axel_migrator", "axel_migrator_previous"];

    phase = "rotated_provision";
    const rotated = await provisionDatabaseAccessRoles(owner, {
      migrationRole: "axel_owner",
      migrationLoginRole: "axel_migrator",
      migrationExistingLoginRoles: ["axel_migrator_previous"],
      runtimeCapabilityRole: "axel_runtime",
      runtimeLoginRole: "axel_runtime_20260828",
      runtimeExistingLoginRoles: ["axel_runtime_20260827"],
      runtimePassword: ROTATED_RUNTIME_PASSWORD,
      verifyCapabilityRole: "axel_verify",
      verifyLoginRole: "axel_verify_20260828",
      verifyExistingLoginRoles: ["axel_verify_20260827"],
      verifyPassword: ROTATED_VERIFY_PASSWORD,
    });
    assert.deepEqual(rotated, { tableCount: 3, sequenceCount: 2 });

    phase = "rotated_preflights";
    const rotatedRuntimeUrl =
      `postgresql://axel_runtime_20260828:${ROTATED_RUNTIME_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`;
    const rotatedRuntime = await connectPostgres(rotatedRuntimeUrl);
    clients.push(rotatedRuntime);
    await expectRuntimeVerificationDenied(rotatedRuntime, "axel_runtime_20260828");
    assert.deepEqual(
      await verifyDatabaseRuntimeRole(
        rotatedRuntime,
        runtimeVerificationOptions(
          "axel_runtime_20260828",
          ["axel_runtime_20260827"],
        ),
      ),
      { tableCount: 2, sequenceCount: 2 },
    );

    const rotatedVerifier = await connectPostgres(
      `postgresql://axel_verify_20260828:${ROTATED_VERIFY_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(rotatedVerifier);
    assert.equal(await metadataRoleVerdict(rotatedVerifier, "axel_verify_20260828"), 0);
    assert.equal(
      await metadataRoleVerdict(
        rotatedVerifier,
        "axel_verify_20260828",
        ["axel_verify_20260827"],
      ),
      1,
    );

    phase = "future_object_defaults";
    await owner.query(`
      CREATE TABLE public.postrotation_acl_probe(id bigserial PRIMARY KEY);
      CREATE FUNCTION public.postrotation_acl_probe_routine()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
    `);
    await rotatedRuntime.query("INSERT INTO public.postrotation_acl_probe DEFAULT VALUES");
    await expectDenied(rotatedRuntime, "SELECT public.postrotation_acl_probe_routine()");
    await expectDenied(rotatedVerifier, "SELECT * FROM public.postrotation_acl_probe");
    await expectDenied(rotatedVerifier, "SELECT public.postrotation_acl_probe_routine()");

    phase = "negative_preflights";
    const unsafeSearchPathUrl = new URL(rotatedRuntimeUrl);
    unsafeSearchPathUrl.searchParams.set("options", "-csearch_path=public,pg_catalog");
    const unsafeSearchPath = await connectPostgres(unsafeSearchPathUrl.href);
    clients.push(unsafeSearchPath);
    await expectRuntimeVerificationDenied(
      unsafeSearchPath,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );

    const disguisedRuntimeUrl = new URL(
      `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    disguisedRuntimeUrl.searchParams.set(
      "options",
      "-crole=axel_runtime_20260828 -csearch_path=pg_catalog,public",
    );
    const disguisedRuntime = await connectPostgres(disguisedRuntimeUrl.href);
    clients.push(disguisedRuntime);
    const disguisedIdentity = await disguisedRuntime.query("SELECT current_user, session_user");
    assert.deepEqual(disguisedIdentity.rows[0], {
      current_user: "axel_runtime_20260828",
      session_user: "postgres",
    });
    await expectRuntimeVerificationDenied(
      disguisedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );

    await owner.query("GRANT CREATE ON DATABASE axel TO axel_runtime");
    await expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    await owner.query("REVOKE CREATE ON DATABASE axel FROM axel_runtime");

    await owner.query("GRANT SELECT ON SEQUENCE public.app_table_id_seq TO axel_runtime");
    await expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    await owner.query("REVOKE SELECT ON SEQUENCE public.app_table_id_seq FROM axel_runtime");

    await owner.query("GRANT SELECT (filename) ON TABLE public.schema_migrations TO axel_runtime");
    await expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    await owner.query("REVOKE SELECT (filename) ON TABLE public.schema_migrations FROM axel_runtime");

    await owner.query("GRANT EXECUTE ON FUNCTION public.postrotation_acl_probe_routine() TO axel_runtime");
    await expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    await owner.query("REVOKE EXECUTE ON FUNCTION public.postrotation_acl_probe_routine() FROM axel_runtime");

    await admin.query(`
      CREATE ROLE axel_parent NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      GRANT axel_parent TO axel_runtime
        WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
    `);
    await expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    await admin.query("REVOKE axel_parent FROM axel_runtime; DROP ROLE axel_parent");

    phase = "non_system_effective_privilege_preflights";
    const expectRotatedRuntimePreflightDenied = () => expectRuntimeVerificationDenied(
      rotatedRuntime,
      "axel_runtime_20260828",
      ["axel_runtime_20260827"],
    );
    const rotatedMetadataVerdict = () => metadataRoleVerdict(
      rotatedVerifier,
      "axel_verify_20260828",
      ["axel_verify_20260827"],
    );

    await owner.query("GRANT SELECT ON TABLE public.app_table TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE SELECT ON TABLE public.app_table FROM PUBLIC");

    await owner.query("GRANT USAGE ON SEQUENCE public.app_table_id_seq TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE USAGE ON SEQUENCE public.app_table_id_seq FROM PUBLIC");

    await admin.query(`
      CREATE ROLE axel_rogue_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS
    `);
    await owner.query("GRANT SELECT ON TABLE public.app_table TO axel_rogue_reader");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE SELECT ON TABLE public.app_table FROM axel_rogue_reader");

    await owner.query("GRANT SELECT (value) ON TABLE public.app_table TO axel_rogue_reader");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE SELECT (value) ON TABLE public.app_table FROM axel_rogue_reader");
    await admin.query("DROP ROLE axel_rogue_reader");

    await owner.query("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC");

    await owner.query(`
      CREATE SCHEMA privilege_probe;
      CREATE TABLE privilege_probe.hidden_data(value text);
      CREATE SEQUENCE privilege_probe.hidden_sequence;
      CREATE FUNCTION privilege_probe.hidden_routine()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
    `);

    await owner.query("GRANT USAGE ON SCHEMA privilege_probe TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE USAGE ON SCHEMA privilege_probe FROM PUBLIC");

    await owner.query("GRANT SELECT ON TABLE privilege_probe.hidden_data TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE SELECT ON TABLE privilege_probe.hidden_data FROM PUBLIC");

    await owner.query("GRANT USAGE ON SEQUENCE privilege_probe.hidden_sequence TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE USAGE ON SEQUENCE privilege_probe.hidden_sequence FROM PUBLIC");

    await owner.query("GRANT EXECUTE ON FUNCTION privilege_probe.hidden_routine() TO PUBLIC");
    await expectRotatedRuntimePreflightDenied();
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query("REVOKE EXECUTE ON FUNCTION privilege_probe.hidden_routine() FROM PUBLIC");

    await owner.query(
      "GRANT SELECT ON TABLE privilege_probe.hidden_data TO axel_runtime_20260827",
    );
    await expectRotatedRuntimePreflightDenied();
    await owner.query(
      "REVOKE SELECT ON TABLE privilege_probe.hidden_data FROM axel_runtime_20260827",
    );

    await owner.query(
      "GRANT SELECT ON TABLE privilege_probe.hidden_data TO axel_verify_20260827",
    );
    assert.equal(await rotatedMetadataVerdict(), 0);
    await owner.query(
      "REVOKE SELECT ON TABLE privilege_probe.hidden_data FROM axel_verify_20260827",
    );
    await owner.query("DROP SCHEMA privilege_probe CASCADE");

    phase = "capability_child_allowlist_preflights";
    await admin.query(`
      CREATE ROLE axel_runtime_unlisted LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      ALTER ROLE axel_runtime_unlisted SET search_path = pg_catalog, public;
      GRANT axel_runtime TO axel_runtime_unlisted
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
    `);
    await expectRotatedRuntimePreflightDenied();
    await admin.query(
      "REVOKE axel_runtime FROM axel_runtime_unlisted; DROP ROLE axel_runtime_unlisted",
    );

    await admin.query(`
      CREATE ROLE axel_verify_unlisted LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      ALTER ROLE axel_verify_unlisted SET search_path = pg_catalog, public;
      ALTER ROLE axel_verify_unlisted SET default_transaction_read_only = on;
      GRANT axel_verify TO axel_verify_unlisted
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
    `);
    assert.equal(await rotatedMetadataVerdict(), 0);
    await admin.query(
      "REVOKE axel_verify FROM axel_verify_unlisted; DROP ROLE axel_verify_unlisted",
    );

    await admin.query(`
      GRANT axel_runtime TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET TRUE
    `);
    await expectRotatedRuntimePreflightDenied();
    await admin.query(`
      GRANT axel_runtime TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE
    `);

    await admin.query(`
      GRANT axel_verify TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET TRUE
    `);
    assert.equal(await rotatedMetadataVerdict(), 0);
    await admin.query(`
      GRANT axel_verify TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE
    `);

    await owner.query("GRANT SELECT (value) ON TABLE public.app_table TO axel_verify");
    assert.equal(
      await metadataRoleVerdict(
        rotatedVerifier,
        "axel_verify_20260828",
        ["axel_verify_20260827"],
      ),
      0,
    );
    await owner.query("REVOKE SELECT (value) ON TABLE public.app_table FROM axel_verify");

    assert.deepEqual(
      await verifyDatabaseRuntimeRole(
        rotatedRuntime,
        runtimeVerificationOptions(
          "axel_runtime_20260828",
          ["axel_runtime_20260827"],
        ),
      ),
      { tableCount: 3, sequenceCount: 3 },
    );
    assert.equal(
      await metadataRoleVerdict(
        rotatedVerifier,
        "axel_verify_20260828",
        ["axel_verify_20260827"],
      ),
      1,
    );

    const databaseLogs = spawnSync("docker", ["logs", CONTAINER_NAME], {
      encoding: "utf8",
    });
    const combinedDatabaseLogs = `${databaseLogs.stdout ?? ""}${databaseLogs.stderr ?? ""}`;
    assert.equal(combinedDatabaseLogs.includes(RUNTIME_PASSWORD), false);
    assert.equal(combinedDatabaseLogs.includes(VERIFY_PASSWORD), false);
    assert.equal(combinedDatabaseLogs.includes(ROTATED_RUNTIME_PASSWORD), false);
    assert.equal(combinedDatabaseLogs.includes(ROTATED_VERIFY_PASSWORD), false);
    assert.equal(combinedDatabaseLogs.includes("SCRAM-SHA-256$4096:"), true);
  } catch (error) {
    error.message = `${phase}: ${error.message}`;
    throw error;
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    if (process.env.AXEL_KEEP_PG17_ACCESS_TEST !== "1") {
      spawnSync("docker", ["stop", CONTAINER_NAME], { stdio: "ignore" });
    }
  }
});
