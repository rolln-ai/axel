#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
  DATABASE_SERVICE_PROFILE_NAMES,
  databaseServiceAccessProfile,
} from "./database-service-access-profiles.mjs";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { HOSTED_CANARY_POLICY } from "./hosted-database-policy.mjs";

const { Client } = pg;
const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const PROFILE_ENV_STEMS = Object.freeze({
  dashboard: "DASHBOARD",
  "delivery-native": "DELIVERY_NATIVE",
  "delivery-workers": "DELIVERY_WORKERS",
  "pull-worker": "PULL_WORKER",
  "delivery-edge": "DELIVERY_EDGE",
});
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
const LEGACY_RUNTIME_PROFILE = Object.freeze({
  tables: Object.freeze(Object.fromEntries(
    APPLICATION_TABLES.map((table) => [table, ["SELECT", "INSERT", "UPDATE", "DELETE"]]),
  )),
  sequences: Object.freeze(Object.fromEntries(
    APPLICATION_SEQUENCES.map((sequence) => [sequence, ["USAGE"]]),
  )),
});

function fixedError(code) {
  const error = new Error(code);
  error.name = "DatabaseServiceRoleVerificationError";
  return error;
}

function roleName(value, code = "database_service_role_name_invalid") {
  if (typeof value !== "string" || !ROLE_NAME.test(value)) throw fixedError(code);
  return value;
}

function roleNameList(value, code = "database_service_role_allowlist_invalid") {
  if (!Array.isArray(value)) throw fixedError(code);
  const result = value.map((entry) => roleName(entry, code));
  if (new Set(result).size !== result.length) throw fixedError(code);
  return result;
}

function csvRoleNames(value) {
  if (!value) return [];
  return roleNameList(value.split(",").map((entry) => entry.trim()));
}

function sameSet(actual, expected) {
  if (actual.size !== expected.size) return false;
  return [...actual].every((entry) => expected.has(entry));
}

function rowSet(rows, fields) {
  return new Set(rows.map((row) => fields.map((field) => String(row[field])).join("|")));
}

function expectedPrivilegeSet(privilegesByRelation) {
  return new Set(
    Object.entries(privilegesByRelation).flatMap(([relation, privileges]) =>
      privileges.map((privilege) => `${relation}|${privilege}`),
    ),
  );
}

