#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";

const { Client } = pg;
const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;

export const RUNTIME_ROLE_SQL = `
WITH database_state AS (
  SELECT oid, datdba, datacl
    FROM pg_database
   WHERE datname = current_database()
), me AS (
  SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
         rolcanlogin, rolreplication, rolbypassrls, rolconfig
    FROM pg_roles
   WHERE rolname = current_user
), capability AS (
  SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
         rolcanlogin, rolreplication, rolbypassrls
    FROM pg_roles
   WHERE rolname = $2
), verify_capability AS (
  SELECT role.*
    FROM pg_roles role
   WHERE $5::text IS NOT NULL
     AND role.rolname = $5
), stable_owner AS (
  SELECT role.oid, role.rolname, role.rolsuper, role.rolinherit,
         role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
         role.rolreplication, role.rolbypassrls
    FROM pg_roles role
    JOIN database_state database ON database.datdba = role.oid
   WHERE $3::text IS NULL OR role.rolname = $3
), expected_login_names AS (
  SELECT name FROM unnest($4::text[]) name
), expected_logins AS (
  SELECT expected.name, role.*
    FROM expected_login_names expected
    LEFT JOIN pg_roles role ON role.rolname = expected.name
), expected_migration_login_names AS (
  SELECT name FROM unnest($6::text[]) name
), expected_migration_logins AS (
  SELECT expected.name, role.*
    FROM expected_migration_login_names expected
    LEFT JOIN pg_roles role ON role.rolname = expected.name
), checked_roles AS (
  SELECT oid FROM capability
  UNION ALL
  SELECT oid FROM expected_logins WHERE oid IS NOT NULL
), non_system_schemas AS (
  SELECT oid, nspname, nspowner, nspacl
    FROM pg_namespace
   WHERE nspname <> 'information_schema'
     AND nspname !~ '^pg_'
), non_system_relations AS (
  SELECT relation.oid, namespace.nspname, relation.relname
    FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
), app_relations AS (
  SELECT oid
    FROM non_system_relations
   WHERE nspname = 'public'
     AND relname <> 'schema_migrations'
), denied_relations AS (
  SELECT oid
    FROM non_system_relations
   WHERE nspname <> 'public'
      OR relname = 'schema_migrations'
), non_system_sequences AS (
  SELECT relation.oid, namespace.nspname
    FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind = 'S'
), app_sequences AS (
  SELECT oid FROM non_system_sequences WHERE nspname = 'public'
), denied_sequences AS (
  SELECT oid FROM non_system_sequences WHERE nspname <> 'public'
), non_system_routines AS (
  SELECT routine.oid, routine.proowner, routine.proacl
    FROM pg_proc routine
    JOIN non_system_schemas namespace ON namespace.oid = routine.pronamespace
), database_acl_grants AS (
  SELECT acl.grantee, acl.privilege_type, acl.is_grantable
    FROM database_state database
    CROSS JOIN LATERAL aclexplode(
      COALESCE(database.datacl, acldefault('d', database.datdba))
    ) acl
), schema_acl_grants AS (
  SELECT namespace.oid, namespace.nspname, namespace.nspowner,
         acl.grantee, acl.privilege_type, acl.is_grantable
    FROM non_system_schemas namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) acl
), class_acl_grants AS (
  SELECT relation.oid, namespace.nspname, relation.relname, relation.relkind,
         relation.relowner, acl.grantee, acl.privilege_type, acl.is_grantable
    FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation.relowner
        )
      )
    ) acl
   WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), routine_acl_grants AS (
  SELECT routine.oid, routine.proowner, acl.grantee,
         acl.privilege_type, acl.is_grantable
    FROM non_system_routines routine
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl, acldefault('f', routine.proowner))
    ) acl
), direct_column_grants AS (
  SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
   WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
), owner_default_acl_rows AS (
  SELECT defaults.oid, defaults.defaclobjtype, defaults.defaclnamespace
    FROM pg_default_acl defaults
    CROSS JOIN stable_owner owner_role
   WHERE defaults.defaclrole = owner_role.oid
), owner_default_acl_grants AS (
  SELECT defaults.defaclobjtype, defaults.defaclnamespace,
         acl.grantee, acl.privilege_type, acl.is_grantable
    FROM pg_default_acl defaults
    CROSS JOIN stable_owner owner_role
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
   WHERE defaults.defaclrole = owner_role.oid
)
SELECT
  current_user = $1 AND session_user = $1 AS expected_role,
  regexp_replace(current_setting('search_path'), '[[:space:]]+', '', 'g') =
    'pg_catalog,public' AS effective_search_path_safe,
  cardinality($4::text[]) > 0
    AND $1 = ANY($4::text[])
    AND (SELECT count(*) FROM expected_login_names) =
      (SELECT count(DISTINCT name) FROM expected_login_names)
    AND $2 <> ALL($4::text[])
    AND ($3::text IS NULL OR ($3 <> $2 AND $3 <> ALL($4::text[])))
    AS expected_role_allowlist_safe,
  (
    $3::text IS NULL
    AND $5::text IS NULL
    AND cardinality($6::text[]) = 0
  ) OR (
    $3::text IS NOT NULL
    AND $5::text IS NOT NULL
    AND $5 <> $2
    AND $5 <> $3
    AND $5 <> ALL($4::text[])
    AND (SELECT count(*) FROM verify_capability) = 1
    AND NOT EXISTS (
      SELECT 1 FROM verify_capability role
       WHERE role.rolsuper
          OR role.rolinherit
          OR role.rolcreaterole
          OR role.rolcreatedb
          OR role.rolcanlogin
          OR role.rolreplication
          OR role.rolbypassrls
          OR EXISTS (
            SELECT 1 FROM pg_auth_members membership
             WHERE membership.member = role.oid
          )
    )
    AND cardinality($6::text[]) > 0
    AND (SELECT count(*) FROM expected_migration_login_names) =
      (SELECT count(DISTINCT name) FROM expected_migration_login_names)
    AND NOT EXISTS (
      SELECT 1 FROM expected_migration_logins login
       WHERE login.oid IS NULL
          OR login.name IN ($2, $3, $5)
          OR login.name = ANY($4::text[])
          OR login.rolsuper
          OR login.rolinherit
          OR login.rolcreaterole
          OR login.rolcreatedb
          OR NOT login.rolcanlogin
          OR login.rolreplication
          OR login.rolbypassrls
          OR (SELECT count(*) FROM pg_auth_members WHERE member = login.oid) <> 1
          OR NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
             CROSS JOIN stable_owner owner_role
             WHERE membership.roleid = owner_role.oid
               AND membership.member = login.oid
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
          )
    )
  ) AS reviewed_acl_role_inputs_safe,
  (
    NOT me.rolsuper AND me.rolinherit AND NOT me.rolcreaterole
    AND NOT me.rolcreatedb AND me.rolcanlogin AND NOT me.rolreplication
    AND NOT me.rolbypassrls
  ) AS login_attributes_safe,
  (
    NOT capability.rolsuper AND NOT capability.rolinherit
    AND NOT capability.rolcreaterole
    AND NOT capability.rolcreatedb AND NOT capability.rolcanlogin
    AND NOT capability.rolreplication AND NOT capability.rolbypassrls
  ) AS capability_attributes_safe,
  (
    NOT stable_owner.rolsuper AND NOT stable_owner.rolinherit
    AND stable_owner.rolcreaterole = ($3::text IS NOT NULL)
    AND NOT stable_owner.rolcreatedb AND NOT stable_owner.rolcanlogin
    AND NOT stable_owner.rolreplication AND NOT stable_owner.rolbypassrls
    AND EXISTS (
      SELECT 1 FROM pg_namespace namespace
       WHERE namespace.nspname = 'public'
         AND namespace.nspowner = stable_owner.oid
    )
  ) AS stable_owner_safe,
  NOT EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE membership.member = capability.oid
  ) AS capability_no_parent_memberships,
  NOT EXISTS (
    SELECT 1
      FROM pg_auth_members membership
     WHERE membership.roleid = capability.oid
       AND NOT (
         (
           $3::text IS NOT NULL
           AND membership.member = stable_owner.oid
           AND membership.admin_option
           AND NOT membership.inherit_option
           AND NOT membership.set_option
         )
         OR (
           membership.member IN (SELECT oid FROM expected_logins WHERE oid IS NOT NULL)
           AND NOT membership.admin_option
           AND membership.inherit_option
           AND NOT membership.set_option
         )
       )
  )
    AND (
      $3::text IS NULL
      OR EXISTS (
        SELECT 1 FROM pg_auth_members membership
         WHERE membership.roleid = capability.oid
           AND membership.member = stable_owner.oid
           AND membership.admin_option
           AND NOT membership.inherit_option
           AND NOT membership.set_option
      )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM expected_logins login
       WHERE login.oid IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
             WHERE membership.roleid = capability.oid
               AND membership.member = login.oid
               AND NOT membership.admin_option
               AND membership.inherit_option
               AND NOT membership.set_option
          )
    ) AS capability_child_allowlist_exact,
  NOT EXISTS (
    SELECT 1
      FROM expected_logins login
     WHERE login.oid IS NULL
        OR login.rolsuper
        OR NOT login.rolinherit
        OR login.rolcreaterole
        OR login.rolcreatedb
        OR NOT login.rolcanlogin
        OR login.rolreplication
        OR login.rolbypassrls
        OR NOT COALESCE(login.rolconfig, '{}') @> ARRAY['search_path=pg_catalog, public']
        OR (SELECT count(*) FROM pg_auth_members WHERE member = login.oid) <> 1
        OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = login.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = login.oid)
        OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = login.oid)
        OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = login.oid)
        OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = login.oid)
        OR EXISTS (
          SELECT 1 FROM pg_shdepend dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
             AND dependency.refobjid = login.oid
             AND dependency.deptype = 'o'
        )
  ) AS expected_login_roles_safe,
  NOT EXISTS (
    SELECT 1
      FROM checked_roles role
     WHERE NOT has_database_privilege(role.oid, current_database(), 'CONNECT')
        OR has_database_privilege(role.oid, current_database(), 'TEMP')
        OR has_database_privilege(role.oid, current_database(), 'CREATE')
  ) AS database_privileges_safe,
  NOT EXISTS (
    SELECT 1
      FROM non_system_schemas namespace
      CROSS JOIN checked_roles role
     WHERE (
       namespace.nspname = 'public'
       AND (
         NOT has_schema_privilege(role.oid, namespace.oid, 'USAGE')
         OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
       )
     ) OR (
       namespace.nspname <> 'public'
       AND (
         has_schema_privilege(role.oid, namespace.oid, 'USAGE')
         OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
       )
     )
  ) AS schema_privileges_safe,
  NOT EXISTS (
    SELECT 1
      FROM app_relations relation
      CROSS JOIN checked_roles role
     WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
        OR NOT has_table_privilege(role.oid, relation.oid, 'INSERT')
        OR NOT has_table_privilege(role.oid, relation.oid, 'UPDATE')
        OR NOT has_table_privilege(role.oid, relation.oid, 'DELETE')
        OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
        OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
        OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
  ) AS app_relation_privileges_exact,
  NOT EXISTS (
    SELECT 1
      FROM denied_relations relation
      CROSS JOIN checked_roles role
     WHERE has_table_privilege(role.oid, relation.oid, 'SELECT')
        OR has_table_privilege(role.oid, relation.oid, 'INSERT')
        OR has_table_privilege(role.oid, relation.oid, 'UPDATE')
        OR has_table_privilege(role.oid, relation.oid, 'DELETE')
        OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
        OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
        OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        OR has_any_column_privilege(role.oid, relation.oid, 'SELECT')
        OR has_any_column_privilege(role.oid, relation.oid, 'INSERT')
        OR has_any_column_privilege(role.oid, relation.oid, 'UPDATE')
        OR has_any_column_privilege(role.oid, relation.oid, 'REFERENCES')
  )
    AND EXISTS (
      SELECT 1 FROM denied_relations relation
       WHERE relation.oid = to_regclass('public.schema_migrations')
    ) AS denied_relation_privileges_absent,
  NOT EXISTS (SELECT 1 FROM direct_column_grants) AS direct_column_grants_absent,
  NOT EXISTS (SELECT 1 FROM database_acl_grants WHERE grantee = 0)
    AND NOT EXISTS (SELECT 1 FROM schema_acl_grants WHERE grantee = 0)
    AND NOT EXISTS (SELECT 1 FROM class_acl_grants WHERE grantee = 0)
    AND NOT EXISTS (SELECT 1 FROM routine_acl_grants WHERE grantee = 0)
    AS public_acl_grants_absent,
  $3::text IS NULL OR (
    NOT EXISTS (
      SELECT 1
        FROM database_acl_grants grant_row
        CROSS JOIN stable_owner owner_role
       WHERE NOT (
         grant_row.grantee = owner_role.oid
         OR (
           grant_row.grantee = capability.oid
           AND grant_row.privilege_type = 'CONNECT'
           AND NOT grant_row.is_grantable
         )
         OR (
           grant_row.grantee IN (SELECT oid FROM verify_capability)
           AND grant_row.privilege_type = 'CONNECT'
           AND NOT grant_row.is_grantable
         )
         OR (
           grant_row.grantee IN (
             SELECT oid FROM expected_migration_logins WHERE oid IS NOT NULL
           )
           AND grant_row.privilege_type = 'CONNECT'
           AND NOT grant_row.is_grantable
         )
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM schema_acl_grants grant_row
        CROSS JOIN stable_owner owner_role
       WHERE NOT (
         grant_row.grantee = owner_role.oid
         OR (
           grant_row.nspname = 'public'
           AND grant_row.grantee = COALESCE(
             (SELECT oid FROM pg_roles WHERE rolname = 'pg_database_owner'),
             0
           )
           AND grant_row.privilege_type IN ('CREATE', 'USAGE')
         )
         OR (
           grant_row.nspname = 'public'
           AND grant_row.grantee = capability.oid
           AND grant_row.privilege_type = 'USAGE'
           AND NOT grant_row.is_grantable
         )
         OR (
           grant_row.nspname = 'public'
           AND grant_row.grantee IN (SELECT oid FROM verify_capability)
           AND grant_row.privilege_type = 'USAGE'
           AND NOT grant_row.is_grantable
         )
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM class_acl_grants grant_row
        CROSS JOIN stable_owner owner_role
       WHERE NOT (
         grant_row.grantee = owner_role.oid
         OR (
           grant_row.grantee = capability.oid
           AND grant_row.nspname = 'public'
           AND (
             (
               grant_row.relkind <> 'S'
               AND grant_row.relname <> 'schema_migrations'
               AND grant_row.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             )
             OR (
               grant_row.relkind = 'S'
               AND grant_row.privilege_type = 'USAGE'
             )
           )
           AND NOT grant_row.is_grantable
         )
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM routine_acl_grants grant_row
        CROSS JOIN stable_owner owner_role
       WHERE grant_row.grantee <> owner_role.oid
    )
  ) AS acl_grantee_inventory_safe,
  NOT EXISTS (
    SELECT 1 FROM non_system_schemas namespace
    CROSS JOIN stable_owner owner_role
     WHERE namespace.nspowner <> owner_role.oid
  )
    AND NOT EXISTS (
      SELECT 1 FROM pg_class relation
      JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN stable_owner owner_role
       WHERE relation.relowner <> owner_role.oid
    )
    AND NOT EXISTS (
      SELECT 1 FROM non_system_routines routine
      CROSS JOIN stable_owner owner_role
       WHERE routine.proowner <> owner_role.oid
    ) AS stable_owner_controls_non_system_objects,
  $3::text IS NULL OR (
    -- Global routine/type rows remove PostgreSQL's hard-wired PUBLIC defaults;
    -- public table/sequence/type rows add only the reviewed runtime capability.
    (SELECT count(*) FROM owner_default_acl_rows) = 5
    AND NOT EXISTS (
      SELECT 1
        FROM owner_default_acl_rows defaults
       WHERE NOT (
         (defaults.defaclobjtype IN ('f', 'T') AND defaults.defaclnamespace = 0)
         OR (
           defaults.defaclobjtype IN ('r', 'S', 'T')
           AND defaults.defaclnamespace = (
             SELECT oid FROM pg_namespace WHERE nspname = 'public'
           )
         )
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM owner_default_acl_grants grant_row
        CROSS JOIN stable_owner owner_role
       WHERE NOT (
         grant_row.grantee = owner_role.oid
         OR (
           grant_row.grantee = capability.oid
           AND grant_row.defaclnamespace = (
             SELECT oid FROM pg_namespace WHERE nspname = 'public'
           )
           AND (
             (
               grant_row.defaclobjtype = 'r'
               AND grant_row.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             )
             OR (
               grant_row.defaclobjtype IN ('S', 'T')
               AND grant_row.privilege_type = 'USAGE'
             )
           )
           AND NOT grant_row.is_grantable
         )
       )
    )
    AND (
      SELECT array_agg(privilege_type ORDER BY privilege_type)
        FROM owner_default_acl_grants
       WHERE defaclobjtype = 'r'
         AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND grantee = capability.oid
    ) = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
    AND (
      SELECT array_agg(privilege_type ORDER BY privilege_type)
        FROM owner_default_acl_grants
       WHERE defaclobjtype = 'S'
         AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND grantee = capability.oid
    ) = ARRAY['USAGE']::text[]
    AND (
      SELECT array_agg(privilege_type ORDER BY privilege_type)
        FROM owner_default_acl_grants
       WHERE defaclobjtype = 'T'
         AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND grantee = capability.oid
    ) = ARRAY['USAGE']::text[]
  ) AS owner_default_acl_inventory_safe,
  NOT EXISTS (
    SELECT 1
      FROM app_sequences sequence
      CROSS JOIN checked_roles role
     WHERE NOT has_sequence_privilege(role.oid, sequence.oid, 'USAGE')
        OR has_sequence_privilege(role.oid, sequence.oid, 'SELECT')
        OR has_sequence_privilege(role.oid, sequence.oid, 'UPDATE')
  ) AS app_sequence_privileges_exact,
  NOT EXISTS (
    SELECT 1
      FROM denied_sequences sequence
      CROSS JOIN checked_roles role
     WHERE has_sequence_privilege(role.oid, sequence.oid, 'SELECT')
        OR has_sequence_privilege(role.oid, sequence.oid, 'USAGE')
        OR has_sequence_privilege(role.oid, sequence.oid, 'UPDATE')
  ) AS denied_sequence_privileges_absent,
  NOT EXISTS (
    SELECT 1
      FROM non_system_routines routine
      CROSS JOIN checked_roles role
     WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
  ) AS routine_execute_denied,
  NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM checked_roles))
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner IN (SELECT oid FROM checked_roles))
    AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner IN (SELECT oid FROM checked_roles))
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner IN (SELECT oid FROM checked_roles))
    AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typowner IN (SELECT oid FROM checked_roles))
    AND NOT EXISTS (
      SELECT 1 FROM pg_shdepend dependency
       WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
         AND dependency.refobjid IN (SELECT oid FROM checked_roles)
         AND dependency.deptype = 'o'
    )
    AS owns_nothing,
  (SELECT count(*)::integer FROM app_relations) AS table_count,
  (SELECT count(*)::integer FROM app_sequences) AS sequence_count
FROM me
CROSS JOIN capability
CROSS JOIN stable_owner;
`;

