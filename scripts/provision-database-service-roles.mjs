#!/usr/bin/env node

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DASHBOARD_DATABASE_ROUTINES } from "./database-service-access-profiles.mjs";
import pg from "pg";
import {
  DATABASE_SERVICE_PROFILE_NAMES,
  databaseServiceAccessProfile,
} from "./database-service-access-profiles.mjs";
import {
  databaseServiceRoleOptionsFromEnv,
  validateDatabaseServiceRoleOptions,
  verifyDatabaseServiceRole,
} from "./verify-database-service-role.mjs";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";

const { Client } = pg;
const PASSWORD = /^[A-Za-z0-9_-]{40,128}$/;
const PROFILE_ENV_STEMS = Object.freeze({
  dashboard: "DASHBOARD",
  "delivery-native": "DELIVERY_NATIVE",
  "delivery-workers": "DELIVERY_WORKERS",
  "pull-worker": "PULL_WORKER",
  "delivery-edge": "DELIVERY_EDGE",
});

function fixedError(code) {
  const error = new Error(code);
  error.name = "DatabaseServiceRoleProvisionError";
  return error;
}

function quoteIdentifier(value) {
  return `"${value}"`;
}

function password(value) {
  if (typeof value !== "string" || !PASSWORD.test(value)) {
    throw fixedError("database_service_password_invalid");
  }
  return value;
}

export function postgresScramSha256Verifier(value, salt = randomBytes(16)) {
  if (typeof value !== "string" || !Buffer.isBuffer(salt) || salt.length < 16) {
    throw fixedError("database_service_scram_input_invalid");
  }
  const iterations = 4096;
  const saltedPassword = pbkdf2Sync(value, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export function validateDatabaseServiceProvisionOptions(rawOptions) {
  const base = validateDatabaseServiceRoleOptions({
    ...rawOptions,
    profile: rawOptions.profile ?? "dashboard",
    requireIdentity: false,
  });
  const passwords = {};
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    passwords[profileName] = password(rawOptions.passwords?.[profileName]);
  }
  if (new Set(Object.values(passwords)).size !== DATABASE_SERVICE_PROFILE_NAMES.length) {
    throw fixedError("database_service_passwords_must_be_distinct");
  }
  return { ...base, passwords };
}

function provisionOptionsFromEnv(env = process.env) {
  const base = databaseServiceRoleOptionsFromEnv({
    ...env,
    DATABASE_SERVICE_PROFILE: env.DATABASE_SERVICE_PROFILE ?? "dashboard",
  });
  const passwords = {};
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    passwords[profileName] = env[`DATABASE_${PROFILE_ENV_STEMS[profileName]}_PASSWORD`];
  }
  return validateDatabaseServiceProvisionOptions({ ...base, passwords });
}