export function validateDatabaseServiceRoleOptions(rawOptions) {
  const profile = rawOptions.profile;
  databaseServiceAccessProfile(profile);
  const registry = {};
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    const entry = rawOptions.registry?.[profileName];
    if (!entry || typeof entry !== "object") {
      throw fixedError("database_service_role_registry_invalid");
    }
    registry[profileName] = {
      capabilityRole: roleName(entry.capabilityRole),
      loginRole: roleName(entry.loginRole),
      existingLoginRoles: roleNameList(entry.existingLoginRoles ?? []),
    };
    if (registry[profileName].existingLoginRoles.includes(registry[profileName].loginRole)) {
      throw fixedError("database_service_role_registry_invalid");
    }
  }
  const ownerRole = roleName(rawOptions.ownerRole, "database_service_owner_role_invalid");
  const migrationLoginRoles = roleNameList(
    rawOptions.migrationLoginRoles,
    "database_service_migration_login_roles_invalid",
  );
  const verifyCapabilityRole = roleName(
    rawOptions.verifyCapabilityRole,
    "database_service_verify_capability_role_invalid",
  );
  const verifyLoginRoles = roleNameList(
    rawOptions.verifyLoginRoles,
    "database_service_verify_login_roles_invalid",
  );
  const ownerParentRoles = roleNameList(
    rawOptions.ownerParentRoles,
    "database_service_owner_parent_roles_invalid",
  );
  const legacyCapabilityRole = rawOptions.legacyCapabilityRole === undefined
    ? "axel_runtime"
    : roleName(rawOptions.legacyCapabilityRole, "database_service_legacy_role_invalid");
  const legacyLoginRoles = roleNameList(
    rawOptions.legacyLoginRoles ?? [],
    "database_service_legacy_login_roles_invalid",
  );
  const transitionalOwnerLoginRole = rawOptions.transitionalOwnerLoginRole
    ? roleName(
      rawOptions.transitionalOwnerLoginRole,
      "database_service_transitional_owner_role_invalid",
    )
    : undefined;
  if (
    transitionalOwnerLoginRole !== undefined
    && (transitionalOwnerLoginRole !== ownerRole || rawOptions.requireFinalState === true)
  ) {
    throw fixedError("database_service_transitional_owner_role_invalid");
  }
  const requiredOwnerParentRoles = new Set([
    HOSTED_CANARY_POLICY.role,
    verifyCapabilityRole,
    ...verifyLoginRoles,
    ...DATABASE_SERVICE_PROFILE_NAMES.flatMap((profileName) => [
      registry[profileName].capabilityRole,
      registry[profileName].loginRole,
      ...registry[profileName].existingLoginRoles,
    ]),
  ]);
  const allowedOwnerParentRoles = new Set([
    ...requiredOwnerParentRoles,
    legacyCapabilityRole,
    ...legacyLoginRoles,
  ]);
  if (
    [...requiredOwnerParentRoles].some((role) => !ownerParentRoles.includes(role))
    || ownerParentRoles.some((role) => !allowedOwnerParentRoles.has(role))
    || (rawOptions.requireFinalState === true
      && ownerParentRoles.some((role) => role === legacyCapabilityRole || legacyLoginRoles.includes(role)))
  ) {
    throw fixedError("database_service_owner_parent_roles_invalid");
  }
  const allNames = [
    ownerRole,
    verifyCapabilityRole,
    ...migrationLoginRoles,
    ...verifyLoginRoles,
    ...legacyLoginRoles,
    HOSTED_CANARY_POLICY.role,
    ...DATABASE_SERVICE_PROFILE_NAMES.flatMap((profileName) => [
      registry[profileName].capabilityRole,
      registry[profileName].loginRole,
      ...registry[profileName].existingLoginRoles,
    ]),
  ];
  if (new Set(allNames).size !== allNames.length || migrationLoginRoles.length === 0) {
    throw fixedError("database_service_role_names_must_be_distinct");
  }
  if (allNames.includes(legacyCapabilityRole)) {
    throw fixedError("database_service_legacy_role_collision");
  }
  const requireIdentity = rawOptions.requireIdentity !== false;
  const expectedConnectionRole = rawOptions.expectedConnectionRole === undefined
    ? registry[profile].loginRole
    : roleName(rawOptions.expectedConnectionRole, "database_service_connection_role_invalid");
  if (
    requireIdentity
    &&
    expectedConnectionRole !== registry[profile].loginRole
    && expectedConnectionRole !== verifyLoginRoles[0]
  ) {
    throw fixedError("database_service_connection_role_invalid");
  }
  return {
    profile,
    registry,
    ownerRole,
    migrationLoginRoles,
    verifyCapabilityRole,
    verifyLoginRoles,
    ownerParentRoles,
    legacyCapabilityRole,
    legacyLoginRoles,
    transitionalOwnerLoginRole,
    canary: HOSTED_CANARY_POLICY,
    requireFinalState: rawOptions.requireFinalState === true,
    requireCompleteRegistry: rawOptions.requireCompleteRegistry !== false,
    requireIdentity,
    expectedConnectionRole,
  };
}

export function databaseServiceRoleOptionsFromEnv(env = process.env) {
  if (!new Set(["0", "1"]).has(env.DATABASE_SERVICE_REQUIRE_FINAL_STATE)) {
    throw fixedError("database_service_final_state_flag_required");
  }
  const registry = {};
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    const stem = PROFILE_ENV_STEMS[profileName];
    registry[profileName] = {
      capabilityRole: env[`DATABASE_${stem}_CAPABILITY_ROLE`],
      loginRole: env[`DATABASE_${stem}_LOGIN_ROLE`],
      existingLoginRoles: csvRoleNames(env[`DATABASE_${stem}_EXISTING_LOGIN_ROLES`]),
    };
  }
  return validateDatabaseServiceRoleOptions({
    profile: env.DATABASE_SERVICE_PROFILE,
    registry,
    ownerRole: env.DATABASE_MIGRATION_ROLE,
    migrationLoginRoles: [
      roleName(env.DATABASE_MIGRATION_LOGIN_ROLE ?? ""),
      ...csvRoleNames(env.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES),
    ],
    verifyCapabilityRole: env.DATABASE_VERIFY_CAPABILITY_ROLE,
    verifyLoginRoles: [
      roleName(env.DATABASE_VERIFY_LOGIN_ROLE ?? ""),
      ...csvRoleNames(env.DATABASE_VERIFY_EXISTING_LOGIN_ROLES),
    ],
    ownerParentRoles: csvRoleNames(env.DATABASE_MIGRATION_OWNER_PARENT_ROLES),
    legacyCapabilityRole: env.DATABASE_LEGACY_RUNTIME_CAPABILITY_ROLE,
    legacyLoginRoles: csvRoleNames(env.DATABASE_LEGACY_RUNTIME_LOGIN_ROLES),
    transitionalOwnerLoginRole: env.DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE,
    requireFinalState: env.DATABASE_SERVICE_REQUIRE_FINAL_STATE === "1",
    expectedConnectionRole: env.DATABASE_SERVICE_EXPECTED_CONNECTION_ROLE,
  });
}

