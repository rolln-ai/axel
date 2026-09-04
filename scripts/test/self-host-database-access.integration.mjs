import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  finalizeSelfHostDatabase,
  prepareSelfHostDatabase,
  SELF_HOST_DATABASE_ROLES,
  verifySelfHostDatabaseAccess,
} from "../self-host/database-access.mjs";
import {
  connectDisposablePostgres,
  connectPostgres,
} from "./postgres-integration-test-helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTAINER_NAME = `axel-selfhost-pg16-${process.pid}`;
const ADMIN_PASSWORD = "SelfHostAdminTestPassword_000000000000000000000";
const MIGRATION_PASSWORD = "SelfHostMigrationTestPassword_000000000000000000";
const DASHBOARD_PASSWORD = "SelfHostDashboardTestPassword_0000000000000000";
const DELIVERY_PASSWORD = "SelfHostDeliveryTestPassword_000000000000000000";
const SCHEMA_SQL = readFileSync(path.join(ROOT, "infra/postgres/schema.sql"), "utf8");
const MIGRATION_ROLE_SQL = readFileSync(
  path.join(ROOT, "scripts/verify-database-migration-role.sql"),
  "utf8",
);

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function expectDenied(client, sql) {
  await assert.rejects(client.query(sql), (error) => error?.code === "42501");
}

async function migrationRoleVerdict(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const variables = {
    expected_owner_role: roles.owner,
    expected_login_role: roles.migration,
    expected_login_roles_csv: roles.migration,
    expected_owner_parent_roles_csv: "",
    expected_owner_createrole: "0",
    expected_transitional_owner: "0",
    expected_canary_role: "",
    expected_runtime_capability_roles_csv:
      `${roles.dashboardCapability},${roles.deliveryCapability}`,
    expected_verify_capability_role: roles.metadataCapability,
  };
  let sql = MIGRATION_ROLE_SQL;
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(`:'${name}'`, `'${value}'`);
  }
  const result = await client.query(sql);
  return Number(Object.values(result.rows[0])[0]);
}

