import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { databaseServiceRoleOptionsFromEnv, verifyDatabaseServiceRole, verifyRenderMaintenanceDatabase } from "../verify-database-service-role.mjs";
import { provisionDatabaseServiceRoles } from "../provision-database-service-roles.mjs";
import { prepareRenderDatabase, verifyRenderMigration } from "../render-database-access.mjs";
import { connectDisposablePostgres, connectPostgres } from "./postgres-integration-test-helpers.mjs";

test("Render owner provisions and verifies real service access without provider superuser operations", {
  skip: process.env.AXEL_RUN_POSTGRES_INTEGRATION !== "1", timeout: 120000,
}, async () => {
  const container = `axel-render-access-${process.pid}`;
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const clients = [];
  docker("run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=synthetic-admin", "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73");
  try {
    const port = docker("port", container, "5432/tcp").trim().split(":").at(-1);
    const url = (user, password, database = "axel") => `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
    const admin = await connectDisposablePostgres(url("postgres", "synthetic-admin", "postgres"));
    await admin.query("CREATE ROLE axel LOGIN INHERIT CREATEDB CREATEROLE PASSWORD 'synthetic-owner'");
    await admin.query("CREATE DATABASE axel OWNER axel");
    await admin.end(); // No elevated operations after the provider creates its default owner.
    const owner = await connectPostgres(url("axel", "synthetic-owner"));
    clients.push(owner);
    await owner.query("ALTER SCHEMA public OWNER TO axel; SET search_path = public");
    await owner.query(readFileSync(new URL("../../infra/postgres/schema.sql", import.meta.url), "utf8"));
    await owner.query("CREATE TABLE schema_migrations(filename text PRIMARY KEY, sha256 text NOT NULL)");
    await owner.query("CREATE TABLE legacy_events(id bigserial PRIMARY KEY, payload jsonb)");
    await owner.query(`CREATE EXTENSION pg_trgm;
      CREATE ROLE axel_delivery_canary_writer LOGIN NOINHERIT CONNECTION LIMIT 4;
      ALTER ROLE axel_delivery_canary_writer SET search_path = pg_catalog, public;
      ALTER ROLE axel_delivery_canary_writer SET statement_timeout = '10s';
      ALTER ROLE axel_delivery_canary_writer SET idle_in_transaction_session_timeout = '15s';
      GRANT CONNECT ON DATABASE axel TO axel_delivery_canary_writer;
      GRANT USAGE ON SCHEMA public TO axel_delivery_canary_writer;
      GRANT INSERT(payload) ON delivery_canary_receipts TO axel_delivery_canary_writer;
    `);
    const options = databaseServiceRoleOptionsFromEnv({ DATABASE_ACCESS_MODE: "render", DATABASE_MIGRATION_ROLE: "axel", DATABASE_SERVICE_REQUIRE_FINAL_STATE: "1" });
    const verifyPassword = "Synthetic_verify_password_abcdefghijklmnopqrstuvwxyz";
    await owner.query("CREATE INDEX test_trgm_dependency ON workspaces USING gin(name gin_trgm_ops)");
    await assert.rejects(prepareRenderDatabase(owner, options, verifyPassword), { code: "2BP01" });
    assert.equal((await owner.query("SELECT count(*)::integer n FROM pg_extension WHERE extname='pg_trgm'")).rows[0].n, 1);
    await owner.query("DROP INDEX test_trgm_dependency");
    await prepareRenderDatabase(owner, options, verifyPassword);
    const passwords = Object.fromEntries(Object.keys(options.registry).map((profile, i) => [profile, `Synthetic_service_${i}_abcdefghijklmnopqrstuvwxyz0123456789`]));
    await provisionDatabaseServiceRoles(owner, { ...options, passwords });
    await verifyRenderMigration(owner, options);
    await verifyRenderMaintenanceDatabase(url("axel", "synthetic-owner"), options);
    const runtime = {};
    for (const [profile, entry] of Object.entries(options.registry)) {
      const client = await connectPostgres(url(entry.loginRole, passwords[profile]));
      clients.push(client);
      runtime[profile] = client;
      await verifyDatabaseServiceRole(client, { ...options, profile, expectedConnectionRole: entry.loginRole });
      for (const sql of ["SET ROLE axel", "CREATE TABLE forbidden(id int)", "SELECT * FROM schema_migrations", "SELECT * FROM legacy_events", "INSERT INTO legacy_events(payload) VALUES ('{}')", "CREATE TEMP TABLE forbidden(id int)", "CREATE ROLE forbidden"]) {
        await assert.rejects(client.query(sql), { code: "42501" });
      }
    }
    const metadata = await connectPostgres(url(options.verifyLoginRoles[0], verifyPassword));
    clients.push(metadata);
    await verifyDatabaseServiceRole(metadata, { ...options, expectedConnectionRole: options.verifyLoginRoles[0] });
    await assert.rejects(metadata.query("SELECT * FROM users"), { code: "42501" });

    // Exercise the nested invoker calls, not just catalog ACL strings.
    const dashboard = runtime.dashboard;
    await dashboard.query("INSERT INTO workspaces(id,name) VALUES ('probe','probe')");
    await dashboard.query("INSERT INTO sources(id,workspace_id,name,secret_token_hash,status) VALUES ('probe','probe','probe','synthetic','active')");
    await dashboard.query("INSERT INTO data_contracts(id,workspace_id,source_id,name) VALUES ('probe','probe','probe','probe')");
    const version = await dashboard.query(`INSERT INTO data_contract_versions(id,data_contract_id,workspace_id,version_number,inferred_schema)
      VALUES ('probe','probe','probe',1,'{"type":"object","examples":["private-value"]}') RETURNING inferred_schema`);
    assert.equal(JSON.stringify(version.rows).includes("private-value"), false);
    const billing = await dashboard.query("INSERT INTO billing_events(id,type,payload) VALUES ('probe','probe','{\"secret\":true}') RETURNING payload");
    assert.deepEqual(billing.rows[0].payload, {});
    await assert.rejects(runtime["delivery-native"].query("DELETE FROM users"), { code: "42501" });

    // The one provider maintenance database exception must not cover others.
    await owner.query("CREATE DATABASE unrelated");
    await assert.rejects(verifyRenderMigration(owner, options), /boundary_privilege_mismatch/);
    await owner.query("REVOKE ALL ON DATABASE unrelated FROM PUBLIC");
    await verifyRenderMigration(owner, options);
    await owner.query("GRANT SELECT ON users TO PUBLIC");
    await assert.rejects(verifyRenderMigration(owner, options), /acl_grantee_inventory_mismatch/);
    await owner.query("REVOKE SELECT ON users FROM PUBLIC");
    await owner.query("CREATE FUNCTION unsafe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
    await assert.rejects(verifyRenderMigration(owner, options), /public_ownership_mismatch/);
    await owner.query("DROP FUNCTION unsafe()");
    await verifyRenderMigration(owner, options);

    const root = fileURLToPath(new URL("../../", import.meta.url));
    const migrations = new URL("../../infra/postgres/migrations/", import.meta.url);
    for (const filename of readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < "0076_")) {
      const sha = createHash("sha256").update(readFileSync(new URL(filename, migrations))).digest("hex");
      await owner.query("INSERT INTO schema_migrations(filename,sha256) VALUES($1,$2)", [filename, sha]);
    }
    // Exercise a real 0075 -> 0076 upgrade, not a new database whose schema
    // snapshot already contains the future tables and grants.
    await owner.query(`DROP TABLE alert_email_outbox, pipeline_incidents;
      ALTER TABLE sources DROP COLUMN alert_after_minutes, DROP COLUMN flow_monitoring_enabled;
      DROP INDEX sources_workspace_identity_idx;
      ALTER TABLE workspaces DROP COLUMN impact_monitor_checked_at;`);
    await assert.rejects(verifyDatabaseServiceRole(runtime.dashboard, { ...options, profile: "dashboard", expectedConnectionRole: options.registry.dashboard.loginRole }), /schema_inventory_mismatch/);
    await verifyRenderMigration(owner, options);
    await owner.query("ALTER TABLE users RENAME TO users_missing");
    await assert.rejects(verifyRenderMigration(owner, options), /schema_inventory_mismatch/);
    await owner.query("ALTER TABLE users_missing RENAME TO users");
    const migrationEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: url("axel", "synthetic-owner"), DATABASE_ACCESS_MODE: "render",
      DATABASE_MIGRATION_ROLE: "axel", DATABASE_SERVICE_REQUIRE_FINAL_STATE: "1" };
    for (let run = 0; run < 2; run++) {
      execFileSync("bash", ["scripts/run-migrations.sh"], { cwd: root, env: migrationEnv, stdio: ["ignore", "pipe", "pipe"] });
    }
    assert.equal((await owner.query("SELECT count(*)::integer n FROM schema_migrations WHERE filename = '0076_impact_alerts.sql'")).rows[0].n, 1);
    await verifyDatabaseServiceRole(runtime.dashboard, { ...options, profile: "dashboard", expectedConnectionRole: options.registry.dashboard.loginRole });
    await verifyRenderMigration(owner, options);
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    docker("rm", "-f", container);
  }
});
