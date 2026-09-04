#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { postgresScramSha256Verifier } from "./provision-database-service-roles.mjs";
import { databaseServiceRoleOptionsFromEnv, validateDatabaseServiceRoleOptions, verifyDatabaseServiceRole, verifyRenderMaintenanceDatabase } from "./verify-database-service-role.mjs";

export async function requireRenderOwner(client, options) {
  if (!options.managedOwnerLogin) throw new Error("render_database_mode_required");
  const result = await client.query(`
    SELECT current_user = $1 AND session_user = $1
      AND current_setting('server_version_num')::integer >= 170000
      AND NOT role.rolsuper AND role.rolcanlogin AND role.rolcreaterole
      AND role.rolcreatedb AND role.rolinherit
      AND NOT role.rolreplication AND NOT role.rolbypassrls
      AND role.rolconfig IS NULL
      AND database.datdba = role.oid AS allowed
    FROM pg_roles role JOIN pg_database database ON database.datname = current_database()
    WHERE role.rolname = $1
  `, [options.ownerRole]);
  if (result.rows[0]?.allowed !== true) throw new Error("render_database_owner_mismatch");
}

// Run once using the provider owner credential, which stays in the protected
// migration environment. Runtime credentials are provisioned separately.
export async function prepareRenderDatabase(client, options, verifyPassword) {
  options = validateDatabaseServiceRoleOptions(options);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(verifyPassword ?? "")) throw new Error("render_database_verify_password_invalid");
  await client.query("BEGIN");
  try {
    await requireRenderOwner(client, options);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('axel-database-service-roles-v1', 0))");
    // These extensions belonged to the removed EDKG feature. RESTRICT refuses
    // to remove either if any application object still depends on it.
    await client.query("DROP EXTENSION IF EXISTS vector RESTRICT");
    await client.query("DROP EXTENSION IF EXISTS pg_trgm RESTRICT");
    const capability = options.verifyCapabilityRole;
    const login = options.verifyLoginRoles[0];
    await client.query(`CREATE ROLE "${capability}" NOLOGIN NOINHERIT`);
    await client.query("SELECT set_config('axel.verify_password', $1, true)", [postgresScramSha256Verifier(verifyPassword)]);
    await client.query(`DO $axel$ BEGIN
      EXECUTE format('CREATE ROLE %I LOGIN INHERIT PASSWORD %L', '${login}', current_setting('axel.verify_password'));
    END $axel$`);
    await client.query(`GRANT "${capability}" TO "${login}" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`);
    await client.query(`ALTER ROLE "${login}" SET search_path = pg_catalog, public`);
    await client.query(`ALTER ROLE "${login}" SET default_transaction_read_only = on`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function verifyRenderMigration(client, options) {
  await requireRenderOwner(client, options);
  await verifyDatabaseServiceRole(client, { ...options, requireIdentity: false });
}

async function main() {
  const command = process.argv[2];
  if (!["prepare", "verify-migration"].includes(command)) throw new Error("render_database_command_invalid");
  const options = databaseServiceRoleOptionsFromEnv(process.env);
  const connectionString = command === "verify-migration" ? process.env.DATABASE_URL : process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) throw new Error("render_database_url_required");
  const client = new pg.Client({ connectionString, ssl: controlPlanePgSslOption(connectionString, process.env.CONTROL_PLANE_DB_SSL_VERIFY),
    application_name: "axel-migration", connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  try {
    await client.connect();
    if (command === "prepare") {
      if (process.env.AXEL_HOSTED_DATABASE_BOOTSTRAP_CONFIRM !== "I_UNDERSTAND_THIS_CHANGES_DATABASE_ROLES") throw new Error("render_database_confirmation_required");
      await prepareRenderDatabase(client, options, process.env.DATABASE_VERIFY_PASSWORD);
    } else {
      await client.query("BEGIN READ ONLY");
      await verifyRenderMigration(client, options);
      await client.query("ROLLBACK");
      await verifyRenderMaintenanceDatabase(connectionString, options, process.env.CONTROL_PLANE_DB_SSL_VERIFY);
    }
    console.log("render_database_access_ready");
  } finally { await client.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(/^(render_database|database_service)_[a-z_]+$/.test(error.message ?? "") ? error.message : "render_database_access_failed");
    process.exitCode = 1;
  });
}