async function inspectRelations(client) {
  const relations = await client.query(`
    SELECT relation.relname, relation.relkind
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY relation.relname
  `);
  const tables = new Set(
    relations.rows
      .filter((row) => row.relkind !== "S" && row.relname !== "schema_migrations")
      .map((row) => row.relname),
  );
  const sequences = new Set(
    relations.rows.filter((row) => row.relkind === "S").map((row) => row.relname),
  );
  if (
    !sameSet(tables, new Set(APPLICATION_TABLES))
    || !sameSet(sequences, new Set(APPLICATION_SEQUENCES))
    || !relations.rows.some((row) => row.relname === "schema_migrations" && row.relkind === "r")
  ) {
    throw fixedError("database_service_schema_inventory_mismatch");
  }
}

async function inspectPublicOwnership(client, ownerRole) {
  const result = await client.query(`
    WITH owner_role AS (
      SELECT oid FROM pg_roles WHERE rolname = $1
    ), current_database_state AS (
      SELECT datdba FROM pg_database WHERE datname = current_database()
    ), public_schema AS (
      SELECT nspowner FROM pg_namespace WHERE nspname = 'public'
    )
    SELECT current_database_state.datdba = owner_role.oid AS owns_database,
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
      CROSS JOIN current_database_state
      CROSS JOIN public_schema
  `, [ownerRole]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row.owns_database !== true
    || row.owns_public_schema !== true
    || row.owns_public_relations !== true
    || row.owns_or_controls_public_routines !== true
    || row.owns_or_controls_public_types !== true
  ) {
    throw fixedError("database_service_public_ownership_mismatch");
  }
}

async function inspectEffectivePrivileges(client, expectedRole, profile) {
  const tableResult = await client.query(`
    SELECT relation.relname,
           privilege,
           has_table_privilege($1, relation.oid, privilege) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($2::text[]) privilege
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  `, [expectedRole, TABLE_PRIVILEGES]);
  const expectedTablePrivileges = expectedPrivilegeSet(profile.tables);
  for (const row of tableResult.rows) {
    const expected = expectedTablePrivileges.has(`${row.relname}|${row.privilege}`);
    if (row.allowed !== expected) {
      throw fixedError("database_service_effective_table_privilege_mismatch");
    }
  }

  const sequenceResult = await client.query(`
    SELECT relation.relname,
           privilege,
           has_sequence_privilege($1, relation.oid, privilege) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($2::text[]) privilege
     WHERE namespace.nspname = 'public'
       AND relation.relkind = 'S'
  `, [expectedRole, SEQUENCE_PRIVILEGES]);
  const expectedSequencePrivileges = expectedPrivilegeSet(profile.sequences);
  for (const row of sequenceResult.rows) {
    const expected = expectedSequencePrivileges.has(`${row.relname}|${row.privilege}`);
    if (row.allowed !== expected) {
      throw fixedError("database_service_effective_sequence_privilege_mismatch");
    }
  }

  const boundaries = await client.query(`
    SELECT has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
           has_database_privilege($1, current_database(), 'CREATE') AS database_create,
           has_database_privilege($1, current_database(), 'TEMPORARY') AS database_temp,
           NOT EXISTS (
             SELECT 1 FROM pg_database database
              WHERE database.datallowconn
                AND NOT database.datistemplate
                AND database.datname <> current_database()
                AND (
                  has_database_privilege($1, database.oid, 'CONNECT')
                  OR has_database_privilege($1, database.oid, 'CREATE')
                  OR has_database_privilege($1, database.oid, 'TEMPORARY')
                )
           ) AS other_databases_denied,
           has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
           has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
           NOT EXISTS (
             SELECT 1
               FROM pg_proc routine
               JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname !~ '^pg_'
                AND namespace.nspname <> 'information_schema'
                AND has_function_privilege($1, routine.oid, 'EXECUTE')
           ) AS routines_denied
  `, [expectedRole]);
  const row = boundaries.rows[0];
  if (
    row?.database_connect !== true
    || row.database_create !== false
    || row.database_temp !== false
    || row.other_databases_denied !== true
    || row.schema_usage !== true
    || row.schema_create !== false
    || row.routines_denied !== true
  ) {
    throw fixedError("database_service_effective_boundary_privilege_mismatch");
  }
}

