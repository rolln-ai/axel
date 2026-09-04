#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  APPLICATION_SEQUENCES,
  APPLICATION_TABLES,
  DATABASE_SERVICE_PROFILE_NAMES,
} from "./database-service-access-profiles.mjs";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { HOSTED_CANARY_POLICY } from "./hosted-database-policy.mjs";
import { postgresScramSha256Verifier } from "./provision-database-service-roles.mjs";
import {
  databaseServiceRoleOptionsFromEnv,
  verifyDatabaseServiceRole,
} from "./verify-database-service-role.mjs";

const { Client } = pg;
const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const PASSWORD = /^[A-Za-z0-9_-]{40,128}$/;
const APPLY_CONFIRMATION = "I_UNDERSTAND_THIS_CHANGES_DATABASE_ROLES";

export { HOSTED_CANARY_POLICY } from "./hosted-database-policy.mjs";

export class HostedDatabaseBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostedDatabaseBootstrapError";
    this.code = code;
  }
}

function fail(code) {
  throw new HostedDatabaseBootstrapError(code);
}

function roleName(value, code) {
  if (typeof value !== "string" || !ROLE_NAME.test(value)) fail(code);
  return value;
}

function password(value, code) {
  if (typeof value !== "string" || !PASSWORD.test(value)) fail(code);
  return value;
}

function quoteIdentifier(value) {
  return `"${value}"`;
}

