#!/usr/bin/env node

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
  DASHBOARD_DATABASE_ROUTINES,
  databaseServiceAccessProfile,
} from "../database-service-access-profiles.mjs";

const { Client } = pg;

export const SELF_HOST_DATABASE_ROLES = Object.freeze({
  admin: "axel",
  owner: "axel_owner",
  migration: "axel_migration",
  metadataCapability: "axel_verify",
  dashboardCapability: "axel_dashboard",
  dashboardLogin: "axel_dashboard_app",
  deliveryCapability: "axel_delivery_native",
  deliveryLogin: "axel_delivery_app",
  legacyRuntimeCapability: "axel_runtime",
  legacyRuntimeLogin: "axel_app",
});

export const SELF_HOST_DATABASE_SERVICE_ROLES = Object.freeze([
  Object.freeze({
    profile: "dashboard",
    capability: SELF_HOST_DATABASE_ROLES.dashboardCapability,
    login: SELF_HOST_DATABASE_ROLES.dashboardLogin,
  }),
  Object.freeze({
    profile: "delivery-combined",
    capability: SELF_HOST_DATABASE_ROLES.deliveryCapability,
    login: SELF_HOST_DATABASE_ROLES.deliveryLogin,
  }),
]);

function mergeAccessProfiles(profileNames) {
  const tables = {};
  const sequences = {};
  for (const profileName of profileNames) {
    const profile = databaseServiceAccessProfile(profileName);
    for (const [relation, privileges] of Object.entries(profile.tables)) {
      tables[relation] = Object.freeze(
        [...new Set([...(tables[relation] ?? []), ...privileges])].sort(),
      );
    }
    for (const [relation, privileges] of Object.entries(profile.sequences)) {
      sequences[relation] = Object.freeze(
        [...new Set([...(sequences[relation] ?? []), ...privileges])].sort(),
      );
    }
  }
  return Object.freeze({
    tables: Object.freeze(tables),
    sequences: Object.freeze(sequences),
  });
}

export const SELF_HOST_DATABASE_ACCESS_PROFILES = Object.freeze({
  dashboard: databaseServiceAccessProfile("dashboard"),
  "delivery-combined": mergeAccessProfiles([
    "delivery-native",
    "delivery-workers",
  ]),
});

function selfHostDatabaseAccessProfile(name) {
  const profile = SELF_HOST_DATABASE_ACCESS_PROFILES[name];
  if (!profile) throw fixedError("self_host_database_profile_invalid");
  return profile;
}

const SAFE_PASSWORD = /^[A-Za-z0-9_-]{40,128}$/;
const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];
const SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"];

function fixedError(code) {
  const error = new Error(code);
  error.name = "SelfHostDatabaseAccessError";
  return error;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function postgresScramSha256Verifier(password, salt = randomBytes(16)) {
  const iterations = 4096;
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export function validateSelfHostDatabaseUrl(raw, expectedRole) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fixedError("self_host_database_url_invalid");
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw fixedError("self_host_database_url_invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    || username !== expectedRole
    || url.pathname !== "/axel"
    || !url.hostname
    || !SAFE_PASSWORD.test(password)
    || url.hash
  ) {
    throw fixedError("self_host_database_url_invalid");
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() !== "sslmode") {
      throw fixedError("self_host_database_url_parameter_invalid");
    }
  }
  if (url.searchParams.get("sslmode") !== "disable") {
    throw fixedError("self_host_database_tls_mode_invalid");
  }
  return {
    connectionString: raw,
    endpoint: `${url.hostname}:${url.port || "5432"}`,
    password,
  };
}

function clientFor(connectionString, applicationName) {
  return new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
  });
}

async function requireAdminAuthority(client) {
  const result = await client.query(`
    SELECT current_user = $1 AND session_user = $1 AS expected_role,
           current_setting('server_version_num')::integer >= 160000 AS supported_version,
           role.rolsuper AND role.rolcanlogin AS admin_authority,
           current_database() = 'axel' AS expected_database
      FROM pg_roles role
     WHERE role.rolname = current_user
  `, [SELF_HOST_DATABASE_ROLES.admin]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row.expected_role !== true
    || row.supported_version !== true
    || row.admin_authority !== true
    || row.expected_database !== true
  ) {
    throw fixedError("self_host_database_admin_authority_invalid");
  }
}

async function ensureRole(client, name, attributes, createSql) {
  const result = await client.query(`
    SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
           rolreplication, rolbypassrls
      FROM pg_roles
     WHERE rolname = $1
  `, [name]);
  if (result.rows.length === 0) {
    await client.query(createSql);
    return;
  }
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || Object.entries(attributes).some(([key, expected]) => row[key] !== expected)
  ) {
    throw fixedError("self_host_database_role_collision");
  }
}

function assertRoleAttributes(role, { login, inherit }) {
  if (
    !role
    || role.rolsuper
    || role.rolinherit !== inherit
    || role.rolcreaterole
    || role.rolcreatedb
    || role.rolcanlogin !== login
    || role.rolreplication
    || role.rolbypassrls
  ) {
    throw fixedError("self_host_database_role_attributes_invalid");
  }
}

function roleConfigEquals(role, expected) {
  const actual = [...(role?.rolconfig ?? [])].sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((value, index) => value === sortedExpected[index]);
}