async function inspectVerifyPrivileges(client, options) {
  const verifyRole = options.verifyLoginRoles[0];
  const result = await client.query(`
    SELECT has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
           has_database_privilege($1, current_database(), 'CREATE') AS database_create,
           has_database_privilege($1, current_database(), 'TEMPORARY') AS database_temp,
           NOT EXISTS (
             SELECT 1 FROM pg_database database
              WHERE database.datallowconn
                AND NOT database.datistemplate
                AND database.datname <> current_database()
                AND (
                  has_database_privilege($1, database.oid, 'CONNECT')
                  OR has_database_privilege($1, database.oid, 'CREATE')
                  OR has_database_privilege($1, database.oid, 'TEMPORARY')
                )
           ) AS other_databases_denied,
           has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
           has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
           NOT EXISTS (
             SELECT 1 FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname !~ '^pg_'
               AND namespace.nspname <> 'information_schema'
               AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND (
                 has_table_privilege($1, relation.oid, 'SELECT')
                 OR has_table_privilege($1, relation.oid, 'INSERT')
                 OR has_table_privilege($1, relation.oid, 'UPDATE')
                 OR has_table_privilege($1, relation.oid, 'DELETE')
                 OR has_table_privilege($1, relation.oid, 'TRUNCATE')
                 OR has_table_privilege($1, relation.oid, 'REFERENCES')
                 OR has_table_privilege($1, relation.oid, 'TRIGGER')
               )
           ) AS relations_denied,
           NOT EXISTS (
             SELECT 1 FROM pg_class sequence
             JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
             WHERE namespace.nspname !~ '^pg_'
               AND namespace.nspname <> 'information_schema'
               AND sequence.relkind = 'S'
               AND (
                 has_sequence_privilege($1, sequence.oid, 'USAGE')
                 OR has_sequence_privilege($1, sequence.oid, 'SELECT')
                 OR has_sequence_privilege($1, sequence.oid, 'UPDATE')
               )
           ) AS sequences_denied,
           NOT EXISTS (
             SELECT 1 FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname !~ '^pg_'
               AND namespace.nspname <> 'information_schema'
               AND has_function_privilege($1, routine.oid, 'EXECUTE')
           ) AS routines_denied
  `, [verifyRole]);
  const row = result.rows[0];
  if (
    row?.database_connect !== true
    || row.database_create !== false
    || row.database_temp !== false
    || row.other_databases_denied !== true
    || row.schema_usage !== true
    || row.schema_create !== false
    || row.relations_denied !== true
    || row.sequences_denied !== true
    || row.routines_denied !== true
  ) {
    throw fixedError("database_service_verify_privilege_mismatch");
  }
}

function assertSafeRoleAttributes(role, { login, inherit }) {
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
    throw fixedError("database_service_role_attributes_unsafe");
  }
}