const REQUIRED_CHECKS = [
  "expected_role",
  "effective_search_path_safe",
  "expected_role_allowlist_safe",
  "reviewed_acl_role_inputs_safe",
  "login_attributes_safe",
  "capability_attributes_safe",
  "stable_owner_safe",
  "capability_no_parent_memberships",
  "capability_child_allowlist_exact",
  "expected_login_roles_safe",
  "database_privileges_safe",
  "schema_privileges_safe",
  "app_relation_privileges_exact",
  "denied_relation_privileges_absent",
  "direct_column_grants_absent",
  "public_acl_grants_absent",
  "acl_grantee_inventory_safe",
  "stable_owner_controls_non_system_objects",
  "owner_default_acl_inventory_safe",
  "app_sequence_privileges_exact",
  "denied_sequence_privileges_absent",
  "routine_execute_denied",
  "owns_nothing",
];

function validateRoleName(value) {
  if (!ROLE_NAME.test(value)) throw new Error("database_runtime_role_name_invalid");
  return value;
}

function validateExistingLoginRoles(value) {
  if (!Array.isArray(value)) throw new Error("database_runtime_role_allowlist_invalid");
  return value.map(validateRoleName);
}

export async function verifyDatabaseRuntimeRole(client, options) {
  const expectedRole = validateRoleName(options.expectedRole);
  const capabilityRole = validateRoleName(options.capabilityRole);
  const ownerRole = options.ownerRole === undefined
    ? null
    : validateRoleName(options.ownerRole);
  const verifyCapabilityRole = ownerRole === null
    ? null
    : validateRoleName(options.verifyCapabilityRole);
  const existingLoginRoles = validateExistingLoginRoles(options.existingLoginRoles ?? []);
  const migrationLoginRoles = validateExistingLoginRoles(options.migrationLoginRoles ?? []);
  const expectedLoginRoles = [expectedRole, ...existingLoginRoles];
  const reviewedRoleNames = [
    capabilityRole,
    ...(ownerRole === null ? [] : [ownerRole, verifyCapabilityRole]),
    ...expectedLoginRoles,
    ...migrationLoginRoles,
  ];
  if (
    new Set(expectedLoginRoles).size !== expectedLoginRoles.length
    || new Set(reviewedRoleNames).size !== reviewedRoleNames.length
    || (ownerRole === null && migrationLoginRoles.length !== 0)
    || (ownerRole !== null && migrationLoginRoles.length === 0)
  ) {
    throw new Error("database_runtime_role_allowlist_invalid");
  }
  const result = await client.query(RUNTIME_ROLE_SQL, [
    expectedRole,
    capabilityRole,
    ownerRole,
    expectedLoginRoles,
    verifyCapabilityRole,
    migrationLoginRoles,
  ]);
  if (result.rows.length !== 1) throw new Error("database_runtime_role_missing");
  const row = result.rows[0];
  if (REQUIRED_CHECKS.some((key) => row[key] !== true)) {
    throw new Error("database_runtime_role_privilege_mismatch");
  }
  return {
    tableCount: Number(row.table_count),
    sequenceCount: Number(row.sequence_count),
  };
}