async function requireStructuralBoundary(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const protectedRoleNames = [
    roles.owner,
    roles.migration,
    roles.metadataCapability,
    ...SELF_HOST_DATABASE_SERVICE_ROLES.flatMap(({ capability, login }) => [
      capability,
      login,
    ]),
  ];
  const roleResult = await client.query(`
    SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls, rolconfig
      FROM pg_roles
     WHERE rolname = ANY($1::text[])
  `, [[...protectedRoleNames, roles.legacyRuntimeCapability, roles.legacyRuntimeLogin]]);
  const roleMap = new Map(roleResult.rows.map((role) => [role.rolname, role]));
  if (
    roleMap.has(roles.legacyRuntimeCapability)
    || roleMap.has(roles.legacyRuntimeLogin)
  ) {
    throw fixedError("self_host_database_legacy_runtime_present");
  }

  assertRoleAttributes(roleMap.get(roles.owner), { login: false, inherit: false });
  assertRoleAttributes(roleMap.get(roles.migration), { login: true, inherit: false });
  assertRoleAttributes(roleMap.get(roles.metadataCapability), {
    login: false,
    inherit: false,
  });
  for (const { capability, login } of SELF_HOST_DATABASE_SERVICE_ROLES) {
    assertRoleAttributes(roleMap.get(capability), { login: false, inherit: false });
    assertRoleAttributes(roleMap.get(login), { login: true, inherit: true });
  }
  if (
    !roleConfigEquals(roleMap.get(roles.owner), ["search_path=public"])
    || !roleConfigEquals(roleMap.get(roles.migration), ["search_path=pg_catalog"])
    || !roleConfigEquals(roleMap.get(roles.metadataCapability), [])
    || SELF_HOST_DATABASE_SERVICE_ROLES.some(
      ({ capability, login }) =>
        !roleConfigEquals(roleMap.get(capability), [])
        || !roleConfigEquals(roleMap.get(login), ["search_path=pg_catalog, public"]),
    )
  ) {
    throw fixedError("self_host_database_role_configuration_invalid");
  }

  const memberships = await client.query(`
    SELECT parent.rolname AS parent, child.rolname AS child,
           membership.admin_option, membership.inherit_option,
           membership.set_option
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles child ON child.oid = membership.member
     WHERE parent.rolname = ANY($1::text[])
        OR child.rolname = ANY($1::text[])
  `, [protectedRoleNames]);
  const actualMemberships = new Set(memberships.rows.map((row) =>
    `${row.parent}|${row.child}|${row.admin_option}|${row.inherit_option}|${row.set_option}`));
  const expectedMemberships = new Set([
    `${roles.owner}|${roles.migration}|false|false|true`,
    ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ capability, login }) =>
      `${capability}|${login}|false|true|false`),
  ]);
  if (
    actualMemberships.size !== expectedMemberships.size
    || [...actualMemberships].some((entry) => !expectedMemberships.has(entry))
  ) {
    throw fixedError("self_host_database_role_membership_invalid");
  }

  const ownership = await client.query(`
    WITH owner_role AS (
      SELECT oid FROM pg_roles WHERE rolname = $1
    ), protected_roles AS (
      SELECT oid FROM pg_roles WHERE rolname = ANY($2::text[])
    )
    SELECT
      (SELECT datdba = owner_role.oid
         FROM pg_database, owner_role
        WHERE datname = current_database()) AS owns_database,
      (SELECT nspowner = owner_role.oid
         FROM pg_namespace, owner_role
        WHERE nspname = 'public') AS owns_public_schema,
      NOT EXISTS (
        SELECT 1 FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace,
             owner_role
       WHERE namespace.nspname = 'public' AND relation.relowner <> owner_role.oid
      ) AS owns_public_relations,
      NOT EXISTS (
        SELECT 1 FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace,
             owner_role
       WHERE namespace.nspname = 'public' AND routine.proowner <> owner_role.oid
      ) AS owns_public_routines,
      NOT EXISTS (
        SELECT 1 FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace,
             owner_role
       WHERE namespace.nspname = 'public' AND type.typowner <> owner_role.oid
      ) AS owns_public_types,
      NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM protected_roles))
        AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner IN (SELECT oid FROM protected_roles))
        AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner IN (SELECT oid FROM protected_roles))
        AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner IN (SELECT oid FROM protected_roles))
        AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typowner IN (SELECT oid FROM protected_roles))
        AND NOT EXISTS (
          SELECT 1 FROM pg_default_acl WHERE defaclrole IN (SELECT oid FROM protected_roles)
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_shdepend dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
             AND dependency.refobjid IN (SELECT oid FROM protected_roles)
             AND dependency.deptype = 'o'
        ) AS protected_roles_own_nothing
    FROM owner_role
  `, [roles.owner, protectedRoleNames.filter((role) => role !== roles.owner)]);
  if (
    ownership.rows.length !== 1
    || Object.values(ownership.rows[0]).some((value) => value !== true)
  ) {
    throw fixedError("self_host_database_ownership_boundary_invalid");
  }
}

async function revokeDirectColumnPrivileges(client, roleNames) {
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
      throw fixedError("self_host_database_column_acl_invalid");
    }
    const grantee = row.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(row.grantee);
    await client.query(
      `REVOKE ${row.privilege_type} (${quoteIdentifier(row.column_name)})`
      + ` ON TABLE ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.relation_name)}`
      + ` FROM ${grantee}`,
    );
  }
}

