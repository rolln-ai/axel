import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
  DATABASE_SERVICE_PROFILE_NAMES,
} from "../database-service-access-profiles.mjs";
import { provisionDatabaseServiceRoles } from "../provision-database-service-roles.mjs";
import { verifyDatabaseServiceRole } from "../verify-database-service-role.mjs";
import {
  connectDisposablePostgres,
  connectPostgres,
} from "./postgres-integration-test-helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTAINER = `axel-pg17-service-roles-${process.pid}`;
const ADMIN_PASSWORD = "disposable-admin-only";
const MIGRATOR_PASSWORD = "disposable-migrator-only";
const VERIFY_PASSWORD = "disposable-verifier-only";
const shouldRun = process.env.AXEL_RUN_POSTGRES_INTEGRATION === "1";
const MIGRATION_ROLE_SQL = readFileSync(
  path.join(ROOT, "scripts/verify-database-migration-role.sql"),
  "utf8",
);
const ERASURE_INDEX_SOURCE = readFileSync(
  path.join(ROOT, "apps/delivery-service/src/internal-erasure-index.ts"),
  "utf8",
);
const ERASURE_INDEX_SQL = ERASURE_INDEX_SOURCE.match(
  /dependencies\.pool\.query<IndexResultRow>\(\s*`([\s\S]*?)`,/,
)?.[1];

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function roleStem(profile) {
  return profile.replaceAll("-", "_");
}

function registryFor(date, priorRegistry) {
  return Object.fromEntries(
    DATABASE_SERVICE_PROFILE_NAMES.map((profile) => [profile, {
      capabilityRole: `axel_${roleStem(profile)}`,
      loginRole: `axel_${roleStem(profile)}_${date}`,
      existingLoginRoles: priorRegistry ? [priorRegistry[profile].loginRole] : [],
    }]),
  );
}

function passwordsFor(date) {
  return Object.fromEntries(
    DATABASE_SERVICE_PROFILE_NAMES.map((profile, index) => [
      profile,
      `ServiceCredential_${date}_${index}_abcdefghijklmnopqrstuvwxyz`,
    ]),
  );
}

function optionsFor(registry, passwords) {
  const serviceParents = DATABASE_SERVICE_PROFILE_NAMES.flatMap((profile) => [
    registry[profile].capabilityRole,
    registry[profile].loginRole,
    ...registry[profile].existingLoginRoles,
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
    passwords,
  };
}

async function expectPrivilegeMismatch(client, options) {
  await assert.rejects(
    verifyDatabaseServiceRole(client, options),
    /database_service_/,
  );
}

async function migrationRoleVerdict(client, options) {
  const variables = {
    expected_owner_role: options.ownerRole,
    expected_login_role: options.migrationLoginRoles[0],
    expected_login_roles_csv: options.migrationLoginRoles.join(","),
    expected_owner_parent_roles_csv: options.ownerParentRoles.join(","),
    expected_owner_createrole: "1",
    expected_transitional_owner: options.transitionalOwnerLoginRole ? "1" : "0",
    expected_canary_role: "axel_delivery_canary_writer",
    expected_runtime_capability_roles_csv: DATABASE_SERVICE_PROFILE_NAMES.map(
      (profile) => options.registry[profile].capabilityRole,
    ).join(","),
    expected_verify_capability_role: options.verifyCapabilityRole,
  };
  let sql = MIGRATION_ROLE_SQL;
  for (const [name, value] of Object.entries(variables)) {
    sql = sql.replaceAll(`:'${name}'`, `'${value}'`);
  }
  const result = await client.query(sql);
  return Number(Object.values(result.rows[0])[0]);
}

test("service profiles provision, rotate, and fail closed on PostgreSQL 17", {
  skip: !shouldRun,
  timeout: 180_000,
}, async () => {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
  );

  const clients = [];
  let phase = "container_start";
  try {
    const portText = docker("port", CONTAINER, "5432/tcp").trim();
    const port = Number(portText.slice(portText.lastIndexOf(":") + 1));
    assert.ok(Number.isSafeInteger(port) && port > 0);

    phase = "database_setup";
    const admin = await connectDisposablePostgres(
      `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/postgres?sslmode=disable`,
    );
    clients.push(admin);
    await admin.query(`
      CREATE ROLE axel_owner LOGIN INHERIT CREATEROLE
        NOSUPERUSER CREATEDB NOREPLICATION NOBYPASSRLS;
      CREATE ROLE axel_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT axel_owner TO axel_migrator
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    `);
    await admin.query("CREATE DATABASE axel OWNER axel_owner");
    await admin.query(`
      REVOKE ALL PRIVILEGES ON DATABASE postgres FROM PUBLIC;
      REVOKE ALL PRIVILEGES ON DATABASE axel FROM PUBLIC;
      GRANT CONNECT ON DATABASE axel TO axel_migrator;
    `);
    const adminAxel = await connectPostgres(
      `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(adminAxel);
    const migratorUrl =
      `postgresql://axel_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:${port}/axel?sslmode=disable`;
    const ownerUrl = new URL(migratorUrl);
    ownerUrl.searchParams.set("options", "-crole=axel_owner -csearch_path=pg_catalog,public");
    const owner = await connectPostgres(ownerUrl.href);
    clients.push(owner);
    await owner.query(`
      ALTER SCHEMA public OWNER TO axel_owner;
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
      CREATE TABLE public.schema_migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL
      );
    `);
    await owner.query("SET search_path = public");
    await owner.query(readFileSync(path.join(ROOT, "infra/postgres/schema.sql"), "utf8"));
    await owner.query("SET search_path = pg_catalog, public");
    await owner.query("CREATE EXTENSION pgcrypto WITH SCHEMA public");
    const providerOwnedExtensionRoutines = await adminAxel.query(`
      SELECT count(*)::integer AS count
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_depend dependency
          ON dependency.classid = 'pg_proc'::regclass
         AND dependency.objid = routine.oid
         AND dependency.deptype = 'e'
       WHERE namespace.nspname = 'public'
         AND routine.proowner <> 'axel_owner'::regrole
    `);
    assert.ok(providerOwnedExtensionRoutines.rows[0].count > 0);
    await adminAxel.query(
      "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC",
    );
    await owner.query(`
      CREATE ROLE axel_verify NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      CREATE ROLE axel_verify_20260827 LOGIN INHERIT PASSWORD '${VERIFY_PASSWORD}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT axel_verify TO axel_verify_20260827
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
      ALTER ROLE axel_verify_20260827 SET search_path = pg_catalog, public;
      ALTER ROLE axel_verify_20260827 SET default_transaction_read_only = on;
      GRANT CONNECT ON DATABASE axel TO axel_verify;
      GRANT USAGE ON SCHEMA public TO axel_verify;
      CREATE ROLE axel_delivery_canary_writer
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
      ALTER ROLE axel_delivery_canary_writer SET search_path = pg_catalog, public;
      ALTER ROLE axel_delivery_canary_writer SET statement_timeout = '10s';
      ALTER ROLE axel_delivery_canary_writer
        SET idle_in_transaction_session_timeout = '15s';
      GRANT CONNECT ON DATABASE axel TO axel_delivery_canary_writer;
      GRANT USAGE ON SCHEMA public TO axel_delivery_canary_writer;
      GRANT INSERT (payload) ON TABLE public.delivery_canary_receipts
        TO axel_delivery_canary_writer;
    `);

    phase = "initial_provision";
    const initialRegistry = registryFor("20260827");
    const initialPasswords = passwordsFor("20260827");
    const initialOptions = optionsFor(initialRegistry, initialPasswords);
    const initialOverlapOptions = {
      ...initialOptions,
      transitionalOwnerLoginRole: "axel_owner",
      requireFinalState: false,
    };
    assert.deepEqual(
      await provisionDatabaseServiceRoles(owner, initialOverlapOptions),
      { profileCount: 5 },
    );
    await owner.query("SET search_path = public");
    assert.equal(await migrationRoleVerdict(owner, initialOverlapOptions), 1);
    await owner.query("SET search_path = pg_catalog, public");

    phase = "candidate_verification";
    const profileClients = new Map();
    for (const profile of DATABASE_SERVICE_PROFILE_NAMES) {
      const candidate = await connectPostgres(
        `postgresql://${initialRegistry[profile].loginRole}:${initialPasswords[profile]}@127.0.0.1:${port}/axel?sslmode=disable`,
      );
      clients.push(candidate);
      profileClients.set(profile, candidate);
      assert.equal(
        (await verifyDatabaseServiceRole(candidate, { ...initialOverlapOptions, profile })).profile,
        profile,
      );
    }
    const dashboard = profileClients.get("dashboard");
    const native = profileClients.get("delivery-native");
    const workers = profileClients.get("delivery-workers");
    const pull = profileClients.get("pull-worker");
    const edge = profileClients.get("delivery-edge");
    await assert.rejects(dashboard.query("SELECT * FROM public.schema_migrations"), /permission denied/);

    phase = "billing_payload_guard";
    const billingFunctionPrivilege = await dashboard.query(`
      SELECT pg_catalog.has_function_privilege(
        CURRENT_USER,
        'public.axel_minimize_billing_event_payload()',
        'EXECUTE'
      ) AS can_execute
    `);
    assert.equal(billingFunctionPrivilege.rows[0]?.can_execute, false);
    const billingInsert = await dashboard.query(`
      INSERT INTO public.billing_events (id, type, payload)
      VALUES ('billing-service-role-probe', 'test.service_role',
              pg_catalog.jsonb_build_object('unexpected', true))
      RETURNING payload
    `);
    assert.deepEqual(billingInsert.rows[0]?.payload, {});
    const billingUpdate = await dashboard.query(`
      UPDATE public.billing_events
         SET payload = pg_catalog.jsonb_build_object('unexpected', true)
       WHERE id = 'billing-service-role-probe'
      RETURNING payload
    `);
    assert.deepEqual(billingUpdate.rows[0]?.payload, {});

    phase = "provider_extension_public_execute";
    await adminAxel.query(
      "GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO PUBLIC",
    );
    await expectPrivilegeMismatch(edge, {
      ...initialOverlapOptions,
      profile: "delivery-edge",
    });
    await adminAxel.query(
      "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC",
    );
    await admin.query(`
      ALTER ROLE axel_owner
        NOLOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER
        NOREPLICATION NOBYPASSRLS PASSWORD NULL
    `);
    await owner.query("SET search_path = public");
    assert.equal(await migrationRoleVerdict(owner, initialOptions), 1);
    await owner.query("SET search_path = pg_catalog, public");
    for (const profile of DATABASE_SERVICE_PROFILE_NAMES) {
      assert.equal(
        (await verifyDatabaseServiceRole(profileClients.get(profile), {
          ...initialOptions,
          profile,
        })).profile,
        profile,
      );
    }
    await assert.rejects(edge.query("SELECT * FROM public.users"), /permission denied/);
    await assert.rejects(workers.query("SELECT * FROM public.queue_quarantine"), /permission denied/);
    await assert.rejects(pull.query("SELECT * FROM public.workspaces"), /permission denied/);

    phase = "erasure_index_insert";
    await owner.query(`
      INSERT INTO public.workspaces (id, name) VALUES ('workspace-test', 'Workspace test');
      INSERT INTO public.sources (id, workspace_id, name, secret_token_hash, status)
      VALUES ('source-test', 'workspace-test', 'Source test', 'not-a-token', 'active');
    `);
    assert.equal(typeof ERASURE_INDEX_SQL, "string");
    assert.match(ERASURE_INDEX_SQL, /ON CONFLICT DO NOTHING/);
    assert.doesNotMatch(ERASURE_INDEX_SQL, /ON CONFLICT\s*\(/);
    const erasureValues = [
      "source-test",
      ["sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      "event-test",
      "events/workspace-test/2026-08-27/event-test",
      "2026-08-27T12:00:00.000Z",
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await native.query(ERASURE_INDEX_SQL, erasureValues);
      assert.deepEqual(result.rows[0], { source_exists: true, r2_key_matches: true });
    }
    const erasureCount = await owner.query(`
      SELECT count(*)::integer AS count
        FROM public.erasure_subjects
       WHERE workspace_id = 'workspace-test'
         AND event_id = 'event-test'
    `);
    assert.equal(erasureCount.rows[0]?.count, 1);
    await assert.rejects(native.query("SELECT * FROM public.erasure_subjects"), /permission denied/);

    phase = "rogue_table_grant";
    await owner.query("GRANT SELECT ON TABLE public.users TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("REVOKE SELECT ON TABLE public.users FROM axel_delivery_edge");

    phase = "rogue_column_grant";
    await owner.query("GRANT SELECT (id) ON TABLE public.users TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("REVOKE SELECT (id) ON TABLE public.users FROM axel_delivery_edge");

    phase = "rogue_public_grant";
    await owner.query("GRANT SELECT ON TABLE public.users TO PUBLIC");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("REVOKE SELECT ON TABLE public.users FROM PUBLIC");

    phase = "rogue_routine_grant";
    await owner.query("CREATE FUNCTION public.role_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    await owner.query("GRANT EXECUTE ON FUNCTION public.role_probe() TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("DROP FUNCTION public.role_probe()");

    phase = "rogue_default_grant";
    await owner.query("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM axel_delivery_edge");

    phase = "unknown_relation";
    await owner.query("CREATE TABLE public.unreviewed_table(id integer)");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await owner.query("DROP TABLE public.unreviewed_table");

    phase = "powerful_parent";
    await admin.query(`
      CREATE ROLE axel_rogue_parent NOLOGIN NOINHERIT CREATEROLE
        NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;
      GRANT axel_rogue_parent TO axel_delivery_edge
        WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
    `);
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await admin.query("REVOKE axel_rogue_parent FROM axel_delivery_edge; DROP ROLE axel_rogue_parent");

    phase = "service_role_ownership";
    await adminAxel.query("ALTER TABLE public.users OWNER TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await adminAxel.query("ALTER TABLE public.users OWNER TO axel_owner");

    phase = "cross_database_grant";
    await admin.query("GRANT CONNECT ON DATABASE postgres TO axel_delivery_edge");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await admin.query("REVOKE CONNECT ON DATABASE postgres FROM axel_delivery_edge");

    phase = "verify_role_ownership";
    await adminAxel.query("CREATE TYPE public.verify_owned_type AS ENUM ('test')");
    await adminAxel.query("ALTER TYPE public.verify_owned_type OWNER TO axel_verify");
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await adminAxel.query("ALTER TYPE public.verify_owned_type OWNER TO axel_owner");
    await adminAxel.query("DROP TYPE public.verify_owned_type");

    phase = "verify_role_default_acl_ownership";
    await adminAxel.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_verify IN SCHEMA public
        GRANT SELECT ON TABLES TO axel_delivery_edge
    `);
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await adminAxel.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_verify IN SCHEMA public
        REVOKE SELECT ON TABLES FROM axel_delivery_edge
    `);

    phase = "service_shared_object_ownership";
    await adminAxel.query(`
      CREATE FOREIGN DATA WRAPPER axel_test_fdw;
      GRANT USAGE ON FOREIGN DATA WRAPPER axel_test_fdw TO axel_delivery_edge;
      CREATE SERVER axel_test_server FOREIGN DATA WRAPPER axel_test_fdw;
      ALTER SERVER axel_test_server OWNER TO axel_delivery_edge;
    `);
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await adminAxel.query(`
      ALTER SERVER axel_test_server OWNER TO postgres;
      DROP SERVER axel_test_server;
      REVOKE USAGE ON FOREIGN DATA WRAPPER axel_test_fdw FROM axel_delivery_edge;
      DROP FOREIGN DATA WRAPPER axel_test_fdw;
    `);

    phase = "reviewed_legacy_overlap";
    await admin.query(`
      CREATE ROLE axel_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      CREATE ROLE axel_runtime_legacy LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS;
      GRANT axel_runtime TO axel_runtime_legacy
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
      GRANT axel_runtime TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
      GRANT axel_runtime_legacy TO axel_owner
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    `);
    await adminAxel.query("GRANT CONNECT ON DATABASE axel TO axel_runtime");
    await adminAxel.query("GRANT USAGE ON SCHEMA public TO axel_runtime");
    for (const table of APPLICATION_TABLES) {
      await adminAxel.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${table}" TO axel_runtime`,
      );
    }
    for (const sequence of APPLICATION_SEQUENCES) {
      await adminAxel.query(`GRANT USAGE ON SEQUENCE public."${sequence}" TO axel_runtime`);
    }
    await adminAxel.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO axel_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO axel_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        GRANT USAGE ON TYPES TO axel_runtime;
    `);
    const transitionOptions = {
      ...initialOptions,
      profile: "delivery-edge",
      legacyLoginRoles: ["axel_runtime_legacy"],
      ownerParentRoles: [
        ...initialOptions.ownerParentRoles,
        "axel_runtime",
        "axel_runtime_legacy",
      ],
      requireFinalState: false,
    };
    assert.equal(
      (await verifyDatabaseServiceRole(edge, transitionOptions)).profile,
      "delivery-edge",
    );
    await adminAxel.query(
      "GRANT TRUNCATE ON TABLE public.schema_migrations TO axel_runtime",
    );
    await expectPrivilegeMismatch(edge, transitionOptions);
    await adminAxel.query(
      "REVOKE TRUNCATE ON TABLE public.schema_migrations FROM axel_runtime",
    );
    await adminAxel.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM axel_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        REVOKE USAGE ON SEQUENCES FROM axel_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE axel_owner IN SCHEMA public
        REVOKE USAGE ON TYPES FROM axel_runtime;
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM axel_runtime;
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM axel_runtime;
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM axel_runtime;
      REVOKE ALL PRIVILEGES ON DATABASE axel FROM axel_runtime;
    `);
    await admin.query(`
      REVOKE axel_runtime FROM axel_runtime_legacy;
      REVOKE axel_runtime FROM axel_owner;
      REVOKE axel_runtime_legacy FROM axel_owner;
      DROP ROLE axel_runtime_legacy;
      DROP ROLE axel_runtime;
    `);

    phase = "legacy_broad_role_final_state";
    await admin.query(`
      CREATE ROLE axel_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS
    `);
    await expectPrivilegeMismatch(edge, { ...initialOptions, profile: "delivery-edge" });
    await admin.query("DROP ROLE axel_runtime");

    phase = "scram_verifiers";
    const scram = await admin.query(`
      SELECT count(*)::integer AS count
        FROM pg_authid
       WHERE rolname = ANY($1::text[])
         AND rolpassword LIKE 'SCRAM-SHA-256$%'
    `, [DATABASE_SERVICE_PROFILE_NAMES.map((profile) => initialRegistry[profile].loginRole)]);
    assert.equal(scram.rows[0]?.count, 5);

    phase = "overlap_rotation";
    const rotatedRegistry = registryFor("20260828", initialRegistry);
    const rotatedPasswords = passwordsFor("20260828");
    const rotatedOptions = optionsFor(rotatedRegistry, rotatedPasswords);
    assert.deepEqual(
      await provisionDatabaseServiceRoles(owner, rotatedOptions),
      { profileCount: 5 },
    );
    const rotatedEdge = await connectPostgres(
      `postgresql://${rotatedRegistry["delivery-edge"].loginRole}:${rotatedPasswords["delivery-edge"]}@127.0.0.1:${port}/axel?sslmode=disable`,
    );
    clients.push(rotatedEdge);
    assert.equal(
      (await verifyDatabaseServiceRole(rotatedEdge, {
        ...rotatedOptions,
        profile: "delivery-edge",
      })).profile,
      "delivery-edge",
    );
    assert.equal(
      (await verifyDatabaseServiceRole(edge, {
        ...rotatedOptions,
        profile: "delivery-edge",
        requireIdentity: false,
      })).profile,
      "delivery-edge",
    );
  } catch (error) {
    error.message = `phase=${phase}: ${error.message}`;
    throw error;
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    try {
      docker("rm", "-f", CONTAINER);
    } catch {}
  }
});