async function inspectRoleTopology(client, options) {
  const registryRoleNames = DATABASE_SERVICE_PROFILE_NAMES.flatMap((profileName) => {
    const entry = options.registry[profileName];
    return [entry.capabilityRole, entry.loginRole, ...entry.existingLoginRoles];
  });
  const allRoleNames = [
    options.ownerRole,
    options.verifyCapabilityRole,
    ...options.verifyLoginRoles,
    ...options.migrationLoginRoles,
    ...registryRoleNames,
    options.legacyCapabilityRole,
    ...options.legacyLoginRoles,
    options.canary.role,
  ];
  const roleResult = await client.query(`
    SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls, rolconfig, rolconnlimit
      FROM pg_roles
     WHERE rolname = ANY($1::text[])
  `, [allRoleNames]);
  const roles = new Map(roleResult.rows.map((role) => [role.rolname, role]));
  if (options.requireIdentity) {
    const identity = await client.query(`
      SELECT current_user = $1 AS current_user_safe,
             session_user = $1 AS session_user_safe,
             regexp_replace(current_setting('search_path'), '[[:space:]]+', '', 'g') =
               'pg_catalog,public' AS search_path_safe
    `, [options.expectedConnectionRole]);
    if (
      identity.rows[0]?.current_user_safe !== true
      || identity.rows[0]?.session_user_safe !== true
      || identity.rows[0]?.search_path_safe !== true
    ) {
      throw fixedError("database_service_candidate_identity_mismatch");
    }
  }

  const owner = roles.get(options.ownerRole);
  const ownerFinalSafe = owner
    && !owner.rolsuper
    && !owner.rolinherit
    && owner.rolcreaterole
    && !owner.rolcreatedb
    && !owner.rolcanlogin
    && !owner.rolreplication
    && !owner.rolbypassrls
    && owner.rolconfig === null;
  const ownerTransitionalSafe = options.transitionalOwnerLoginRole === options.ownerRole
    && owner
    && !owner.rolsuper
    && owner.rolinherit
    && owner.rolcreaterole
    && owner.rolcreatedb
    && owner.rolcanlogin
    && !owner.rolreplication
    && !owner.rolbypassrls
    && owner.rolconfig === null;
  if (!ownerFinalSafe && !ownerTransitionalSafe) {
    throw fixedError("database_service_owner_attributes_unsafe");
  }

  const canary = roles.get(options.canary.role);
  const canaryConfig = new Set(canary?.rolconfig ?? []);
  if (
    !canary
    || canary.rolsuper
    || canary.rolinherit
    || canary.rolcreaterole
    || canary.rolcreatedb
    || !canary.rolcanlogin
    || canary.rolreplication
    || canary.rolbypassrls
    || canary.rolconnlimit !== options.canary.connectionLimit
    || canaryConfig.size !== options.canary.roleSettings.length
    || options.canary.roleSettings.some((setting) => !canaryConfig.has(setting))
  ) {
    throw fixedError("database_service_canary_attributes_unsafe");
  }

  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    const entry = options.registry[profileName];
    const capability = roles.get(entry.capabilityRole);
    if (!capability && !options.requireCompleteRegistry) continue;
    assertSafeRoleAttributes(capability, { login: false, inherit: false });
    for (const loginRole of [entry.loginRole, ...entry.existingLoginRoles]) {
      const login = roles.get(loginRole);
      assertSafeRoleAttributes(login, { login: true, inherit: true });
      if (
        !Array.isArray(login.rolconfig)
        || login.rolconfig.length !== 1
        || login.rolconfig[0] !== "search_path=pg_catalog, public"
      ) {
        throw fixedError("database_service_login_configuration_unsafe");
      }
    }
  }
  assertSafeRoleAttributes(roles.get(options.verifyCapabilityRole), {
    login: false,
    inherit: false,
  });
  for (const loginRole of options.verifyLoginRoles) {
    const login = roles.get(loginRole);
    assertSafeRoleAttributes(login, { login: true, inherit: true });
    const config = new Set(login.rolconfig ?? []);
    if (
      config.size !== 2
      || !config.has("search_path=pg_catalog, public")
      || !config.has("default_transaction_read_only=on")
    ) {
      throw fixedError("database_service_verify_login_configuration_unsafe");
    }
  }
  for (const loginRole of options.migrationLoginRoles) {
    assertSafeRoleAttributes(roles.get(loginRole), { login: true, inherit: false });
  }
  if (!options.requireFinalState) {
    const legacyCapability = roles.get(options.legacyCapabilityRole);
    if (legacyCapability) {
      assertSafeRoleAttributes(legacyCapability, { login: false, inherit: false });
      for (const loginRole of options.legacyLoginRoles) {
        assertSafeRoleAttributes(roles.get(loginRole), { login: true, inherit: true });
      }
    } else if (options.legacyLoginRoles.length !== 0) {
      throw fixedError("database_service_legacy_role_inventory_mismatch");
    }
  }

  const memberships = await client.query(`
    SELECT parent.rolname AS parent, child.rolname AS child,
           membership.admin_option, membership.inherit_option, membership.set_option
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles child ON child.oid = membership.member
     WHERE parent.rolname = ANY($1::text[])
        OR child.rolname = ANY($1::text[])
  `, [allRoleNames]);
  const actualMemberships = rowSet(memberships.rows, [
    "parent",
    "child",
    "admin_option",
    "inherit_option",
    "set_option",
  ]);
  const expectedMemberships = new Set();
  const addCreatorMembership = (parent) => {
    expectedMemberships.add(`${parent}|${options.ownerRole}|true|false|false`);
  };
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    const entry = options.registry[profileName];
    if (!roles.has(entry.capabilityRole) && !options.requireCompleteRegistry) continue;
    addCreatorMembership(entry.capabilityRole);
    for (const loginRole of [entry.loginRole, ...entry.existingLoginRoles]) {
      expectedMemberships.add(`${entry.capabilityRole}|${loginRole}|false|true|false`);
      addCreatorMembership(loginRole);
    }
  }
  addCreatorMembership(options.verifyCapabilityRole);
  for (const loginRole of options.verifyLoginRoles) {
    expectedMemberships.add(`${options.verifyCapabilityRole}|${loginRole}|false|true|false`);
    addCreatorMembership(loginRole);
  }
  for (const loginRole of options.migrationLoginRoles) {
    expectedMemberships.add(`${options.ownerRole}|${loginRole}|false|false|true`);
  }
  if (!options.requireFinalState && roles.has(options.legacyCapabilityRole)) {
    addCreatorMembership(options.legacyCapabilityRole);
    for (const loginRole of options.legacyLoginRoles) {
      expectedMemberships.add(
        `${options.legacyCapabilityRole}|${loginRole}|false|true|false`,
      );
      addCreatorMembership(loginRole);
    }
  }
  for (const parentRole of options.ownerParentRoles) {
    expectedMemberships.add(`${parentRole}|${options.ownerRole}|true|false|false`);
  }
  if (!sameSet(actualMemberships, expectedMemberships)) {
    throw fixedError("database_service_role_membership_mismatch");
  }

  const owned = await client.query(`
    WITH checked_roles AS (
      SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[])
    )
    SELECT
      (SELECT count(*) FROM pg_database object JOIN checked_roles role ON role.oid = object.datdba)
      + (SELECT count(*) FROM pg_namespace object JOIN checked_roles role ON role.oid = object.nspowner)
      + (SELECT count(*) FROM pg_class object JOIN checked_roles role ON role.oid = object.relowner)
      + (SELECT count(*) FROM pg_proc object JOIN checked_roles role ON role.oid = object.proowner)
      + (SELECT count(*) FROM pg_type object JOIN checked_roles role ON role.oid = object.typowner)
      + (SELECT count(*) FROM pg_default_acl object JOIN checked_roles role ON role.oid = object.defaclrole)
      + (SELECT count(*) FROM pg_shdepend dependency
          JOIN checked_roles role ON role.oid = dependency.refobjid
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
           AND dependency.deptype = 'o')
      AS count
  `, [
    [
      ...registryRoleNames,
      options.verifyCapabilityRole,
      ...options.verifyLoginRoles,
      options.legacyCapabilityRole,
      ...options.legacyLoginRoles,
      options.canary.role,
    ],
  ]);
  if (Number(owned.rows[0]?.count) !== 0) {
    throw fixedError("database_service_role_owns_objects");
  }

  if (
    options.requireFinalState
    && (roles.has(options.legacyCapabilityRole)
      || options.legacyLoginRoles.some((role) => roles.has(role)))
  ) {
    throw fixedError("database_service_legacy_capability_present");
  }
}