async function reconcileNonOwnerDefaultPrivileges(client) {
  await client.query(`
    DO $axel$
    DECLARE default_grant record;
    DECLARE object_kind text;
    DECLARE schema_clause text;
    DECLARE grantee_sql text;
    BEGIN
      FOR default_grant IN
        SELECT DISTINCT defaults.defaclobjtype,
               defaults.defaclnamespace,
               namespace.nspname AS schema_name,
               owner_role.rolname AS owner_name,
               acl.grantee,
               grantee.rolname AS grantee_name
          FROM pg_default_acl defaults
          JOIN pg_roles owner_role ON owner_role.oid = defaults.defaclrole
          LEFT JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
          CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
          LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE owner_role.rolname !~ '^pg_'
           AND acl.grantee <> owner_role.oid
      LOOP
        object_kind := CASE default_grant.defaclobjtype
          WHEN 'r' THEN 'TABLES'
          WHEN 'S' THEN 'SEQUENCES'
          WHEN 'f' THEN 'ROUTINES'
          WHEN 'T' THEN 'TYPES'
          WHEN 'n' THEN 'SCHEMAS'
          ELSE NULL
        END;
        IF object_kind IS NULL THEN
          RAISE EXCEPTION 'unsupported default privilege object type';
        END IF;
        IF default_grant.defaclnamespace = 0 THEN
          schema_clause := '';
        ELSIF default_grant.schema_name IS NOT NULL
          AND default_grant.defaclobjtype <> 'n' THEN
          schema_clause := format(' IN SCHEMA %I', default_grant.schema_name);
        ELSE
          RAISE EXCEPTION 'invalid default privilege scope';
        END IF;
        IF default_grant.grantee = 0 THEN
          grantee_sql := 'PUBLIC';
        ELSIF default_grant.grantee_name IS NOT NULL THEN
          grantee_sql := format('%I', default_grant.grantee_name);
        ELSE
          RAISE EXCEPTION 'unknown default privilege grantee';
        END IF;
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL PRIVILEGES ON %s FROM %s',
          default_grant.owner_name, schema_clause, object_kind, grantee_sql
        );
      END LOOP;
    END
    $axel$;
  `);
}

async function revokePublicClusterDatabasePrivileges(client) {
  const databases = await client.query(`
    SELECT datname FROM pg_database
     WHERE datallowconn AND NOT datistemplate
  `);
  for (const { datname } of databases.rows) {
    await client.query(
      `REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(datname)} FROM PUBLIC`,
    );
  }
}

async function retireLegacyRuntimeRoles(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const result = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [[roles.legacyRuntimeCapability, roles.legacyRuntimeLogin]],
  );
  const present = new Set(result.rows.map((row) => row.rolname));
  if (present.size === 0) return;
  const databases = await client.query(`
    SELECT datname FROM pg_database
     WHERE datallowconn AND NOT datistemplate
  `);
  for (const role of present) {
    const identifier = quoteIdentifier(role);
    for (const { datname } of databases.rows) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(datname)} FROM ${identifier}`,
      );
    }
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${identifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${identifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${identifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${identifier}`);
  }
  await revokeDirectColumnPrivileges(client, [...present]);
  await reconcileNonOwnerDefaultPrivileges(client);
  if (
    present.has(roles.legacyRuntimeCapability)
    && present.has(roles.legacyRuntimeLogin)
  ) {
    await client.query(
      `REVOKE ${quoteIdentifier(roles.legacyRuntimeCapability)}`
      + ` FROM ${quoteIdentifier(roles.legacyRuntimeLogin)}`,
    );
  }
  if (present.has(roles.legacyRuntimeLogin)) {
    await client.query(`DROP ROLE ${quoteIdentifier(roles.legacyRuntimeLogin)}`);
  }
  if (present.has(roles.legacyRuntimeCapability)) {
    await client.query(`DROP ROLE ${quoteIdentifier(roles.legacyRuntimeCapability)}`);
  }
}