async function main() {
  const connectionString = process.env.DATABASE_RUNTIME_URL;
  if (!connectionString) throw new Error("database_runtime_url_required");
  const expectedRole = validateRoleName(process.env.DATABASE_RUNTIME_EXPECTED_ROLE ?? "");
  const capabilityRole = validateRoleName(
    process.env.DATABASE_RUNTIME_CAPABILITY_ROLE ?? "axel_runtime",
  );
  const ownerRole = validateRoleName(process.env.DATABASE_RUNTIME_OWNER_ROLE ?? "");
  const verifyCapabilityRole = validateRoleName(
    process.env.DATABASE_VERIFY_CAPABILITY_ROLE ?? "",
  );
  const existingLoginRoles = process.env.DATABASE_RUNTIME_EXISTING_LOGIN_ROLES
    ? process.env.DATABASE_RUNTIME_EXISTING_LOGIN_ROLES.split(",").map((role) => role.trim())
    : [];
  const migrationLoginRoles = [
    validateRoleName(process.env.DATABASE_MIGRATION_LOGIN_ROLE ?? ""),
    ...(process.env.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES
      ? process.env.DATABASE_MIGRATION_EXISTING_LOGIN_ROLES
        .split(",")
        .map((role) => role.trim())
      : []),
  ];
  const client = new Client({
    connectionString,
    ssl: controlPlanePgSslOption(
      connectionString,
      process.env.CONTROL_PLANE_DB_SSL_VERIFY,
    ),
    application_name: "axel-runtime-credential-preflight",
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });

  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const result = await verifyDatabaseRuntimeRole(client, {
      expectedRole,
      capabilityRole,
      ownerRole,
      verifyCapabilityRole,
      existingLoginRoles,
      migrationLoginRoles,
    });
    await client.query("ROLLBACK");
    process.stdout.write(
      `database_runtime_preflight_ok tables=${result.tableCount} sequences=${result.sequenceCount}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("database_runtime_preflight_failed\n");
    process.exitCode = 1;
  });
}