async function inspectRawAclInventory(client, options) {
  const capabilityProfiles = new Map(
    DATABASE_SERVICE_PROFILE_NAMES.map((profileName) => [
      options.registry[profileName].capabilityRole,
      profileName,
    ]),
  );
  const loginRoles = new Set(
    [
      ...DATABASE_SERVICE_PROFILE_NAMES.flatMap((profileName) => {
        const entry = options.registry[profileName];
        return [entry.loginRole, ...entry.existingLoginRoles];
      }),
      ...options.verifyLoginRoles,
      ...options.legacyLoginRoles,
    ],
  );
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
  const actualByCapability = new Map();
  const actualLegacyAcl = new Set();
  const legacyRole = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [options.legacyCapabilityRole],
  );
  const legacyPresent = legacyRole.rows.length === 1;
  for (const row of classAcl.rows) {
    if (row.grantee === options.ownerRole) continue;
    if (!capabilityProfiles.has(row.grantee)) {
      if (!options.requireFinalState && row.grantee === options.legacyCapabilityRole) {
        if (row.is_grantable) throw fixedError("database_service_grant_option_present");
        actualLegacyAcl.add(
          `${row.relkind === "S" ? "sequence" : "table"}|${row.relname}|${row.privilege_type}`,
        );
        continue;
      }
      throw fixedError("database_service_acl_grantee_inventory_mismatch");
    }
    if (row.is_grantable) throw fixedError("database_service_grant_option_present");
    const key = row.grantee;
    actualByCapability.set(key, actualByCapability.get(key) ?? new Set());
    actualByCapability.get(key).add(`${row.relkind === "S" ? "sequence" : "table"}|${row.relname}|${row.privilege_type}`);
  }
  for (const [capabilityRole, profileName] of capabilityProfiles) {
    const profile = databaseServiceAccessProfile(profileName);
    const expected = new Set([
      ...[...expectedPrivilegeSet(profile.tables)].map((entry) => `table|${entry}`),
      ...[...expectedPrivilegeSet(profile.sequences)].map((entry) => `sequence|${entry}`),
    ]);
    if (!sameSet(actualByCapability.get(capabilityRole) ?? new Set(), expected)) {
      throw fixedError("database_service_direct_acl_mismatch");
    }
  }
  const expectedLegacyAcl = legacyPresent && !options.requireFinalState
    ? new Set([
      ...[...expectedPrivilegeSet(LEGACY_RUNTIME_PROFILE.tables)]
        .map((entry) => `table|${entry}`),
      ...[...expectedPrivilegeSet(LEGACY_RUNTIME_PROFILE.sequences)]
        .map((entry) => `sequence|${entry}`),
    ])
    : new Set();
  if (!sameSet(actualLegacyAcl, expectedLegacyAcl)) {
    throw fixedError("database_service_legacy_acl_mismatch");
  }

  const boundaryAcl = await client.query(`
    WITH database_acl AS (
      SELECT 'database'::text AS scope,
             COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_database database
        CROSS JOIN LATERAL aclexplode(database.datacl) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE database.datname = current_database()
    ), schema_acl AS (
      SELECT 'schema'::text AS scope,
             COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE namespace.nspname = 'public'
    )
    SELECT * FROM database_acl
    UNION ALL
    SELECT * FROM schema_acl
  `);
  const expectedBoundaryAcl = new Set();
  for (const capabilityRole of capabilityProfiles.keys()) {
    expectedBoundaryAcl.add(`database|${capabilityRole}|CONNECT|false`);
    expectedBoundaryAcl.add(`schema|${capabilityRole}|USAGE|false`);
  }
  expectedBoundaryAcl.add(`database|${options.verifyCapabilityRole}|CONNECT|false`);
  expectedBoundaryAcl.add(`schema|${options.verifyCapabilityRole}|USAGE|false`);
  for (const migrationLoginRole of options.migrationLoginRoles) {
    expectedBoundaryAcl.add(`database|${migrationLoginRole}|CONNECT|false`);
  }
  expectedBoundaryAcl.add(`database|${options.canary.role}|CONNECT|false`);
  expectedBoundaryAcl.add(`schema|${options.canary.role}|USAGE|false`);
  if (!options.requireFinalState) {
    expectedBoundaryAcl.add(`database|${options.legacyCapabilityRole}|CONNECT|false`);
    expectedBoundaryAcl.add(`schema|${options.legacyCapabilityRole}|USAGE|false`);
  }
  const actualBoundaryAcl = new Set();
  for (const row of boundaryAcl.rows) {
    if (row.grantee === options.ownerRole || row.grantee.startsWith("pg_")) continue;
    const key = `${row.scope}|${row.grantee}|${row.privilege_type}|${row.is_grantable}`;
    if (!expectedBoundaryAcl.has(key)) {
      throw fixedError("database_service_boundary_acl_grantee_mismatch");
    }
    actualBoundaryAcl.add(key);
  }
  for (const key of expectedBoundaryAcl) {
    if (
      (!options.requireFinalState && key.includes(`|${options.legacyCapabilityRole}|`))
      || actualBoundaryAcl.has(key)
    ) continue;
    throw fixedError("database_service_boundary_acl_missing");
  }

  const privateAcl = await client.query(`
    SELECT (
      EXISTS (
        SELECT 1 FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        WHERE namespace.nspname <> 'public'
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND acl.grantee <> COALESCE(
            (SELECT oid FROM pg_roles WHERE rolname = $1),
            0
          )
      ) OR EXISTS (
        SELECT 1 FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(relation.relacl) acl
        WHERE namespace.nspname <> 'public'
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND acl.grantee <> COALESCE(
            (SELECT oid FROM pg_roles WHERE rolname = $1),
            0
          )
      ) OR EXISTS (
        SELECT 1 FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        CROSS JOIN LATERAL aclexplode(routine.proacl) acl
        WHERE namespace.nspname <> 'public'
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND acl.grantee <> COALESCE(
            (SELECT oid FROM pg_roles WHERE rolname = $1),
            0
          )
      )
    ) AS present
  `, [options.ownerRole]);
  if (privateAcl.rows[0]?.present !== false) {
    throw fixedError("database_service_private_schema_acl_present");
  }

  const columnAcl = await client.query(`
    SELECT namespace.nspname, relation.relname, attribute.attname,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type, acl.is_grantable
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  `);
  if (
    columnAcl.rows.length !== 1
    || columnAcl.rows[0].nspname !== "public"
    || columnAcl.rows[0].relname !== options.canary.table
    || columnAcl.rows[0].attname !== options.canary.column
    || columnAcl.rows[0].grantee !== options.canary.role
    || columnAcl.rows[0].privilege_type !== "INSERT"
    || columnAcl.rows[0].is_grantable
  ) {
    throw fixedError("database_service_column_acl_present");
  }

  const routineAcl = await client.query(`
    SELECT 1
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(routine.proacl) acl
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
       AND (
         acl.grantee = 0
         OR (
           acl.grantee <> routine.proowner
           AND grantee.rolname <> $1
         )
       )
     LIMIT 1
  `, [options.ownerRole]);
  if (routineAcl.rows.length !== 0) throw fixedError("database_service_routine_acl_present");

  const defaultAcl = await client.query(`
    SELECT defaults.defaclobjtype,
           COALESCE(namespace.nspname, '') AS schema_name,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type,
           acl.is_grantable
      FROM pg_default_acl defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      LEFT JOIN pg_roles owner_role ON owner_role.oid = defaults.defaclrole
      LEFT JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE owner_role.rolname = $1
       AND acl.grantee <> owner_role.oid
  `, [options.ownerRole]);
  const actualDefaultAcl = new Set(defaultAcl.rows.map((row) =>
    `${row.defaclobjtype}|${row.schema_name}|${row.grantee}|${row.privilege_type}|${row.is_grantable}`));
  const expectedDefaultAcl = legacyPresent && !options.requireFinalState
    ? new Set([
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map((privilege) =>
        `r|public|${options.legacyCapabilityRole}|${privilege}|false`),
      `S|public|${options.legacyCapabilityRole}|USAGE|false`,
      `T|public|${options.legacyCapabilityRole}|USAGE|false`,
    ])
    : new Set();
  if (!sameSet(actualDefaultAcl, expectedDefaultAcl)) {
    throw fixedError("database_service_default_acl_present");
  }

  const directLoginAcl = await client.query(`
    WITH checked_logins AS (
      SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[])
    )
    SELECT (
      EXISTS (
        SELECT 1 FROM pg_database database
        CROSS JOIN LATERAL aclexplode(database.datacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_logins)
      ) OR EXISTS (
        SELECT 1 FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_logins)
      ) OR EXISTS (
        SELECT 1 FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_logins)
      ) OR EXISTS (
        SELECT 1 FROM pg_proc routine
        CROSS JOIN LATERAL aclexplode(routine.proacl) acl
        WHERE acl.grantee IN (SELECT oid FROM checked_logins)
      )
    ) AS present
  `, [[...loginRoles]]);
  if (directLoginAcl.rows[0]?.present !== false) {
    throw fixedError("database_service_login_direct_acl_present");
  }
}