async function adoptAdminOwnedPublicObjects(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const relations = await client.query(`
    SELECT relation.relname, relation.relkind
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
     WHERE namespace.nspname = 'public'
       AND owner_role.rolname = $1
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY relation.relkind = 'S', relation.relname
  `, [roles.admin]);
  // Tables first. A serial sequence is linked to its table, and Postgres
  // refuses to change the sequence's owner on its own ("cannot change owner
  // of sequence"). Altering the table moves the sequence with it, and the
  // later sequence ALTER is then a no-op. Catalog scan order is not stable
  // (an ALTER TABLE rewrites the table's pg_class row), so sort explicitly.
  const objectTypes = {
    r: "TABLE",
    p: "TABLE",
    v: "VIEW",
    m: "MATERIALIZED VIEW",
    f: "FOREIGN TABLE",
    S: "SEQUENCE",
  };
  for (const relation of relations.rows) {
    await client.query(
      `ALTER ${objectTypes[relation.relkind]} public.${quoteIdentifier(relation.relname)}`
      + ` OWNER TO ${quoteIdentifier(roles.owner)}`,
    );
  }
  await client.query(`
    DO $axel$
    DECLARE owned_routine record;
    BEGIN
      FOR owned_routine IN
        SELECT routine.oid, namespace.nspname, routine.proname,
               pg_get_function_identity_arguments(routine.oid) AS identity_arguments
          FROM pg_proc routine
          JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
          JOIN pg_roles owner_role ON owner_role.oid = routine.proowner
         WHERE namespace.nspname = 'public' AND owner_role.rolname = '${roles.admin}'
      LOOP
        EXECUTE format(
          'ALTER ROUTINE %I.%I(%s) OWNER TO %I',
          owned_routine.nspname,
          owned_routine.proname,
          owned_routine.identity_arguments,
          '${roles.owner}'
        );
      END LOOP;
    END
    $axel$;
  `);
  const types = await client.query(`
    SELECT type.typname
      FROM pg_type type
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      JOIN pg_roles owner_role ON owner_role.oid = type.typowner
     WHERE namespace.nspname = 'public'
       AND owner_role.rolname = $1
       AND type.typrelid = 0
       AND type.typelem = 0
  `, [roles.admin]);
  for (const type of types.rows) {
    await client.query(
      `ALTER TYPE public.${quoteIdentifier(type.typname)}`
      + ` OWNER TO ${quoteIdentifier(roles.owner)}`,
    );
  }
}

function validateProvisionPasswords(options) {
  const passwords = [
    options.migrationPassword,
    options.dashboardPassword,
    options.deliveryPassword,
  ];
  if (passwords.some((password) => !SAFE_PASSWORD.test(password))) {
    throw fixedError("self_host_database_password_invalid");
  }
  if (new Set(passwords).size !== passwords.length) {
    throw fixedError("self_host_database_passwords_must_be_distinct");
  }
}