async function requireProvisioningAuthority(client, options, finalCheck) {
  const result = await client.query(`
    WITH owner_role AS (
      SELECT * FROM pg_roles WHERE rolname = $1
    ), public_schema AS (
      SELECT * FROM pg_namespace WHERE nspname = 'public'
    )
    SELECT current_setting('server_version_num')::integer >= 170000 AS pg17,
           current_user = $1 AS current_role_safe,
           session_user = ANY($2::text[]) AS session_role_safe,
           NOT owner_role.rolsuper
             AND owner_role.rolcreaterole
             AND NOT owner_role.rolreplication
             AND NOT owner_role.rolbypassrls
             AND owner_role.rolconfig IS NULL
             AND (
               (
                 NOT owner_role.rolinherit
                 AND NOT owner_role.rolcreatedb
                 AND NOT owner_role.rolcanlogin
               )
               OR (
                 $3::boolean
                 AND owner_role.rolinherit
                 AND owner_role.rolcreatedb
                 AND owner_role.rolcanlogin
               )
             ) AS owner_attributes_safe,
           database.datdba = owner_role.oid AS owns_database,
           public_schema.nspowner = owner_role.oid AS owns_public_schema,
           NOT EXISTS (
             SELECT 1 FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relowner <> owner_role.oid
           ) AS owns_public_relations,
           NOT EXISTS (
             SELECT 1 FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
             LEFT JOIN pg_depend dependency
               ON dependency.classid = 'pg_proc'::regclass
              AND dependency.objid = routine.oid
              AND dependency.deptype = 'e'
             LEFT JOIN pg_extension extension ON extension.oid = dependency.refobjid
             WHERE namespace.nspname = 'public'
               AND (
                 routine.prosecdef
                 OR (
                   routine.proowner <> owner_role.oid
                   AND extension.extowner IS DISTINCT FROM owner_role.oid
                 )
               )
           ) AS owns_or_controls_public_routines,
           NOT EXISTS (
             SELECT 1 FROM pg_type type
             JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
             LEFT JOIN pg_depend dependency
               ON dependency.classid = 'pg_type'::regclass
              AND dependency.objid = type.oid
              AND dependency.deptype = 'e'
             LEFT JOIN pg_extension extension ON extension.oid = dependency.refobjid
             WHERE namespace.nspname = 'public'
               AND type.typowner <> owner_role.oid
               AND extension.extowner IS DISTINCT FROM owner_role.oid
           ) AS owns_or_controls_public_types
      FROM owner_role
      CROSS JOIN public_schema
      JOIN pg_database database ON database.datname = current_database()
  `, [
    options.ownerRole,
    options.managedOwnerLogin ? [options.ownerRole] : options.migrationLoginRoles,
    options.managedOwnerLogin || options.transitionalOwnerLoginRole === options.ownerRole,
  ]);
  const row = result.rows[0];
  const checks = [
    "pg17",
    "current_role_safe",
    "session_role_safe",
    "owner_attributes_safe",
    "owns_database",
    "owns_public_schema",
    "owns_public_relations",
    "owns_or_controls_public_routines",
    "owns_or_controls_public_types",
  ];
  if (result.rows.length !== 1 || checks.some((check) => row?.[check] !== true)) {
    throw fixedError("database_service_provisioning_authority_invalid");
  }

  const parentMemberships = await client.query(`
    SELECT parent.rolname AS parent,
           membership.admin_option,
           membership.inherit_option,
           membership.set_option
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles owner_role ON owner_role.oid = membership.member
     WHERE owner_role.rolname = $1
  `, [options.ownerRole]);
  const expectedExistingParents = new Set(
    options.ownerParentRoles.filter((name) =>
      parentMemberships.rows.some((row) => row.parent === name)),
  );
  if (
    parentMemberships.rows.some(
      (row) =>
        !expectedExistingParents.has(row.parent)
        || !row.admin_option
        || row.inherit_option
        || row.set_option,
    )
    || (finalCheck && parentMemberships.rows.length !== options.ownerParentRoles.length)
  ) {
    throw fixedError("database_service_owner_parent_membership_invalid");
  }
}

async function requireNewLoginNamesAvailable(client, options) {
  const loginNames = DATABASE_SERVICE_PROFILE_NAMES.map(
    (profileName) => options.registry[profileName].loginRole,
  );
  const result = await client.query(
    "SELECT count(*)::integer AS count FROM pg_roles WHERE rolname = ANY($1::text[])",
    [loginNames],
  );
  if (result.rows[0]?.count !== 0) {
    throw fixedError("database_service_login_role_collision");
  }
}

async function createRole(client, sql) {
  await client.query(sql);
}