export async function verifyDatabaseServiceRole(client, rawOptions) {
  const options = validateDatabaseServiceRoleOptions(rawOptions);
  const profile = databaseServiceAccessProfile(options.profile);
  await inspectRelations(client);
  await inspectPublicOwnership(client, options.ownerRole);
  await inspectRoleTopology(client, options);
  await inspectRawAclInventory(client, options);
  for (const profileName of DATABASE_SERVICE_PROFILE_NAMES) {
    await inspectEffectivePrivileges(
      client,
      options.registry[profileName].loginRole,
      databaseServiceAccessProfile(profileName),
    );
  }
  if (!options.requireFinalState) {
    const legacyRole = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [options.legacyCapabilityRole],
    );
    if (legacyRole.rows.length === 1) {
      await inspectEffectivePrivileges(
        client,
        options.legacyCapabilityRole,
        LEGACY_RUNTIME_PROFILE,
      );
    }
  }
  await inspectVerifyPrivileges(client, options);
  return {
    profile: options.profile,
    tablePrivilegeCount: expectedPrivilegeSet(profile.tables).size,
    sequencePrivilegeCount: expectedPrivilegeSet(profile.sequences).size,
  };
}

async function main() {
  const connectionString = process.env.DATABASE_SERVICE_URL;
  if (!connectionString) throw fixedError("database_service_url_required");
  const options = databaseServiceRoleOptionsFromEnv();
  const client = new Client({
    connectionString,
    ssl: controlPlanePgSslOption(
      connectionString,
      process.env.CONTROL_PLANE_DB_SSL_VERIFY,
    ),
    application_name: "axel-database-service-role-preflight",
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const result = await verifyDatabaseServiceRole(client, options);
    await client.query("ROLLBACK");
    process.stdout.write(
      `database_service_role_ready profile=${result.profile} table_privileges=${result.tablePrivilegeCount} sequence_privileges=${result.sequencePrivilegeCount}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("database_service_role_verification_failed\n");
    process.exitCode = 1;
  });
}