export async function prepareSelfHostDatabase(client, options) {
  const roles = SELF_HOST_DATABASE_ROLES;
  validateProvisionPasswords(options);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('axel-self-host-database-v2', 0))",
    );
    await requireAdminAuthority(client);

    await ensureRole(
      client,
      roles.owner,
      {
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      `CREATE ROLE ${quoteIdentifier(roles.owner)}`
      + " NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await ensureRole(
      client,
      roles.migration,
      {
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
        rolreplication: false,
        rolbypassrls: false,
      },
      `CREATE ROLE ${quoteIdentifier(roles.migration)}`
      + " LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await ensureRole(
      client,
      roles.metadataCapability,
      {
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      `CREATE ROLE ${quoteIdentifier(roles.metadataCapability)}`
      + " NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    for (const { capability, login } of SELF_HOST_DATABASE_SERVICE_ROLES) {
      await ensureRole(
        client,
        capability,
        {
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolcanlogin: false,
          rolreplication: false,
          rolbypassrls: false,
        },
        `CREATE ROLE ${quoteIdentifier(capability)}`
        + " NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
      );
      await ensureRole(
        client,
        login,
        {
          rolsuper: false,
          rolinherit: true,
          rolcreaterole: false,
          rolcreatedb: false,
          rolcanlogin: true,
          rolreplication: false,
          rolbypassrls: false,
        },
        `CREATE ROLE ${quoteIdentifier(login)}`
        + " LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
      );
    }

    await client.query(
      `SELECT set_config('axel.self_host_migration_verifier', $1, true),
              set_config('axel.self_host_dashboard_verifier', $2, true),
              set_config('axel.self_host_delivery_verifier', $3, true)`,
      [
        postgresScramSha256Verifier(options.migrationPassword),
        postgresScramSha256Verifier(options.dashboardPassword),
        postgresScramSha256Verifier(options.deliveryPassword),
      ],
    );
    await client.query(`
      DO $axel$
      BEGIN
        EXECUTE format(
          'ALTER ROLE ${roles.migration} PASSWORD %L',
          current_setting('axel.self_host_migration_verifier')
        );
        EXECUTE format(
          'ALTER ROLE ${roles.dashboardLogin} PASSWORD %L',
          current_setting('axel.self_host_dashboard_verifier')
        );
        EXECUTE format(
          'ALTER ROLE ${roles.deliveryLogin} PASSWORD %L',
          current_setting('axel.self_host_delivery_verifier')
        );
      END
      $axel$;
    `);

    await client.query(`
      GRANT ${quoteIdentifier(roles.owner)} TO ${quoteIdentifier(roles.migration)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
    `);
    for (const { capability, login } of SELF_HOST_DATABASE_SERVICE_ROLES) {
      await client.query(`
        GRANT ${quoteIdentifier(capability)} TO ${quoteIdentifier(login)}
          WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
      `);
    }
    await client.query(`ALTER DATABASE axel OWNER TO ${quoteIdentifier(roles.owner)}`);
    await client.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(roles.owner)}`);
    await adoptAdminOwnedPublicObjects(client);
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(roles.owner)}
        REVOKE EXECUTE ON ROUTINES FROM PUBLIC
    `);
    await revokePublicClusterDatabasePrivileges(client);
    await client.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(roles.owner)}`);
    await client.query(`
      GRANT CONNECT ON DATABASE axel TO
        ${[
          roles.owner,
          roles.migration,
          roles.metadataCapability,
          ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ capability }) => capability),
        ].map(quoteIdentifier).join(", ")}
    `);
    await client.query(`
      GRANT USAGE ON SCHEMA public TO
        ${[
          roles.metadataCapability,
          ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ capability }) => capability),
        ].map(quoteIdentifier).join(", ")}
    `);
    for (const role of [
      roles.owner,
      roles.migration,
      roles.metadataCapability,
      ...SELF_HOST_DATABASE_SERVICE_ROLES.flatMap(({ capability, login }) => [
        capability,
        login,
      ]),
    ]) {
      await client.query(`ALTER ROLE ${quoteIdentifier(role)} RESET ALL`);
    }
    await client.query(`ALTER ROLE ${quoteIdentifier(roles.owner)} SET search_path = public`);
    await client.query(`ALTER ROLE ${quoteIdentifier(roles.migration)} SET search_path = pg_catalog`);
    for (const { login } of SELF_HOST_DATABASE_SERVICE_ROLES) {
      await client.query(`ALTER ROLE ${quoteIdentifier(login)} SET search_path = pg_catalog, public`);
    }

    await retireLegacyRuntimeRoles(client);
    await requireStructuralBoundary(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function inspectSchemaInventory(client) {
  const schemas = await client.query(`
    SELECT nspname FROM pg_namespace
     WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
  `);
  if (schemas.rows.length !== 1 || schemas.rows[0]?.nspname !== "public") {
    throw fixedError("self_host_database_schema_inventory_invalid");
  }
  const relations = await client.query(`
    SELECT relation.relname, relation.relkind
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  `);
  const tables = new Set(relations.rows
    .filter((row) => row.relkind !== "S" && row.relname !== "schema_migrations")
    .map((row) => row.relname));
  const sequences = new Set(relations.rows
    .filter((row) => row.relkind === "S")
    .map((row) => row.relname));
  const tableInventoryMatches = tables.size === APPLICATION_TABLES.length
    && APPLICATION_TABLES.every((table) => tables.has(table));
  const sequenceInventoryMatches = sequences.size === APPLICATION_SEQUENCES.length
    && APPLICATION_SEQUENCES.every((sequence) => sequences.has(sequence));
  if (
    !tableInventoryMatches
    || !sequenceInventoryMatches
    || !relations.rows.some(
      (row) => row.relname === "schema_migrations" && row.relkind === "r",
    )
  ) {
    throw fixedError("self_host_database_relation_inventory_invalid");
  }
}

function expectedPrivilegeSet(profile) {
  return new Set(Object.entries(profile).flatMap(([relation, privileges]) =>
    privileges.map((privilege) => `${relation}|${privilege}`)));
}

async function inspectServicePrivileges(client, { profile: profileName, capability, login }) {
  const profile = selfHostDatabaseAccessProfile(profileName);
  const allowedRoutines = profileName === "dashboard" ? DASHBOARD_DATABASE_ROUTINES : [];
  const tableResult = await client.query(`
    SELECT relation.relname, privilege,
           has_table_privilege($1, relation.oid, privilege) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($2::text[]) privilege
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  `, [login, TABLE_PRIVILEGES]);
  const expectedTables = expectedPrivilegeSet(profile.tables);
  if (tableResult.rows.some(
    (row) => row.allowed !== expectedTables.has(`${row.relname}|${row.privilege}`),
  )) {
    throw fixedError("self_host_database_service_table_privilege_invalid");
  }
  const sequenceResult = await client.query(`
    SELECT relation.relname, privilege,
           has_sequence_privilege($1, relation.oid, privilege) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($2::text[]) privilege
     WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
  `, [login, SEQUENCE_PRIVILEGES]);
  const expectedSequences = expectedPrivilegeSet(profile.sequences);
  if (sequenceResult.rows.some(
    (row) => row.allowed !== expectedSequences.has(`${row.relname}|${row.privilege}`),
  )) {
    throw fixedError("self_host_database_service_sequence_privilege_invalid");
  }
  const boundary = await client.query(`
    SELECT has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
           has_database_privilege($1, current_database(), 'CREATE') AS db_create,
           has_database_privilege($1, current_database(), 'TEMP') AS db_temp,
           NOT EXISTS (
             SELECT 1 FROM pg_database database
              WHERE database.datallowconn
                AND NOT database.datistemplate
                AND database.datname <> current_database()
                AND (
                  has_database_privilege($1, database.oid, 'CONNECT')
                  OR has_database_privilege($1, database.oid, 'CREATE')
                  OR has_database_privilege($1, database.oid, 'TEMP')
                )
           ) AS other_databases_denied,
           has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
           has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
           NOT EXISTS (
             SELECT 1 FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname !~ '^pg_'
               AND namespace.nspname <> 'information_schema'
               AND has_function_privilege($1, routine.oid, 'EXECUTE')
               AND routine.oid <> ALL(ARRAY(SELECT to_regprocedure(name)::oid FROM unnest($2::text[]) name))
           ) AS routines_denied
  `, [login, allowedRoutines]);
  const row = boundary.rows[0];
  if (
    row?.db_connect !== true
    || row.db_create !== false
    || row.db_temp !== false
    || row.other_databases_denied !== true
    || row.schema_usage !== true
    || row.schema_create !== false
    || row.routines_denied !== true
  ) {
    throw fixedError("self_host_database_service_boundary_invalid");
  }
  for (const routine of allowedRoutines) {
    const allowed = await client.query("SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS allowed", [login, routine]);
    if (allowed.rows[0]?.allowed !== true) throw fixedError("self_host_database_required_routine_missing");
  }

  const directAcl = await client.query(`
    SELECT relation.relname, relation.relkind, acl.privilege_type, acl.is_grantable
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) acl
      JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'public' AND grantee.rolname = $1
  `, [capability]);
  const actualDirect = new Set(directAcl.rows.map((row) =>
    `${row.relkind === "S" ? "sequence" : "table"}|${row.relname}|${row.privilege_type}`));
  const expectedDirect = new Set([
    ...[...expectedTables].map((entry) => `table|${entry}`),
    ...[...expectedSequences].map((entry) => `sequence|${entry}`),
  ]);
  if (
    directAcl.rows.some((row) => row.is_grantable)
    || actualDirect.size !== expectedDirect.size
    || [...actualDirect].some((entry) => !expectedDirect.has(entry))
  ) {
    throw fixedError("self_host_database_service_direct_acl_invalid");
  }
}

async function inspectRawAclBoundary(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const capabilityProfiles = new Map(
    SELF_HOST_DATABASE_SERVICE_ROLES.map(({ profile, capability }) => [capability, profile]),
  );
  const databaseAndSchemaAcl = await client.query(`
    WITH database_acl AS (
      SELECT 'database'::text AS scope,
             COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
             acl.privilege_type, acl.is_grantable
        FROM pg_database database
        CROSS JOIN LATERAL aclexplode(database.datacl) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE database.datname = current_database()
    ), schema_acl AS (
      SELECT 'schema'::text AS scope,
             COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
             acl.privilege_type, acl.is_grantable
        FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE namespace.nspname = 'public'
    )
    SELECT * FROM database_acl UNION ALL SELECT * FROM schema_acl
  `);
  const expected = new Set([
    `database|${roles.migration}|CONNECT|false`,
    `database|${roles.metadataCapability}|CONNECT|false`,
    `schema|${roles.metadataCapability}|USAGE|false`,
    ...SELF_HOST_DATABASE_SERVICE_ROLES.flatMap(({ capability }) => [
      `database|${capability}|CONNECT|false`,
      `schema|${capability}|USAGE|false`,
    ]),
  ]);
  const actual = new Set();
  for (const row of databaseAndSchemaAcl.rows) {
    if (row.grantee === roles.owner || row.grantee.startsWith("pg_")) continue;
    const key = `${row.scope}|${row.grantee}|${row.privilege_type}|${row.is_grantable}`;
    if (!expected.has(key)) {
      throw fixedError("self_host_database_container_acl_invalid");
    }
    actual.add(key);
  }
  if ([...expected].some((entry) => !actual.has(entry))) {
    throw fixedError("self_host_database_container_acl_missing");
  }

  const classAcl = await client.query(`
    SELECT relation.relname, relation.relkind,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type, acl.is_grantable
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) acl
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  `);
  for (const row of classAcl.rows) {
    if (row.grantee === roles.owner) continue;
    const profileName = capabilityProfiles.get(row.grantee);
    if (!profileName || row.is_grantable) {
      throw fixedError("self_host_database_relation_acl_grantee_invalid");
    }
    const profile = selfHostDatabaseAccessProfile(profileName);
    const privileges = row.relkind === "S"
      ? profile.sequences[row.relname]
      : profile.tables[row.relname];
    if (!privileges?.includes(row.privilege_type)) {
      throw fixedError("self_host_database_relation_acl_privilege_invalid");
    }
  }

  const unexpectedAcl = await client.query(`
    SELECT (
      EXISTS (
        SELECT 1 FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ) OR EXISTS (
        SELECT 1 FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        CROSS JOIN LATERAL aclexplode(routine.proacl) acl
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = $1)
          AND NOT (acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
            AND NOT acl.is_grantable AND acl.privilege_type = 'EXECUTE'
            AND routine.oid = ANY(ARRAY(SELECT to_regprocedure(name)::oid FROM unnest($3::text[]) name)))
      ) OR EXISTS (
        SELECT 1 FROM pg_default_acl defaults
        JOIN pg_roles owner_role ON owner_role.oid = defaults.defaclrole
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
        WHERE owner_role.rolname !~ '^pg_' AND acl.grantee <> owner_role.oid
      )
    ) AS present
  `, [roles.owner, roles.dashboardCapability, DASHBOARD_DATABASE_ROUTINES]);
  if (unexpectedAcl.rows[0]?.present !== false) {
    throw fixedError("self_host_database_unexpected_acl_present");
  }

  const isolatedRoles = [
    roles.migration,
    ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ login }) => login),
  ];
  const directIsolatedAcl = await client.query(`
    WITH checked_roles AS (
      SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[])
    )
    SELECT (
      EXISTS (
        SELECT 1 FROM pg_database database
        CROSS JOIN LATERAL aclexplode(database.datacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_roles)
          AND NOT (
            acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
            AND acl.privilege_type = 'CONNECT'
            AND NOT acl.is_grantable
          )
      ) OR EXISTS (
        SELECT 1 FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_roles)
      ) OR EXISTS (
        SELECT 1 FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_roles)
      ) OR EXISTS (
        SELECT 1 FROM pg_proc routine
        CROSS JOIN LATERAL aclexplode(routine.proacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_roles)
      )
    ) AS present
  `, [isolatedRoles, roles.migration]);
  if (directIsolatedAcl.rows[0]?.present !== false) {
    throw fixedError("self_host_database_direct_login_acl_present");
  }
}

async function inspectMetadataAndMigrationPrivileges(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const result = await client.query(`
    WITH app_relations AS (
      SELECT relation.oid
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ), app_sequences AS (
      SELECT relation.oid
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
    )
    SELECT
      has_database_privilege($1, current_database(), 'CONNECT')
        AND NOT has_database_privilege($1, current_database(), 'CREATE')
        AND NOT has_database_privilege($1, current_database(), 'TEMP')
        AND NOT EXISTS (
          SELECT 1 FROM pg_database database
           WHERE database.datallowconn
             AND NOT database.datistemplate
             AND database.datname <> current_database()
             AND (
               has_database_privilege($1, database.oid, 'CONNECT')
               OR has_database_privilege($1, database.oid, 'CREATE')
               OR has_database_privilege($1, database.oid, 'TEMP')
             )
        )
        AND has_schema_privilege($1, 'public', 'USAGE')
        AND NOT has_schema_privilege($1, 'public', 'CREATE')
        AND NOT EXISTS (
          SELECT 1 FROM app_relations
           WHERE has_table_privilege($1, oid, 'SELECT')
              OR has_table_privilege($1, oid, 'INSERT')
              OR has_table_privilege($1, oid, 'UPDATE')
              OR has_table_privilege($1, oid, 'DELETE')
        )
        AND NOT EXISTS (
          SELECT 1 FROM app_sequences
           WHERE has_sequence_privilege($1, oid, 'USAGE')
              OR has_sequence_privilege($1, oid, 'SELECT')
              OR has_sequence_privilege($1, oid, 'UPDATE')
        ) AS metadata_safe,
      has_database_privilege($2, current_database(), 'CONNECT')
        AND NOT EXISTS (
          SELECT 1 FROM pg_database database
           WHERE database.datallowconn
             AND NOT database.datistemplate
             AND database.datname <> current_database()
             AND (
               has_database_privilege($2, database.oid, 'CONNECT')
               OR has_database_privilege($2, database.oid, 'CREATE')
               OR has_database_privilege($2, database.oid, 'TEMP')
             )
        )
        AND NOT has_schema_privilege($2, 'public', 'USAGE')
        AND NOT has_schema_privilege($2, 'public', 'CREATE')
        AND NOT EXISTS (
          SELECT 1 FROM app_relations
           WHERE has_table_privilege($2, oid, 'SELECT')
              OR has_table_privilege($2, oid, 'INSERT')
              OR has_table_privilege($2, oid, 'UPDATE')
              OR has_table_privilege($2, oid, 'DELETE')
        ) AS migration_safe
  `, [roles.metadataCapability, roles.migration]);
  if (
    result.rows.length !== 1
    || result.rows[0]?.metadata_safe !== true
    || result.rows[0]?.migration_safe !== true
  ) {
    throw fixedError("self_host_database_non_service_privilege_invalid");
  }
}

async function requireFinalAclBoundary(client) {
  await inspectSchemaInventory(client);
  for (const service of SELF_HOST_DATABASE_SERVICE_ROLES) {
    await inspectServicePrivileges(client, service);
  }
  await inspectRawAclBoundary(client);
  await inspectMetadataAndMigrationPrivileges(client);
}

async function grantProfile(client, capability, profileName) {
  const profile = selfHostDatabaseAccessProfile(profileName);
  if (profileName === "dashboard") {
    for (const routine of DASHBOARD_DATABASE_ROUTINES) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO ${quoteIdentifier(capability)}`);
    }
  }
  for (const [table, privileges] of Object.entries(profile.tables)) {
    await client.query(
      `GRANT ${privileges.join(", ")} ON TABLE public.${quoteIdentifier(table)}`
      + ` TO ${quoteIdentifier(capability)}`,
    );
  }
  for (const [sequence, privileges] of Object.entries(profile.sequences)) {
    await client.query(
      `GRANT ${privileges.join(", ")} ON SEQUENCE public.${quoteIdentifier(sequence)}`
      + ` TO ${quoteIdentifier(capability)}`,
    );
  }
}