function integer(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

export function parseHostedDatabaseBootstrapArguments(argv = []) {
  const supported = new Set(["--inspect", "--prepare", "--finalize", "--apply"]);
  if (argv.some((argument) => !supported.has(argument))) {
    fail("database_hosted_bootstrap_argument_invalid");
  }
  const phases = ["inspect", "prepare", "finalize"].filter((phase) =>
    argv.includes(`--${phase}`));
  if (phases.length > 1) fail("database_hosted_bootstrap_phase_invalid");
  const phase = phases[0] ?? "inspect";
  const apply = argv.includes("--apply");
  if (phase === "inspect" && apply) fail("database_hosted_bootstrap_apply_without_phase");
  return { phase, apply };
}

export function hostedDatabaseBootstrapOptionsFromEnv(
  env = process.env,
  args = parseHostedDatabaseBootstrapArguments(),
) {
  const ownerRole = roleName(
    env.DATABASE_MIGRATION_ROLE,
    "database_hosted_bootstrap_owner_role_invalid",
  );
  const migrationLoginRole = roleName(
    env.DATABASE_MIGRATION_LOGIN_ROLE,
    "database_hosted_bootstrap_migration_login_role_invalid",
  );
  const verifyCapabilityRole = roleName(
    env.DATABASE_VERIFY_CAPABILITY_ROLE,
    "database_hosted_bootstrap_verify_capability_role_invalid",
  );
  const verifyLoginRole = roleName(
    env.DATABASE_VERIFY_LOGIN_ROLE,
    "database_hosted_bootstrap_verify_login_role_invalid",
  );
  const roles = [
    ownerRole,
    migrationLoginRole,
    verifyCapabilityRole,
    verifyLoginRole,
    HOSTED_CANARY_POLICY.role,
  ];
  if (new Set(roles).size !== roles.length) {
    fail("database_hosted_bootstrap_role_collision");
  }

  const options = {
    ...args,
    ownerRole,
    migrationLoginRole,
    verifyCapabilityRole,
    verifyLoginRole,
    canary: HOSTED_CANARY_POLICY,
    confirmation: env.AXEL_HOSTED_DATABASE_BOOTSTRAP_CONFIRM,
  };
  if (args.apply) {
    if (options.confirmation !== APPLY_CONFIRMATION) {
      fail("database_hosted_bootstrap_confirmation_required");
    }
    if (args.phase === "prepare") {
      options.migrationPassword = password(
        env.DATABASE_MIGRATION_PASSWORD,
        "database_hosted_bootstrap_migration_password_invalid",
      );
      options.verifyPassword = password(
        env.DATABASE_VERIFY_PASSWORD,
        "database_hosted_bootstrap_verify_password_invalid",
      );
      if (options.migrationPassword === options.verifyPassword) {
        fail("database_hosted_bootstrap_passwords_must_be_distinct");
      }
    }
  }
  return options;
}

/**
 * Inspect only catalogs and aggregate metadata. No application row is read and
 * no identifier discovered from the database is returned to the caller.
 */
export async function inspectHostedDatabaseBootstrap(client, options) {
  const clusterResult = await client.query(
    `/* hosted-bootstrap:cluster */
     WITH owner_role AS (
       SELECT * FROM pg_roles WHERE rolname = $1
     ), current_database_state AS (
       SELECT * FROM pg_database WHERE datname = current_database()
     ), public_schema AS (
       SELECT * FROM pg_namespace WHERE nspname = 'public'
     )
     SELECT current_setting('server_version_num')::integer >= 170000 AS pg17,
            COALESCE(
              (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
              false
            ) AS tls_encrypted,
            current_user = session_user AS session_unswitched,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
              AS provider_admin,
            count(*) = 1 AS owner_present,
            COALESCE(bool_and(NOT owner_role.rolsuper), false) AS owner_nosuper,
            COALESCE(bool_and(owner_role.rolinherit), false) AS owner_inherit,
            COALESCE(bool_and(owner_role.rolcreaterole), false) AS owner_createrole,
            COALESCE(bool_and(owner_role.rolcreatedb), false) AS owner_createdb,
            COALESCE(bool_and(owner_role.rolcanlogin), false) AS owner_login,
            COALESCE(bool_and(NOT owner_role.rolreplication), false) AS owner_noreplication,
            COALESCE(bool_and(NOT owner_role.rolbypassrls), false) AS owner_nobypassrls,
            COALESCE(bool_and(owner_role.rolconfig IS NULL), false) AS owner_config_empty,
            COALESCE(bool_and(owner_role.rolpassword IS NULL), false)
              AS owner_password_cleared,
            COALESCE(bool_and(current_database_state.datdba = owner_role.oid), false)
              AS owner_owns_database,
            COALESCE(bool_and(public_schema.nspowner = owner_role.oid), false)
              AS owner_owns_public_schema,
            (SELECT count(*)::integer
               FROM pg_stat_activity activity
              WHERE activity.usename = $1
                AND activity.pid <> pg_backend_pid()) AS owner_other_sessions
       FROM owner_role
       CROSS JOIN current_database_state
       CROSS JOIN public_schema`,
    [options.ownerRole],
  );

  const schemaResult = await client.query(
    `/* hosted-bootstrap:schema */
     WITH owner_role AS (
       SELECT oid FROM pg_roles WHERE rolname = $1
     ), public_relations AS (
       SELECT relation.oid, relation.relname, relation.relkind, relation.relowner
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     )
     SELECT count(*) FILTER (
              WHERE relation.relkind <> 'S'
                AND relation.relname <> 'schema_migrations'
                AND NOT (relation.relname = ANY($2::text[]))
            )::integer AS unexpected_relations,
            count(*) FILTER (
              WHERE relation.relkind <> 'S'
                AND relation.relname <> 'schema_migrations'
                AND relation.relname = ANY($2::text[])
            )::integer AS expected_relations_present,
            count(*) FILTER (
              WHERE relation.relkind = 'S'
                AND NOT (relation.relname = ANY($3::text[]))
            )::integer AS unexpected_sequences,
            count(*) FILTER (
              WHERE relation.relkind = 'S'
                AND relation.relname = ANY($3::text[])
            )::integer AS expected_sequences_present,
            count(*) FILTER (
              WHERE relation.relowner <> owner_role.oid
            )::integer AS relations_not_owner_owned,
            count(*) FILTER (
              WHERE relation.relname = 'schema_migrations'
                AND relation.relkind = 'r'
            )::integer = 1 AS migration_ledger_present
       FROM public_relations relation
       CROSS JOIN owner_role`,
    [options.ownerRole, APPLICATION_TABLES, APPLICATION_SEQUENCES],
  );

  const extensionResult = await client.query(
    `/* hosted-bootstrap:extensions */
     WITH owner_role AS (
       SELECT oid FROM pg_roles WHERE rolname = $1
     ), public_routines AS (
       SELECT routine.oid, routine.proowner, routine.proacl, routine.prosecdef,
              extension.extowner AS extension_owner
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         LEFT JOIN pg_depend dependency
           ON dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = routine.oid
          AND dependency.deptype = 'e'
         LEFT JOIN pg_extension extension ON extension.oid = dependency.refobjid
        WHERE namespace.nspname = 'public'
     ), public_types AS (
       SELECT type.oid, type.typowner, extension.extowner AS extension_owner
         FROM pg_type type
         JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
         LEFT JOIN pg_depend dependency
           ON dependency.classid = 'pg_type'::regclass
          AND dependency.objid = type.oid
          AND dependency.deptype = 'e'
         LEFT JOIN pg_extension extension ON extension.oid = dependency.refobjid
        WHERE namespace.nspname = 'public'
     )
     SELECT (SELECT count(*)::integer
               FROM public_routines routine
               CROSS JOIN owner_role
              WHERE routine.proowner <> owner_role.oid
                AND routine.extension_owner = owner_role.oid)
              AS provider_owned_extension_routines,
            (SELECT count(*)::integer
               FROM public_routines routine
               CROSS JOIN owner_role
              WHERE routine.proowner <> owner_role.oid
                AND routine.extension_owner IS DISTINCT FROM owner_role.oid)
              AS unsafe_routine_owners,
            (SELECT count(*)::integer
               FROM public_routines routine
              WHERE routine.prosecdef) AS security_definer_routines,
            (SELECT count(*)::integer
               FROM public_routines candidate
               CROSS JOIN LATERAL aclexplode(
                 COALESCE(candidate.proacl, acldefault('f', candidate.proowner))
               ) acl
              WHERE acl.grantee = 0
                AND acl.privilege_type = 'EXECUTE') AS public_execute_routines,
            (SELECT count(*)::integer
               FROM public_types type
               CROSS JOIN owner_role
              WHERE type.typowner <> owner_role.oid
                AND type.extension_owner = owner_role.oid)
              AS provider_owned_extension_types,
            (SELECT count(*)::integer
               FROM public_types type
               CROSS JOIN owner_role
              WHERE type.typowner <> owner_role.oid
                AND type.extension_owner IS DISTINCT FROM owner_role.oid)
              AS unsafe_type_owners`,
    [options.ownerRole],
  );

  const boundaryResult = await client.query(
    `/* hosted-bootstrap:provider-boundary */
     SELECT count(*)::integer AS other_database_public_privileges
       FROM pg_database database
       CROSS JOIN LATERAL aclexplode(
         COALESCE(database.datacl, acldefault('d', database.datdba))
       ) acl
      WHERE database.datallowconn
        AND NOT database.datistemplate
        AND database.datname <> current_database()
        AND acl.grantee = 0
        AND acl.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')`,
  );

  const canaryResult = await client.query(
    `/* hosted-bootstrap:canary */
     WITH owner_role AS (
       SELECT oid FROM pg_roles WHERE rolname = $1
     ), canary AS (
       SELECT * FROM pg_roles WHERE rolname = $2
     ), touching_memberships AS (
       SELECT parent.rolname AS parent, child.rolname AS child,
              membership.admin_option, membership.inherit_option,
              membership.set_option, grantor.rolsuper AS grantor_super
         FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid = membership.roleid
         JOIN pg_roles child ON child.oid = membership.member
         JOIN pg_roles grantor ON grantor.oid = membership.grantor
        WHERE parent.rolname = $2 OR child.rolname = $2
     ), direct_database_acl AS (
       SELECT database.datname = current_database() AS current_database,
              acl.privilege_type, acl.is_grantable
         FROM pg_database database
         CROSS JOIN LATERAL aclexplode(
           COALESCE(database.datacl, acldefault('d', database.datdba))
         ) acl
         JOIN canary ON canary.oid = acl.grantee
     ), direct_schema_acl AS (
       SELECT namespace.nspname, acl.privilege_type, acl.is_grantable
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) acl
         JOIN canary ON canary.oid = acl.grantee
     ), direct_column_acl AS (
       SELECT namespace.nspname, relation.relname, attribute.attname,
              acl.privilege_type, acl.is_grantable
         FROM pg_attribute attribute
         JOIN pg_class relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
         JOIN canary ON canary.oid = acl.grantee
        WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
     ), owned_objects AS (
       SELECT
         (SELECT count(*) FROM pg_database object JOIN canary ON canary.oid = object.datdba)
         + (SELECT count(*) FROM pg_namespace object JOIN canary ON canary.oid = object.nspowner)
         + (SELECT count(*) FROM pg_class object JOIN canary ON canary.oid = object.relowner)
         + (SELECT count(*) FROM pg_proc object JOIN canary ON canary.oid = object.proowner)
         + (SELECT count(*) FROM pg_type object JOIN canary ON canary.oid = object.typowner)
         + (SELECT count(*) FROM pg_default_acl object JOIN canary ON canary.oid = object.defaclrole)
         AS count
     )
     SELECT (SELECT count(*) FROM canary) = 1 AS present,
            COALESCE((SELECT NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
                               AND NOT rolcreatedb AND rolcanlogin
                               AND NOT rolreplication AND NOT rolbypassrls
                               AND rolconnlimit = 4
                          FROM canary), false) AS attributes_safe,
            COALESCE((SELECT cardinality(rolconfig) = 3
                               AND rolconfig @> ARRAY[
                                 'search_path=pg_catalog, public',
                                 'statement_timeout=10s',
                                 'idle_in_transaction_session_timeout=15s'
                               ]
                          FROM canary), false) AS configuration_safe,
            (SELECT count(*) = 1 FROM touching_memberships)
              AND EXISTS (
                SELECT 1 FROM touching_memberships membership
                 WHERE membership.parent = $2
                   AND membership.child = $1
                   AND membership.admin_option
                   AND NOT membership.inherit_option
                   AND NOT membership.set_option
                   AND membership.grantor_super
              ) AS membership_safe,
            (SELECT count(*) = 1 FROM direct_database_acl)
              AND EXISTS (
                SELECT 1 FROM direct_database_acl acl
                 WHERE acl.current_database
                   AND acl.privilege_type = 'CONNECT'
                   AND NOT acl.is_grantable
              ) AS database_acl_safe,
            (SELECT count(*) = 1 FROM direct_schema_acl)
              AND EXISTS (
                SELECT 1 FROM direct_schema_acl acl
                 WHERE acl.nspname = 'public'
                   AND acl.privilege_type = 'USAGE'
                   AND NOT acl.is_grantable
              ) AS schema_acl_safe,
            (SELECT count(*) = 1 FROM direct_column_acl)
              AND EXISTS (
                SELECT 1 FROM direct_column_acl acl
                 WHERE acl.nspname = 'public'
                   AND acl.relname = $3
                   AND acl.attname = $4
                   AND acl.privilege_type = 'INSERT'
                   AND NOT acl.is_grantable
              ) AS column_acl_safe,
            NOT EXISTS (
              SELECT 1 FROM pg_class relation
              CROSS JOIN canary
              CROSS JOIN LATERAL aclexplode(relation.relacl) acl
               WHERE acl.grantee = canary.oid
            ) AS relation_acl_safe,
            NOT EXISTS (
              SELECT 1 FROM pg_proc routine
              CROSS JOIN canary
              CROSS JOIN LATERAL aclexplode(routine.proacl) acl
               WHERE acl.grantee = canary.oid
            ) AS routine_acl_safe,
            (SELECT count FROM owned_objects) = 0 AS owns_no_objects
       FROM owner_role`,
    [
      options.ownerRole,
      options.canary.role,
      options.canary.table,
      options.canary.column,
    ],
  );

  const bootstrapRoleResult = await client.query(
    `/* hosted-bootstrap:roles */
     WITH named_roles AS (
       SELECT role.*
         FROM pg_roles role
        WHERE role.rolname = ANY($1::text[])
     ), migration AS (
       SELECT * FROM named_roles WHERE rolname = $2
     ), verify_capability AS (
       SELECT * FROM named_roles WHERE rolname = $3
     ), verify_login AS (
       SELECT * FROM named_roles WHERE rolname = $4
     ), touching_memberships AS (
       SELECT parent.rolname AS parent, child.rolname AS child,
              membership.admin_option, membership.inherit_option,
              membership.set_option, grantor.rolsuper AS grantor_super
         FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid = membership.roleid
         JOIN pg_roles child ON child.oid = membership.member
         JOIN pg_roles grantor ON grantor.oid = membership.grantor
        WHERE parent.rolname = ANY($1::text[]) OR child.rolname = ANY($1::text[])
     ), direct_acl AS (
       SELECT 'database'::text AS scope, grantee.rolname AS grantee,
              acl.privilege_type, acl.is_grantable
         FROM pg_database database
         CROSS JOIN LATERAL aclexplode(
           COALESCE(database.datacl, acldefault('d', database.datdba))
         ) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE database.datname = current_database()
          AND grantee.rolname = ANY($1::text[])
       UNION ALL
       SELECT 'schema', grantee.rolname, acl.privilege_type, acl.is_grantable
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = 'public'
          AND grantee.rolname = ANY($1::text[])
     )
     SELECT (SELECT count(*)::integer FROM named_roles) AS existing_role_count,
            COALESCE((SELECT NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
                               AND NOT rolcreatedb AND rolcanlogin
                               AND NOT rolreplication AND NOT rolbypassrls
                          FROM migration), false) AS migration_attributes_safe,
            COALESCE((SELECT NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
                               AND NOT rolcreatedb AND NOT rolcanlogin
                               AND NOT rolreplication AND NOT rolbypassrls
                          FROM verify_capability), false)
              AS verify_capability_attributes_safe,
            COALESCE((SELECT NOT rolsuper AND rolinherit AND NOT rolcreaterole
                               AND NOT rolcreatedb AND rolcanlogin
                               AND NOT rolreplication AND NOT rolbypassrls
                               AND cardinality(rolconfig) = 2
                               AND rolconfig @> ARRAY[
                                 'search_path=pg_catalog, public',
                                 'default_transaction_read_only=on'
                               ]
                          FROM verify_login), false) AS verify_login_attributes_safe,
            (SELECT count(*) = 4 FROM touching_memberships)
              AND EXISTS (
                SELECT 1 FROM touching_memberships
                 WHERE parent = $5 AND child = $2
                   AND NOT admin_option AND NOT inherit_option AND set_option
                   AND grantor_super
              )
              AND EXISTS (
                SELECT 1 FROM touching_memberships
                 WHERE parent = $3 AND child = $4
                   AND NOT admin_option AND inherit_option AND NOT set_option
                   AND grantor_super
              )
              AND EXISTS (
                SELECT 1 FROM touching_memberships
                 WHERE parent = $3 AND child = $5
                   AND admin_option AND NOT inherit_option AND NOT set_option
                   AND grantor_super
              )
              AND EXISTS (
                SELECT 1 FROM touching_memberships
                 WHERE parent = $4 AND child = $5
                   AND admin_option AND NOT inherit_option AND NOT set_option
                   AND grantor_super
              ) AS memberships_safe,
            (SELECT count(*) = 3 FROM direct_acl)
              AND EXISTS (
                SELECT 1 FROM direct_acl WHERE scope = 'database' AND grantee = $2
                  AND privilege_type = 'CONNECT' AND NOT is_grantable
              )
              AND EXISTS (
                SELECT 1 FROM direct_acl WHERE scope = 'database' AND grantee = $3
                  AND privilege_type = 'CONNECT' AND NOT is_grantable
              )
              AND EXISTS (
                SELECT 1 FROM direct_acl WHERE scope = 'schema' AND grantee = $3
                  AND privilege_type = 'USAGE' AND NOT is_grantable
              ) AS direct_acl_safe
       FROM named_roles
       LIMIT 1`,
    [
      [options.migrationLoginRole, options.verifyCapabilityRole, options.verifyLoginRole],
      options.migrationLoginRole,
      options.verifyCapabilityRole,
      options.verifyLoginRole,
      options.ownerRole,
    ],
  );

  const cluster = clusterResult.rows[0] ?? {};
  const schema = schemaResult.rows[0] ?? {};
  const extension = extensionResult.rows[0] ?? {};
  const boundary = boundaryResult.rows[0] ?? {};
  const canary = canaryResult.rows[0] ?? {};
  const bootstrapRoles = bootstrapRoleResult.rows[0] ?? { existing_role_count: 0 };
  const ownerTransitional = cluster.owner_nosuper === true
    && cluster.owner_inherit === true
    && cluster.owner_createrole === true
    && cluster.owner_createdb === true
    && cluster.owner_login === true
    && cluster.owner_noreplication === true
    && cluster.owner_nobypassrls === true
    && cluster.owner_config_empty === true;
  const ownerFinalAttributes = cluster.owner_nosuper === true
    && cluster.owner_inherit === false
    && cluster.owner_createrole === true
    && cluster.owner_createdb === false
    && cluster.owner_login === false
    && cluster.owner_noreplication === true
    && cluster.owner_nobypassrls === true
    && cluster.owner_config_empty === true;
  const ownerPasswordCleared = cluster.owner_password_cleared === true;
  const ownerFinal = ownerFinalAttributes && ownerPasswordCleared;
  const canarySafe = [
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
  ].every((key) => canary[key] === true);
  const existingBootstrapRoleCount = integer(bootstrapRoles.existing_role_count);
  const bootstrapRolesReady = existingBootstrapRoleCount === 3
    && bootstrapRoles.migration_attributes_safe === true
    && bootstrapRoles.verify_capability_attributes_safe === true
    && bootstrapRoles.verify_login_attributes_safe === true
    && bootstrapRoles.memberships_safe === true
    && bootstrapRoles.direct_acl_safe === true;

  return Object.freeze({
    pg17: cluster.pg17 === true,
    tlsEncrypted: cluster.tls_encrypted === true,
    sessionUnswitched: cluster.session_unswitched === true,
    providerAdmin: cluster.provider_admin === true,
    ownerPresent: cluster.owner_present === true,
    ownerTransitional,
    ownerFinalAttributes,
    ownerPasswordCleared,
    ownerFinal,
    ownerOwnsDatabase: cluster.owner_owns_database === true,
    ownerOwnsPublicSchema: cluster.owner_owns_public_schema === true,
    ownerOtherSessions: integer(cluster.owner_other_sessions),
    unexpectedRelations: integer(schema.unexpected_relations),
    missingRelations: Math.max(
      0,
      APPLICATION_TABLES.length - integer(schema.expected_relations_present),
    ),
    unexpectedSequences: integer(schema.unexpected_sequences),
    missingSequences: Math.max(
      0,
      APPLICATION_SEQUENCES.length - integer(schema.expected_sequences_present),
    ),
    relationsNotOwnerOwned: integer(schema.relations_not_owner_owned),
    migrationLedgerPresent: schema.migration_ledger_present === true,
    providerOwnedExtensionRoutines: integer(extension.provider_owned_extension_routines),
    providerOwnedExtensionTypes: integer(extension.provider_owned_extension_types),
    unsafeRoutineOwners: integer(extension.unsafe_routine_owners),
    unsafeTypeOwners: integer(extension.unsafe_type_owners),
    securityDefinerRoutines: integer(extension.security_definer_routines),
    publicExecuteRoutines: integer(extension.public_execute_routines),
    otherDatabasePublicPrivileges: integer(boundary.other_database_public_privileges),
    canarySafe,
    existingBootstrapRoleCount,
    bootstrapRolesReady,
  });
}

export function hostedDatabaseBootstrapBlockers(snapshot, phase = "inspect") {
  const blockers = [];
  const require = (condition, code) => {
    if (!condition) blockers.push(code);
  };
  require(snapshot.pg17, "postgres_17_required");
  require(snapshot.tlsEncrypted, "tls_encryption_required");
  require(snapshot.ownerPresent, "owner_role_missing");
  require(
    snapshot.ownerTransitional || snapshot.ownerFinalAttributes,
    "owner_attributes_unrecognized",
  );
  if (phase === "inspect" && snapshot.ownerFinalAttributes) {
    require(snapshot.ownerPasswordCleared, "owner_password_not_cleared");
  }
  require(snapshot.ownerOwnsDatabase, "owner_database_ownership_mismatch");
  require(snapshot.ownerOwnsPublicSchema, "owner_schema_ownership_mismatch");
  require(snapshot.relationsNotOwnerOwned === 0, "relation_ownership_mismatch");
  require(snapshot.unexpectedRelations === 0, "unexpected_relations_present");
  require(snapshot.missingRelations === 0, "expected_relations_missing");
  require(snapshot.unexpectedSequences === 0, "unexpected_sequences_present");
  require(snapshot.missingSequences === 0, "expected_sequences_missing");
  require(snapshot.migrationLedgerPresent, "migration_ledger_missing");
  require(snapshot.unsafeRoutineOwners === 0, "unsafe_routine_owner_present");
  require(snapshot.unsafeTypeOwners === 0, "unsafe_type_owner_present");
  require(snapshot.securityDefinerRoutines === 0, "security_definer_routine_present");
  require(snapshot.publicExecuteRoutines === 0, "public_routine_execute_present");
  require(
    snapshot.otherDatabasePublicPrivileges === 0,
    "provider_maintenance_database_public_access",
  );
  require(snapshot.canarySafe, "canary_policy_mismatch");
  if (snapshot.existingBootstrapRoleCount !== 0 && !snapshot.bootstrapRolesReady) {
    blockers.push("bootstrap_role_partial_or_unsafe");
  }
  if (phase === "prepare") {
    require(snapshot.providerAdmin, "provider_admin_required_for_prepare");
    require(snapshot.sessionUnswitched, "provider_admin_session_must_be_unswitched");
  }
  if (phase === "finalize") {
    require(snapshot.providerAdmin, "provider_admin_required_for_finalize");
    require(snapshot.sessionUnswitched, "provider_admin_session_must_be_unswitched");
    require(snapshot.bootstrapRolesReady, "bootstrap_roles_not_ready");
    require(snapshot.ownerOtherSessions === 0, "owner_sessions_must_be_zero");
  }
  return Object.freeze([...new Set(blockers)]);
}

function assertNoBlockers(snapshot, phase) {
  const blockers = hostedDatabaseBootstrapBlockers(snapshot, phase);
  if (blockers.length !== 0) fail(`database_hosted_bootstrap_blocked:${blockers[0]}`);
}

async function setPasswordVerifier(client, setting, value) {
  const verifier = postgresScramSha256Verifier(value);
  const result = await client.query(
    "SELECT octet_length(set_config($1, $2, true)) > 0 AS configured",
    [setting, verifier],
  );
  if (result.rows[0]?.configured !== true) {
    fail("database_hosted_bootstrap_password_handoff_failed");
  }
}

/** Provider-admin-only, transactional creation of migration and verifier roles. */
export async function prepareHostedDatabaseBootstrap(client, options) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('axel-hosted-database-bootstrap-v1', 0))",
    );
    const snapshot = await inspectHostedDatabaseBootstrap(client, options);
    assertNoBlockers(snapshot, "prepare");
    if (snapshot.bootstrapRolesReady) {
      await client.query("COMMIT");
      return { changed: false };
    }
    if (snapshot.existingBootstrapRoleCount !== 0) {
      fail("database_hosted_bootstrap_role_collision");
    }

    await setPasswordVerifier(
      client,
      "axel.hosted_migration_password_verifier",
      options.migrationPassword,
    );
    await setPasswordVerifier(
      client,
      "axel.hosted_verify_password_verifier",
      options.verifyPassword,
    );
    await client.query(`
      DO $bootstrap_roles$
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          '${options.migrationLoginRole}',
          current_setting('axel.hosted_migration_password_verifier')
        );
        CREATE ROLE ${quoteIdentifier(options.verifyCapabilityRole)}
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS;
        EXECUTE format(
          'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          '${options.verifyLoginRole}',
          current_setting('axel.hosted_verify_password_verifier')
        );
      END
      $bootstrap_roles$
    `);
    await client.query(`
      GRANT ${quoteIdentifier(options.ownerRole)}
        TO ${quoteIdentifier(options.migrationLoginRole)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
    `);
    await client.query(`
      GRANT ${quoteIdentifier(options.verifyCapabilityRole)}
        TO ${quoteIdentifier(options.verifyLoginRole)}
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
    `);
    for (const role of [options.verifyCapabilityRole, options.verifyLoginRole]) {
      await client.query(`
        GRANT ${quoteIdentifier(role)} TO ${quoteIdentifier(options.ownerRole)}
          WITH ADMIN TRUE, INHERIT FALSE, SET FALSE
      `);
    }
    await client.query(`ALTER ROLE ${quoteIdentifier(options.verifyLoginRole)} RESET ALL`);
    await client.query(
      `ALTER ROLE ${quoteIdentifier(options.verifyLoginRole)} SET search_path = pg_catalog, public`,
    );
    await client.query(
      `ALTER ROLE ${quoteIdentifier(options.verifyLoginRole)} SET default_transaction_read_only = on`,
    );
    await client.query(`
      DO $bootstrap_database_acl$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO ${quoteIdentifier(options.migrationLoginRole)}, ${quoteIdentifier(options.verifyCapabilityRole)}',
          current_database()
        );
      END
      $bootstrap_database_acl$
    `);
    await client.query(
      `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(options.verifyCapabilityRole)}`,
    );

    const verified = await inspectHostedDatabaseBootstrap(client, options);
    if (!verified.bootstrapRolesReady) {
      fail("database_hosted_bootstrap_postcondition_failed");
    }
    await client.query("COMMIT");
    return { changed: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Provider-admin-only final owner conversion. Callers must first independently
 * verify every service profile; this function accepts no environment attestation.
 */
export async function finalizeHostedDatabaseOwner(client, options, verifyServiceProfiles) {
  if (typeof verifyServiceProfiles !== "function") {
    fail("database_hosted_bootstrap_service_verifier_required");
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('axel-hosted-database-bootstrap-v1', 0))",
    );
    const snapshot = await inspectHostedDatabaseBootstrap(client, options);
    assertNoBlockers(snapshot, "finalize");
    await verifyServiceProfiles({ transitionalOwner: !snapshot.ownerFinal });
    if (!snapshot.ownerFinal) {
      await client.query(`
        ALTER ROLE ${quoteIdentifier(options.ownerRole)}
          NOLOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER
          NOREPLICATION NOBYPASSRLS PASSWORD NULL
      `);
    }
    const verified = await inspectHostedDatabaseBootstrap(client, options);
    if (!verified.ownerFinal || verified.ownerOtherSessions !== 0) {
      fail("database_hosted_bootstrap_owner_finalization_failed");
    }
    await verifyServiceProfiles({ transitionalOwner: false });
    await client.query("COMMIT");
    return { changed: !snapshot.ownerFinal };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

function sanitizedStatus(snapshot, phase, blockers) {
  return [
    `phase=${phase}`,
    `ready=${blockers.length === 0 ? 1 : 0}`,
    `blockers=${blockers.length}`,
    `owner_sessions=${snapshot.ownerOtherSessions}`,
    `unexpected_relations=${snapshot.unexpectedRelations}`,
    `unexpected_sequences=${snapshot.unexpectedSequences}`,
    `provider_extension_routines=${snapshot.providerOwnedExtensionRoutines}`,
    `public_execute_routines=${snapshot.publicExecuteRoutines}`,
    `other_database_public_privileges=${snapshot.otherDatabasePublicPrivileges}`,
    `canary_safe=${snapshot.canarySafe ? 1 : 0}`,
    `bootstrap_roles_ready=${snapshot.bootstrapRolesReady ? 1 : 0}`,
    ...blockers.map((blocker) => `blocker=${blocker}`),
  ].join(" ");
}

async function main() {
  const args = parseHostedDatabaseBootstrapArguments(process.argv.slice(2));
  const options = hostedDatabaseBootstrapOptionsFromEnv(process.env, args);
  const connectionString = args.apply
    ? process.env.DATABASE_BOOTSTRAP_URL
    : process.env.DATABASE_BOOTSTRAP_URL ?? process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!connectionString) fail("database_hosted_bootstrap_url_required");
  if (args.apply && !process.env.DATABASE_BOOTSTRAP_URL) {
    fail("database_hosted_bootstrap_dedicated_url_required");
  }
  const client = new Client({
    connectionString,
    ssl: controlPlanePgSslOption(
      connectionString,
      process.env.CONTROL_PLANE_DB_SSL_VERIFY,
    ),
    application_name: "axel-hosted-database-bootstrap",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    if (args.phase === "inspect") {
      await client.query("BEGIN READ ONLY");
      const snapshot = await inspectHostedDatabaseBootstrap(client, options);
      const blockers = hostedDatabaseBootstrapBlockers(snapshot, "inspect");
      await client.query("ROLLBACK");
      process.stdout.write(`${sanitizedStatus(snapshot, args.phase, blockers)}\n`);
      if (blockers.length !== 0) process.exitCode = 2;
      return;
    }
    if (!args.apply) {
      await client.query("BEGIN READ ONLY");
      const snapshot = await inspectHostedDatabaseBootstrap(client, options);
      const blockers = hostedDatabaseBootstrapBlockers(snapshot, args.phase);
      await client.query("ROLLBACK");
      process.stdout.write(`${sanitizedStatus(snapshot, args.phase, blockers)}\n`);
      if (blockers.length !== 0) process.exitCode = 2;
      return;
    }
    if (args.phase === "prepare") {
      const result = await prepareHostedDatabaseBootstrap(client, options);
      process.stdout.write(`database_hosted_bootstrap_prepared changed=${result.changed ? 1 : 0}\n`);
      return;
    }
    const overlapOptions = databaseServiceRoleOptionsFromEnv({
      ...process.env,
      DATABASE_SERVICE_PROFILE: "dashboard",
      DATABASE_SERVICE_REQUIRE_FINAL_STATE: "0",
      DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE: options.ownerRole,
    });
    const result = await finalizeHostedDatabaseOwner(
      client,
      options,
      async ({ transitionalOwner }) => {
        for (const profile of DATABASE_SERVICE_PROFILE_NAMES) {
          await verifyDatabaseServiceRole(client, {
            ...overlapOptions,
            profile,
            transitionalOwnerLoginRole: transitionalOwner
              ? options.ownerRole
              : undefined,
            requireFinalState: !transitionalOwner,
            requireIdentity: false,
          });
        }
      },
    );
    process.stdout.write(
      `database_hosted_bootstrap_finalized changed=${result.changed ? 1 : 0}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("database_hosted_bootstrap_failed\n");
    process.exitCode = 1;
  });
}