async function revokeColumnAcls(client, roleNames) {
  const result = await client.query(`
    SELECT namespace.nspname AS schema_name,
           relation.relname AS relation_name,
           attribute.attname AS column_name,
           acl.privilege_type,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'public'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))
  `, [roleNames]);
  for (const row of result.rows) {
    if (!["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(row.privilege_type)) {
      throw fixedError("database_service_column_acl_invalid");
    }
    const grantee = row.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(row.grantee);
    await client.query(
      `REVOKE ${row.privilege_type} (${quoteIdentifier(row.column_name)}) ON TABLE ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.relation_name)} FROM ${grantee}`,
    );
  }
}

async function revokeOwnerRoutineAcls(client, ownerRole, roleNames) {
  const grantees = ["PUBLIC", ...roleNames.map(quoteIdentifier)].join(", ");
  await client.query(`
    DO $owner_routines$
    DECLARE target pg_catalog.regprocedure;
    BEGIN
      FOR target IN
        SELECT routine.oid::pg_catalog.regprocedure
          FROM pg_catalog.pg_proc routine
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = 'public'
           AND routine.proowner = '${ownerRole}'::pg_catalog.regrole
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON ROUTINE %s FROM ${grantees}',
          target
        );
      END LOOP;
    END
    $owner_routines$
  `);
}

async function sealDefaultPrivileges(client, roleNames) {
  const grantees = ["PUBLIC", ...roleNames.map(quoteIdentifier)].join(", ");
  for (const scope of ["", " IN SCHEMA public"]) {
    for (const objectType of ["TABLES", "SEQUENCES", "ROUTINES", "TYPES"]) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES${scope} REVOKE ALL PRIVILEGES ON ${objectType} FROM ${grantees}`,
      );
    }
  }
  await client.query(
    `ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SCHEMAS FROM ${grantees}`,
  );
}

async function grantProfile(client, capabilityRole, profileName) {
  const capability = quoteIdentifier(capabilityRole);
  const profile = databaseServiceAccessProfile(profileName);
  for (const [table, privileges] of Object.entries(profile.tables)) {
    await client.query(
      `GRANT ${privileges.join(", ")} ON TABLE public.${quoteIdentifier(table)} TO ${capability}`,
    );
  }
  for (const [sequence, privileges] of Object.entries(profile.sequences)) {
    await client.query(
      `GRANT ${privileges.join(", ")} ON SEQUENCE public.${quoteIdentifier(sequence)} TO ${capability}`,
    );
  }
}

export async function provisionDatabaseServiceRoles(client, rawOptions) {
  const options = validateDatabaseServiceProvisionOptions(rawOptions);
  const capabilityRoles = DATABASE_SERVICE_PROFILE_NAMES.map(
    (profileName) => options.registry[profileName].capabilityRole,
  );
  const newLoginRoles = DATABASE_SERVICE_PROFILE_NAMES.map(
    (profileName) => options.registry[profileName].loginRole,
  );
  const existingLoginRoles = DATABASE_SERVICE_PROFILE_NAMES.flatMap(
    (profileName) => options.registry[profileName].existingLoginRoles,
  );
  const managedRoles = [
    ...capabilityRoles,
    ...newLoginRoles,
    ...existingLoginRoles,
    options.verifyCapabilityRole,
    ...options.verifyLoginRoles,
  ];

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(options.ownerRole)}`);
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('axel-database-service-roles-v1', 0))",
    );
    await requireProvisioningAuthority(client, options, false);
    await requireNewLoginNamesAvailable(client, options);

    for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
      const { capabilityRole, loginRole } = options.registry[profileName];
      const existingCapability = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [capabilityRole],
      );
      if (existingCapability.rows.length === 0) {
        await createRole(client, `
          CREATE ROLE ${quoteIdentifier(capabilityRole)}
            NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS
        `);
      }
      const verifier = postgresScramSha256Verifier(options.passwords[profileName]);
      await client.query("SELECT set_config('axel.service_password_verifier', $1, true)", [
        verifier,
      ]);
      await client.query(`
        DO $axel$
        BEGIN
          EXECUTE format(
            'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
            '${loginRole}', current_setting('axel.service_password_verifier')
          );
        END
        $axel$;
      `);
      await client.query(`
        GRANT ${quoteIdentifier(capabilityRole)} TO ${quoteIdentifier(loginRole)}
          WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
      `);
      await client.query(`ALTER ROLE ${quoteIdentifier(loginRole)} RESET ALL`);
      await client.query(
        `ALTER ROLE ${quoteIdentifier(loginRole)} SET search_path = pg_catalog, public`,
      );
    }

    await client.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    await client.query(`
      DO $axel$
      BEGIN
        EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO ${(options.managedOwnerLogin ? [options.ownerRole] : options.migrationLoginRoles)
            .map(quoteIdentifier)
            .join(", ")}',
          current_database()
        );
      END
      $axel$;
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${managedRoles
        .map(quoteIdentifier)
        .join(", ")}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    await revokeOwnerRoutineAcls(client, options.ownerRole, managedRoles);
    await revokeColumnAcls(client, managedRoles);
    await sealDefaultPrivileges(client, managedRoles);

    await client.query(`
      DO $axel$
      BEGIN
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM ${managedRoles
            .map(quoteIdentifier)
            .join(", ")}',
          current_database()
        );
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO ${[
            ...capabilityRoles,
            options.verifyCapabilityRole,
          ].map(quoteIdentifier).join(", ")}',
          current_database()
        );
      END
      $axel$;
    `);
    await client.query(`
      GRANT USAGE ON SCHEMA public TO ${[
        ...capabilityRoles,
        options.verifyCapabilityRole,
      ].map(quoteIdentifier).join(", ")}
    `);
    for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
      await grantProfile(
        client,
        options.registry[profileName].capabilityRole,
        profileName,
      );
    }
    for (const routine of DASHBOARD_DATABASE_ROUTINES) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO ${quoteIdentifier(options.registry.dashboard.capabilityRole)}`);
    }

    await requireProvisioningAuthority(client, options, true);
    for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
      await verifyDatabaseServiceRole(client, {
        ...options,
        profile: profileName,
        requireIdentity: false,
      });
    }
    await client.query("COMMIT");
    return { profileCount: DATABASE_SERVICE_PROFILE_NAMES.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) throw fixedError("database_migration_url_required");
  const options = provisionOptionsFromEnv();
  const client = new Client({
    connectionString,
    ssl: controlPlanePgSslOption(
      connectionString,
      process.env.CONTROL_PLANE_DB_SSL_VERIFY,
    ),
    application_name: "axel-database-service-role-provisioner",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    const result = await provisionDatabaseServiceRoles(client, options);
    process.stdout.write(`database_service_roles_provisioned profiles=${result.profileCount}\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("database_service_role_provisioning_failed\n");
    process.exitCode = 1;
  });
}