export async function finalizeSelfHostDatabase(client) {
  const roles = SELF_HOST_DATABASE_ROLES;
  const managedRoles = [
    roles.migration,
    roles.metadataCapability,
    ...SELF_HOST_DATABASE_SERVICE_ROLES.flatMap(({ capability, login }) => [
      capability,
      login,
    ]),
  ];
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('axel-self-host-database-v2', 0))",
    );
    await requireAdminAuthority(client);
    await requireStructuralBoundary(client);
    await inspectSchemaInventory(client);

    await revokePublicClusterDatabasePrivileges(client);
    await client.query(
      `REVOKE ALL PRIVILEGES ON DATABASE axel FROM ${managedRoles.map(quoteIdentifier).join(", ")}`,
    );
    await client.query(`
      GRANT CONNECT ON DATABASE axel TO
        ${[
          roles.migration,
          roles.metadataCapability,
          ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ capability }) => capability),
        ].map(quoteIdentifier).join(", ")}
    `);
    await client.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    await client.query(
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${managedRoles.map(quoteIdentifier).join(", ")}`,
    );
    await client.query(`
      GRANT USAGE ON SCHEMA public TO
        ${[
          roles.metadataCapability,
          ...SELF_HOST_DATABASE_SERVICE_ROLES.map(({ capability }) => capability),
        ].map(quoteIdentifier).join(", ")}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    await revokeDirectColumnPrivileges(client, managedRoles);
    await reconcileNonOwnerDefaultPrivileges(client);
    for (const scope of ["", " IN SCHEMA public"]) {
      for (const objectType of ["TABLES", "SEQUENCES", "ROUTINES", "TYPES"]) {
        await client.query(`
          ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(roles.owner)}${scope}
            REVOKE ALL PRIVILEGES ON ${objectType}
            FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
        `);
      }
    }
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(roles.owner)}
        REVOKE ALL PRIVILEGES ON SCHEMAS
        FROM PUBLIC, ${managedRoles.map(quoteIdentifier).join(", ")}
    `);
    for (const { profile, capability } of SELF_HOST_DATABASE_SERVICE_ROLES) {
      await grantProfile(client, capability, profile);
    }

    await requireStructuralBoundary(client);
    await requireFinalAclBoundary(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function requireCandidateIdentity(client, expectedRole) {
  const result = await client.query(`
    SELECT current_user = $1 AS current_user_safe,
           session_user = $1 AS session_user_safe,
           regexp_replace(current_setting('search_path'), '[[:space:]]+', '', 'g')
             = 'pg_catalog,public' AS search_path_safe
  `, [expectedRole]);
  if (
    result.rows.length !== 1
    || Object.values(result.rows[0]).some((value) => value !== true)
  ) {
    throw fixedError("self_host_database_candidate_identity_invalid");
  }
}

export async function verifySelfHostDatabaseAccess(
  adminClient,
  dashboardClient,
  deliveryClient,
) {
  await requireAdminAuthority(adminClient);
  await adminClient.query("BEGIN READ ONLY");
  try {
    await requireStructuralBoundary(adminClient);
    await requireFinalAclBoundary(adminClient);
  } finally {
    await adminClient.query("ROLLBACK").catch(() => {});
  }
  await requireCandidateIdentity(dashboardClient, SELF_HOST_DATABASE_ROLES.dashboardLogin);
  await requireCandidateIdentity(deliveryClient, SELF_HOST_DATABASE_ROLES.deliveryLogin);
}

async function withClient(connectionString, applicationName, operation) {
  const client = clientFor(connectionString, applicationName);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const command = process.argv[2];
  const roles = SELF_HOST_DATABASE_ROLES;
  const admin = validateSelfHostDatabaseUrl(process.env.DATABASE_ADMIN_URL, roles.admin);
  if (command === "prepare") {
    const migration = validateSelfHostDatabaseUrl(
      process.env.DATABASE_MIGRATION_URL,
      roles.migration,
    );
    const dashboard = validateSelfHostDatabaseUrl(
      process.env.DATABASE_DASHBOARD_URL,
      roles.dashboardLogin,
    );
    const delivery = validateSelfHostDatabaseUrl(
      process.env.DATABASE_DELIVERY_URL,
      roles.deliveryLogin,
    );
    const urls = [admin, migration, dashboard, delivery];
    if (new Set(urls.map(({ endpoint }) => endpoint)).size !== 1) {
      throw fixedError("self_host_database_endpoints_must_match");
    }
    if (new Set(urls.map(({ password }) => password)).size !== urls.length) {
      throw fixedError("self_host_database_passwords_must_be_distinct");
    }
    await withClient(admin.connectionString, "axel-self-host-bootstrap", (client) =>
      prepareSelfHostDatabase(client, {
        migrationPassword: migration.password,
        dashboardPassword: dashboard.password,
        deliveryPassword: delivery.password,
      }));
    process.stdout.write("self_host_database_roles_prepared\n");
    return;
  }
  if (command === "finalize") {
    await withClient(admin.connectionString, "axel-self-host-finalize", finalizeSelfHostDatabase);
    process.stdout.write("self_host_database_access_finalized\n");
    return;
  }
  if (command === "verify") {
    const dashboard = validateSelfHostDatabaseUrl(
      process.env.DATABASE_DASHBOARD_URL,
      roles.dashboardLogin,
    );
    const delivery = validateSelfHostDatabaseUrl(
      process.env.DATABASE_DELIVERY_URL,
      roles.deliveryLogin,
    );
    if (new Set([admin.endpoint, dashboard.endpoint, delivery.endpoint]).size !== 1) {
      throw fixedError("self_host_database_endpoints_must_match");
    }
    await withClient(admin.connectionString, "axel-self-host-verify-admin", async (adminClient) =>
      withClient(dashboard.connectionString, "axel-self-host-verify-dashboard", async (dashboardClient) =>
        withClient(delivery.connectionString, "axel-self-host-verify-delivery", (deliveryClient) =>
          verifySelfHostDatabaseAccess(adminClient, dashboardClient, deliveryClient))));
    process.stdout.write("self_host_database_access_verified\n");
    return;
  }
  throw fixedError("self_host_database_command_invalid");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("self_host_database_access_failed\n");
    process.exitCode = 1;
  });
}