test("self-host database bootstrap gives dashboard and delivery independent profiles", {
  timeout: 180_000,
}, async () => {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    `POSTGRES_USER=${SELF_HOST_DATABASE_ROLES.admin}`,
    "-e",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "-e",
    "POSTGRES_DB=axel",
    "-p",
    "127.0.0.1::5432",
    "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
    "postgres",
    "-c",
    "log_statement=all",
  );

  const clients = [];
  let phase = "container_start";
  try {
    const portOutput = docker("port", CONTAINER_NAME, "5432/tcp").trim();
    const port = Number(portOutput.slice(portOutput.lastIndexOf(":") + 1));
    assert.ok(Number.isSafeInteger(port) && port > 0);

    const url = (role, password) =>
      `postgresql://${role}:${password}@127.0.0.1:${port}/axel?sslmode=disable`;
    const admin = await connectDisposablePostgres(
      url(SELF_HOST_DATABASE_ROLES.admin, ADMIN_PASSWORD),
    );
    clients.push(admin);

    phase = "legacy_role_seed";
    await admin.query(`
      CREATE ROLE ${SELF_HOST_DATABASE_ROLES.legacyRuntimeCapability}
        NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${SELF_HOST_DATABASE_ROLES.legacyRuntimeLogin}
        LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      GRANT ${SELF_HOST_DATABASE_ROLES.legacyRuntimeCapability}
        TO ${SELF_HOST_DATABASE_ROLES.legacyRuntimeLogin}
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
    `);
    await admin.query(`
      CREATE TABLE public.schema_migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query("SET search_path = public");
    await admin.query(SCHEMA_SQL);
    await admin.query("SET search_path = pg_catalog, public");
    await admin.query(`
      INSERT INTO public.workspaces (id, name)
      VALUES ('workspace-before-upgrade', 'Preserved workspace')
    `);

    phase = "prepare";
    await prepareSelfHostDatabase(admin, {
      migrationPassword: MIGRATION_PASSWORD,
      dashboardPassword: DASHBOARD_PASSWORD,
      deliveryPassword: DELIVERY_PASSWORD,
    });
    const legacyRoles = await admin.query(`
      SELECT rolname FROM pg_roles
       WHERE rolname = ANY($1::text[])
    `, [[
      SELF_HOST_DATABASE_ROLES.legacyRuntimeCapability,
      SELF_HOST_DATABASE_ROLES.legacyRuntimeLogin,
    ]]);
    assert.deepEqual(legacyRoles.rows, []);

    phase = "migration";
    const migration = await connectPostgres(
      url(SELF_HOST_DATABASE_ROLES.migration, MIGRATION_PASSWORD),
    );
    clients.push(migration);
    await migration.query("BEGIN");
    await migration.query(`SET LOCAL ROLE ${SELF_HOST_DATABASE_ROLES.owner}`);
    await migration.query("SET LOCAL search_path = public");
    await migration.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL
      )
    `);
    await migration.query(SCHEMA_SQL);
    await migration.query("COMMIT");

    phase = "finalize";
    await finalizeSelfHostDatabase(admin);
    await migration.query("BEGIN");
    await migration.query(`SET LOCAL ROLE ${SELF_HOST_DATABASE_ROLES.owner}`);
    await migration.query("SET LOCAL search_path = public");
    assert.equal(await migrationRoleVerdict(migration), 1);
    await migration.query("ROLLBACK");

    const dashboard = await connectPostgres(
      url(SELF_HOST_DATABASE_ROLES.dashboardLogin, DASHBOARD_PASSWORD),
    );
    const delivery = await connectPostgres(
      url(SELF_HOST_DATABASE_ROLES.deliveryLogin, DELIVERY_PASSWORD),
    );
    clients.push(dashboard, delivery);
    await verifySelfHostDatabaseAccess(admin, dashboard, delivery);
    assert.deepEqual(
      (await dashboard.query(`
        SELECT name FROM public.workspaces WHERE id = 'workspace-before-upgrade'
      `)).rows,
      [{ name: "Preserved workspace" }],
    );

    phase = "cross_database_grant";
    await admin.query(`
      GRANT CONNECT ON DATABASE postgres
        TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_service_boundary_invalid/,
    );
    await admin.query(`
      REVOKE CONNECT ON DATABASE postgres
        FROM ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);

    phase = "shared_object_ownership";
    await admin.query(`
      CREATE FOREIGN DATA WRAPPER axel_selfhost_test_fdw;
      GRANT USAGE ON FOREIGN DATA WRAPPER axel_selfhost_test_fdw
        TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability};
      CREATE SERVER axel_selfhost_test_server
        FOREIGN DATA WRAPPER axel_selfhost_test_fdw;
      ALTER SERVER axel_selfhost_test_server
        OWNER TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability};
    `);
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_ownership_boundary_invalid/,
    );
    await admin.query(`
      ALTER SERVER axel_selfhost_test_server OWNER TO ${SELF_HOST_DATABASE_ROLES.admin};
      DROP SERVER axel_selfhost_test_server;
      REVOKE USAGE ON FOREIGN DATA WRAPPER axel_selfhost_test_fdw
        FROM ${SELF_HOST_DATABASE_ROLES.deliveryCapability};
      DROP FOREIGN DATA WRAPPER axel_selfhost_test_fdw;
    `);

    phase = "profile_boundaries";
    await dashboard.query(`
      INSERT INTO public.workspaces (id, name)
      VALUES ('workspace-self-host', 'Self-host workspace')
    `);
    assert.deepEqual(
      (await delivery.query(`
        SELECT name FROM public.workspaces WHERE id = 'workspace-self-host'
      `)).rows,
      [{ name: "Self-host workspace" }],
    );
    await expectDenied(delivery, `
      UPDATE public.workspaces SET name = 'delivery-write'
       WHERE id = 'workspace-self-host'
    `);
    await delivery.query(`
      INSERT INTO public.queue_quarantine (
        queue_name, cloudflare_message_id, failure_code, attempts,
        body_sha256, body_size_bytes
      ) VALUES (
        'delivery', 'message-self-host', 'invalid_envelope', 1,
        repeat('a', 64), 0
      )
    `);
    await delivery.query("SELECT * FROM public.backfill_jobs LIMIT 0");
    await delivery.query("UPDATE public.backfill_jobs SET state = state WHERE false");
    await delivery.query("SELECT * FROM public.erasure_subjects LIMIT 0");
    await delivery.query("DELETE FROM public.erasure_subjects WHERE false");
    await expectDenied(dashboard, "SELECT * FROM public.queue_quarantine");
    await expectDenied(dashboard, "SELECT * FROM public.schema_migrations");
    await expectDenied(delivery, "SELECT * FROM public.schema_migrations");
    await expectDenied(delivery, "SELECT * FROM public.admin_mfa_methods");
    await expectDenied(dashboard, "CREATE TABLE public.dashboard_owned(id integer)");
    await expectDenied(delivery, "CREATE TEMP TABLE delivery_temp(id integer)");
    await expectDenied(delivery, `SET ROLE ${SELF_HOST_DATABASE_ROLES.owner}`);

    phase = "future_relations_denied";
    await migration.query("BEGIN");
    await migration.query(`SET LOCAL ROLE ${SELF_HOST_DATABASE_ROLES.owner}`);
    await migration.query(`
      CREATE TABLE public.unreviewed_future_table(id bigserial PRIMARY KEY);
      CREATE FUNCTION public.unreviewed_future_routine()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
    `);
    await migration.query("COMMIT");
    await expectDenied(dashboard, "SELECT * FROM public.unreviewed_future_table");
    await expectDenied(delivery, "INSERT INTO public.unreviewed_future_table DEFAULT VALUES");
    await expectDenied(dashboard, "SELECT public.unreviewed_future_routine()");
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_relation_inventory_invalid/,
    );
    await migration.query("BEGIN");
    await migration.query(`SET LOCAL ROLE ${SELF_HOST_DATABASE_ROLES.owner}`);
    await migration.query(`
      DROP TABLE public.unreviewed_future_table;
      DROP FUNCTION public.unreviewed_future_routine();
    `);
    await migration.query("COMMIT");

    phase = "rogue_grants";
    await admin.query(`
      GRANT SELECT ON TABLE public.admin_mfa_methods
        TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_/,
    );
    await admin.query(`
      REVOKE SELECT ON TABLE public.admin_mfa_methods
        FROM ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);
    await admin.query(`
      GRANT SELECT (user_id) ON TABLE public.admin_mfa_methods
        TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_unexpected_acl_present/,
    );
    await admin.query(`
      REVOKE SELECT (user_id) ON TABLE public.admin_mfa_methods
        FROM ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);

    phase = "rogue_default_grant";
    await admin.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${SELF_HOST_DATABASE_ROLES.owner}
        IN SCHEMA public GRANT SELECT ON TABLES
        TO ${SELF_HOST_DATABASE_ROLES.deliveryCapability}
    `);
    await assert.rejects(
      verifySelfHostDatabaseAccess(admin, dashboard, delivery),
      /self_host_database_unexpected_acl_present/,
    );
    await finalizeSelfHostDatabase(admin);
    await verifySelfHostDatabaseAccess(admin, dashboard, delivery);

    phase = "scram_and_logs";
    const scram = await admin.query(`
      SELECT count(*)::integer AS count
        FROM pg_authid
       WHERE rolname = ANY($1::text[])
         AND rolpassword LIKE 'SCRAM-SHA-256$%'
    `, [[
      SELF_HOST_DATABASE_ROLES.migration,
      SELF_HOST_DATABASE_ROLES.dashboardLogin,
      SELF_HOST_DATABASE_ROLES.deliveryLogin,
    ]]);
    assert.equal(scram.rows[0]?.count, 3);
    const logResult = spawnSync("docker", ["logs", CONTAINER_NAME], { encoding: "utf8" });
    assert.equal(logResult.status, 0);
    const logs = `${logResult.stdout}${logResult.stderr}`;
    for (const password of [MIGRATION_PASSWORD, DASHBOARD_PASSWORD, DELIVERY_PASSWORD]) {
      assert.equal(logs.includes(password), false);
    }
  } catch (error) {
    error.message = `${error.message} (phase=${phase})`;
    throw error;
  } finally {
    for (const client of clients.reverse()) {
      await client.end().catch(() => {});
    }
    spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
  }
});
