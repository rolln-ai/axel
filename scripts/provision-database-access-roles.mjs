#!/usr/bin/env node

import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";
const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;

function fixedError(code) {
  const error = new Error(code);
  error.name = "DatabaseAccessProvisionError";
  return error;
}

function roleName(value, code) {
  if (typeof value !== "string" || !ROLE_NAME.test(value)) throw fixedError(code);
  return value;
}

function password(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(value)) {
    throw fixedError(code);
  }
  return value;
}

function roleNameList(value, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw fixedError(code);
  const names = value.map((entry) => roleName(entry, code));
  if (new Set(names).size !== names.length) throw fixedError(code);
  return names;
}

export function postgresScramSha256Verifier(value, salt = randomBytes(16)) {
  if (typeof value !== "string" || !Buffer.isBuffer(salt) || salt.length < 16) {
    throw fixedError("database_scram_verifier_input_invalid");
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

export function validateDatabaseAccessInputs(options) {
  const result = {
    migrationRole: roleName(options.migrationRole, "database_migration_role_invalid"),
    migrationLoginRole: roleName(
      options.migrationLoginRole,
      "database_migration_login_role_invalid",
    ),
    migrationExistingLoginRoles: roleNameList(
      options.migrationExistingLoginRoles,
      "database_migration_existing_login_roles_invalid",
    ),
    runtimeCapabilityRole: roleName(
      options.runtimeCapabilityRole ?? "axel_runtime",
      "database_runtime_capability_role_invalid",
    ),
    runtimeLoginRole: roleName(options.runtimeLoginRole, "database_runtime_login_role_invalid"),
    runtimeExistingLoginRoles: roleNameList(
      options.runtimeExistingLoginRoles,
      "database_runtime_existing_login_roles_invalid",
    ),
    runtimePassword: password(options.runtimePassword, "database_runtime_password_invalid"),
    verifyCapabilityRole: roleName(
      options.verifyCapabilityRole ?? "axel_verify",
      "database_verify_capability_role_invalid",
    ),
    verifyLoginRole: roleName(options.verifyLoginRole, "database_verify_login_role_invalid"),
    verifyExistingLoginRoles: roleNameList(
      options.verifyExistingLoginRoles,
      "database_verify_existing_login_roles_invalid",
    ),
    verifyPassword: password(options.verifyPassword, "database_verify_password_invalid"),
  };
  const names = [
    result.migrationRole,
    result.migrationLoginRole,
    result.runtimeCapabilityRole,
    result.runtimeLoginRole,
    result.verifyCapabilityRole,
    result.verifyLoginRole,
    ...result.runtimeExistingLoginRoles,
    ...result.verifyExistingLoginRoles,
    ...result.migrationExistingLoginRoles,
  ];
  if (new Set(names).size !== names.length) throw fixedError("database_role_names_must_be_distinct");
  if (result.runtimePassword === result.verifyPassword) {
    throw fixedError("database_role_passwords_must_be_distinct");
  }
  return result;
}

async function requireProvisioningAuthority(client, options, allowTransitionalLoginParents = false) {
  const allowedParentRoles = [
    options.runtimeCapabilityRole,
    options.verifyCapabilityRole,
    ...(allowTransitionalLoginParents
      ? [
          options.runtimeLoginRole,
          ...options.runtimeExistingLoginRoles,
          options.verifyLoginRole,
          ...options.verifyExistingLoginRoles,
        ]
      : []),
  ];
  const result = await client.query(`
    SELECT current_setting('server_version_num')::integer >= 170000 AS pg17,
           current_user = $1 AS expected_owner,
           (
             NOT role.rolsuper AND NOT role.rolinherit
             AND role.rolcreaterole AND NOT role.rolcreatedb
             AND NOT role.rolcanlogin AND NOT role.rolreplication
             AND NOT role.rolbypassrls
           ) AS owner_attributes_safe,
           NOT EXISTS (
             SELECT 1
               FROM pg_auth_members membership
               JOIN pg_roles parent ON parent.oid = membership.roleid
              WHERE membership.member = role.oid
                AND (
                  parent.rolname <> ALL($2::text[])
                  OR
                  NOT membership.admin_option
                  OR membership.inherit_option
                  OR membership.set_option
                )
           ) AS owner_parent_memberships_safe,
           database.datdba = role.oid AS owns_database,
           public_schema.nspowner = role.oid AS owns_public_schema,
           has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
           has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
           NOT EXISTS (
             SELECT 1
               FROM aclexplode(
                 COALESCE(
                   public_schema.nspacl,
                   acldefault('n', public_schema.nspowner)
                 )
               ) acl
              WHERE acl.privilege_type = 'CREATE'
                AND acl.grantee <> 0
                AND acl.grantee <> role.oid
                AND acl.grantee <> COALESCE(
                  (SELECT oid FROM pg_roles WHERE rolname = 'pg_database_owner'),
                  0
                )
           ) AS public_schema_exclusive,
           NOT EXISTS (
             SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'public'
                AND relation.relowner <> role.oid
           ) AS owns_relations,
           NOT EXISTS (
             SELECT 1
               FROM pg_proc routine
               JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname = 'public'
                AND routine.proowner <> role.oid
           ) AS owns_routines,
           NOT EXISTS (
             SELECT 1
               FROM pg_type type
               JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
              WHERE namespace.nspname = 'public'
                AND type.typowner <> role.oid
           ) AS owns_types
      FROM pg_roles role
      JOIN pg_database database ON database.datname = current_database()
      JOIN pg_namespace public_schema ON public_schema.nspname = 'public'
     WHERE role.rolname = current_user
  `, [
    options.migrationRole,
    allowedParentRoles,
  ]);
  const row = result.rows[0];
  const checks = [
    "pg17",
    "expected_owner",
    "owner_attributes_safe",
    "owner_parent_memberships_safe",
    "owns_database",
    "owns_public_schema",
    "schema_usage",
    "schema_create",
    "public_schema_exclusive",
    "owns_relations",
    "owns_routines",
    "owns_types",
  ];
  const failedCheck = checks.find((check) => row?.[check] !== true);
  if (result.rows.length !== 1 || failedCheck) {
    throw fixedError(
      failedCheck
        ? `database_role_provisioning_authority_invalid_${failedCheck}`
        : "database_role_provisioning_authority_invalid",
    );
  }
}

async function requireMigrationLoginRolesSafe(client, options) {
  const expectedLoginRoles = [
    options.migrationLoginRole,
    ...options.migrationExistingLoginRoles,
  ];
  const result = await client.query(`
    WITH owner_role AS (
      SELECT oid FROM pg_roles WHERE rolname = $1
    ), database_state AS (
      SELECT oid, datacl, datdba
        FROM pg_database
       WHERE datname = current_database()
    ), expected_names AS (
      SELECT name FROM unnest($3::text[]) name
    ), expected_roles AS (
      SELECT expected.name, role.*
        FROM expected_names expected
        LEFT JOIN pg_roles role ON role.rolname = expected.name
    )
    SELECT session_user = $2 AS expected_session_user,
           NOT EXISTS (
             SELECT 1
               FROM pg_auth_members membership
               JOIN owner_role ON owner_role.oid = membership.roleid
               JOIN pg_roles child ON child.oid = membership.member
              WHERE child.rolname <> ALL($3::text[])
                 OR membership.admin_option
                 OR membership.inherit_option
                 OR NOT membership.set_option
           )
           AND NOT EXISTS (
             SELECT 1
               FROM expected_roles login
              WHERE login.oid IS NULL
                 OR login.rolsuper
                 OR login.rolinherit
                 OR login.rolcreaterole
                 OR login.rolcreatedb
                 OR NOT login.rolcanlogin
                 OR login.rolreplication
                 OR login.rolbypassrls
                 OR EXISTS (
                   SELECT 1 FROM pg_db_role_setting setting
                    WHERE setting.setrole = login.oid
                 )
                 OR (SELECT count(*) FROM pg_auth_members WHERE member = login.oid) <> 1
                 OR NOT EXISTS (
                   SELECT 1
                     FROM pg_auth_members membership
                     JOIN owner_role ON owner_role.oid = membership.roleid
                    WHERE membership.member = login.oid
                      AND NOT membership.admin_option
                      AND NOT membership.inherit_option
                      AND membership.set_option
                 )
                 OR (
                   SELECT count(*)
                     FROM database_state
                     CROSS JOIN LATERAL aclexplode(
                       COALESCE(datacl, acldefault('d', datdba))
                     ) acl
                    WHERE acl.grantee = login.oid
                 ) <> 1
                 OR NOT EXISTS (
                   SELECT 1
                     FROM database_state
                     CROSS JOIN LATERAL aclexplode(
                       COALESCE(datacl, acldefault('d', datdba))
                     ) acl
                    WHERE acl.grantee = login.oid
                      AND acl.privilege_type = 'CONNECT'
                 )
                 OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = login.oid)
                 OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = login.oid)
                 OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = login.oid)
                 OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = login.oid)
                 OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = login.oid)
                 OR EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclrole = login.oid)
                 OR EXISTS (
                   SELECT 1
                     FROM pg_shdepend dependency
                     CROSS JOIN database_state
                    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
                      AND dependency.refobjid = login.oid
                      AND (
                        dependency.deptype = 'o'
                        OR (
                          dependency.deptype = 'a'
                          AND NOT (
                            dependency.dbid = 0
                            AND dependency.classid = 'pg_catalog.pg_database'::regclass
                            AND dependency.objid = database_state.oid
                          )
                        )
                      )
                 )
           ) AS safe
  `, [options.migrationRole, options.migrationLoginRole, expectedLoginRoles]);
  if (result.rows.length !== 1 || result.rows[0]?.expected_session_user !== true) {
    throw fixedError("database_role_provisioning_authority_invalid_session_user");
  }
  if (result.rows[0]?.safe !== true) {
    throw fixedError("database_migration_login_role_collision");
  }
}

async function requirePublicAclAllowlist(client, options) {
  const allowedRoles = [
    options.migrationRole,
    options.migrationLoginRole,
    ...options.migrationExistingLoginRoles,
    options.runtimeCapabilityRole,
    options.verifyCapabilityRole,
  ];
  const result = await client.query(`
    WITH public_schema AS (
      SELECT oid FROM pg_namespace WHERE nspname = 'public'
    ), disallowed AS (
      SELECT acl.grantee
        FROM pg_database database
        CROSS JOIN LATERAL aclexplode(
          COALESCE(database.datacl, acldefault('d', database.datdba))
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE database.datname = current_database()
         AND acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
      UNION ALL
      SELECT acl.grantee
        FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE namespace.nspname = 'public'
         AND acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
         AND grantee.rolname <> 'pg_database_owner'
      UNION ALL
      SELECT acl.grantee
        FROM pg_class relation
        JOIN public_schema ON public_schema.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            relation.relacl,
            acldefault(
              CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
              relation.relowner
            )
          )
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
      UNION ALL
      SELECT acl.grantee
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN public_schema ON public_schema.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
      UNION ALL
      SELECT acl.grantee
        FROM pg_proc routine
        JOIN public_schema ON public_schema.oid = routine.pronamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(routine.proacl, acldefault('f', routine.proowner))
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
      UNION ALL
      SELECT acl.grantee
        FROM pg_type type
        JOIN public_schema ON public_schema.oid = type.typnamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(type.typacl, acldefault('T', type.typowner))
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
      UNION ALL
      SELECT acl.grantee
        FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
        LEFT JOIN pg_roles owner_role ON owner_role.oid = defaults.defaclrole
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE owner_role.rolname = $2
         AND acl.grantee <> 0
         AND grantee.rolname <> ALL($1::text[])
    )
    SELECT NOT EXISTS (SELECT 1 FROM disallowed) AS safe
  `, [allowedRoles, options.migrationRole]);
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
    throw fixedError("database_public_acl_grantee_collision");
  }
}

async function requireExistingLoginRolesSafe(
  client,
  capabilityRole,
  allowedLoginRoles,
  requireReadOnly,
) {
  if (allowedLoginRoles.length === 0) return;
  const result = await client.query(`
    WITH expected AS (
      SELECT name FROM unnest($2::text[]) name
    ), logins AS (
      SELECT expected.name, role.*
        FROM expected
        LEFT JOIN pg_roles role ON role.rolname = expected.name
    )
    SELECT NOT EXISTS (
      SELECT 1
        FROM logins login
       WHERE login.oid IS NULL
          OR login.rolsuper
          OR NOT login.rolinherit
          OR login.rolcreaterole
          OR login.rolcreatedb
          OR NOT login.rolcanlogin
          OR login.rolreplication
          OR login.rolbypassrls
          OR NOT COALESCE(login.rolconfig, '{}') @> ARRAY['search_path=pg_catalog, public']
          OR (
            $3::boolean
            AND NOT COALESCE(login.rolconfig, '{}') @> ARRAY['default_transaction_read_only=on']
          )
          OR (SELECT count(*) FROM pg_auth_members WHERE member = login.oid) <> 1
          OR NOT EXISTS (
            SELECT 1
              FROM pg_auth_members membership
             WHERE membership.member = login.oid
               AND membership.roleid = (
                 SELECT oid FROM pg_roles WHERE rolname = $1
               )
               AND NOT membership.admin_option
               AND membership.inherit_option
               AND NOT membership.set_option
          )
          OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = login.oid)
          OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = login.oid)
          OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = login.oid)
          OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = login.oid)
          OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = login.oid)
          OR EXISTS (
            SELECT 1
              FROM pg_shdepend dependency
             WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
               AND dependency.refobjid = login.oid
               AND dependency.deptype IN ('a', 'o')
          )
    ) AS safe
  `, [capabilityRole, allowedLoginRoles, requireReadOnly]);
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
    throw fixedError("database_existing_login_role_collision");
  }
}

async function requireCapabilitySafeOrMissing(
  client,
  capabilityRole,
  migrationRole,
  allowedLoginRoles,
) {
  const result = await client.query(`
    SELECT role.rolsuper, role.rolinherit, role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
           role.rolreplication, role.rolbypassrls,
           EXISTS (
             SELECT 1 FROM pg_auth_members membership
              WHERE membership.roleid = role.oid
                AND membership.member = (SELECT oid FROM pg_roles WHERE rolname = $2)
                AND membership.admin_option
           ) AS owner_can_admin,
           NOT EXISTS (
             SELECT 1 FROM pg_auth_members membership
              WHERE membership.member = role.oid
           ) AS has_no_parent_memberships,
           NOT EXISTS (
             SELECT 1 FROM pg_auth_members membership
              WHERE membership.roleid = role.oid
                AND membership.member <> (SELECT oid FROM pg_roles WHERE rolname = $2)
                AND NOT EXISTS (
                  SELECT 1 FROM pg_roles allowed
                   WHERE allowed.oid = membership.member
                     AND allowed.rolname = ANY($3::text[])
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM unnest($3::text[]) allowed_name
               LEFT JOIN pg_roles allowed ON allowed.rolname = allowed_name
               LEFT JOIN pg_auth_members membership
                 ON membership.roleid = role.oid
                AND membership.member = allowed.oid
              WHERE allowed.oid IS NULL
                 OR membership.member IS NULL
                 OR membership.admin_option
                 OR NOT membership.inherit_option
                 OR membership.set_option
           ) AS has_only_expected_child_memberships,
           NOT EXISTS (
             SELECT 1
               FROM pg_shdepend dependency
              WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
                AND dependency.refobjid = role.oid
                AND dependency.deptype = 'a'
                AND NOT (
                  (
                    dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND dependency.classid = 'pg_catalog.pg_class'::regclass
                    AND EXISTS (
                      SELECT 1 FROM pg_class relation
                      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                       WHERE relation.oid = dependency.objid
                         AND namespace.nspname = 'public'
                    )
                  )
                  OR (
                    dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND dependency.classid = 'pg_catalog.pg_proc'::regclass
                    AND EXISTS (
                      SELECT 1 FROM pg_proc routine
                      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
                       WHERE routine.oid = dependency.objid
                         AND namespace.nspname = 'public'
                    )
                  )
                  OR (
                    dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND dependency.classid = 'pg_catalog.pg_type'::regclass
                    AND EXISTS (
                      SELECT 1 FROM pg_type type
                      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
                       WHERE type.oid = dependency.objid
                         AND namespace.nspname = 'public'
                    )
                  )
                  OR (
                    dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND dependency.classid = 'pg_catalog.pg_namespace'::regclass
                    AND dependency.objid = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
                  )
                  OR (
                    dependency.dbid = 0
                    AND dependency.classid = 'pg_catalog.pg_database'::regclass
                    AND dependency.objid = (SELECT oid FROM pg_database WHERE datname = current_database())
                  )
                  OR (
                    dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND dependency.classid = 'pg_catalog.pg_default_acl'::regclass
                    AND EXISTS (
                      SELECT 1 FROM pg_default_acl defaults
                       WHERE defaults.oid = dependency.objid
                         AND defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $2)
                         AND defaults.defaclnamespace = (
                           SELECT oid FROM pg_namespace WHERE nspname = 'public'
                         )
                         AND (
                           (
                             defaults.defaclobjtype = 'r'
                             AND (
                               SELECT array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                                 FROM aclexplode(defaults.defaclacl) acl
                                WHERE acl.grantee = role.oid
                             ) = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
                           )
                           OR (
                             defaults.defaclobjtype = 'S'
                             AND (
                               SELECT array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                                 FROM aclexplode(defaults.defaclacl) acl
                                WHERE acl.grantee = role.oid
                             ) = ARRAY['USAGE']::text[]
                           )
                           OR (
                             defaults.defaclobjtype = 'T'
                             AND (
                               SELECT array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                                 FROM aclexplode(defaults.defaclacl) acl
                                WHERE acl.grantee = role.oid
                             ) = ARRAY['USAGE']::text[]
                           )
                         )
                    )
                  )
                )
           ) AS has_no_external_acl_dependencies,
           NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba = role.oid)
             AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = role.oid)
             AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = role.oid)
             AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner = role.oid)
             AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typowner = role.oid)
             AND NOT EXISTS (
               SELECT 1 FROM pg_shdepend dependency
                WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
                  AND dependency.refobjid = role.oid
                  AND dependency.deptype = 'o'
             )
             AS owns_nothing
      FROM pg_roles role
     WHERE role.rolname = $1
  `, [capabilityRole, migrationRole, allowedLoginRoles]);
  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  const unsafeAttribute = [
    "rolsuper",
    "rolinherit",
    "rolcreaterole",
    "rolcreatedb",
    "rolcanlogin",
    "rolreplication",
    "rolbypassrls",
  ].find((attribute) => row?.[attribute] === true);
  const failedCheck = [
    "owner_can_admin",
    "has_no_parent_memberships",
    "has_only_expected_child_memberships",
    "has_no_external_acl_dependencies",
    "owns_nothing",
  ].find((check) => row?.[check] !== true);
  if (result.rows.length !== 1 || unsafeAttribute || failedCheck) {
    throw fixedError(
      unsafeAttribute || failedCheck
        ? `database_capability_role_collision_${unsafeAttribute ?? failedCheck}`
        : "database_capability_role_collision",
    );
  }
  return true;
}

const PROVISIONED_STATE_CHECKS = [
  "runtime_capability_attributes_safe",
  "verify_capability_attributes_safe",
  "runtime_login_attributes_safe",
  "verify_login_attributes_safe",
  "capability_memberships_safe",
  "login_memberships_safe",
  "database_privileges_safe",
  "schema_privileges_safe",
  "table_privileges_safe",
  "sequence_privileges_safe",
  "routine_privileges_safe",
  "column_acl_safe",
  "default_acl_inventory_safe",
  "role_settings_safe",
  "owns_nothing",
];

async function requireProvisionedState(client, options) {
  const result = await client.query(`
    WITH runtime_capability AS (
      SELECT * FROM pg_roles WHERE rolname = $1
    ), verify_capability AS (
      SELECT * FROM pg_roles WHERE rolname = $2
    ), runtime_login AS (
      SELECT * FROM pg_roles WHERE rolname = $3
    ), verify_login AS (
      SELECT * FROM pg_roles WHERE rolname = $4
    ), migration_role AS (
      SELECT * FROM pg_roles WHERE rolname = $5
    ), app_relations AS (
      SELECT relation.oid
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND relation.relname <> 'schema_migrations'
    ), public_sequences AS (
      SELECT relation.oid
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relkind = 'S'
    ), public_routines AS (
      SELECT routine.oid
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
    ), direct_column_grants AS (
      SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        CROSS JOIN runtime_capability
        CROSS JOIN verify_capability
        CROSS JOIN runtime_login
        CROSS JOIN verify_login
       WHERE namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl.grantee IN (
           0,
           runtime_capability.oid,
           verify_capability.oid,
           runtime_login.oid,
           verify_login.oid
         )
    )
    SELECT
      (
        NOT runtime_capability.rolsuper AND NOT runtime_capability.rolinherit
        AND NOT runtime_capability.rolcreaterole AND NOT runtime_capability.rolcreatedb
        AND NOT runtime_capability.rolcanlogin AND NOT runtime_capability.rolreplication
        AND NOT runtime_capability.rolbypassrls
      ) AS runtime_capability_attributes_safe,
      (
        NOT verify_capability.rolsuper AND NOT verify_capability.rolinherit
        AND NOT verify_capability.rolcreaterole AND NOT verify_capability.rolcreatedb
        AND NOT verify_capability.rolcanlogin AND NOT verify_capability.rolreplication
        AND NOT verify_capability.rolbypassrls
      ) AS verify_capability_attributes_safe,
      (
        NOT runtime_login.rolsuper AND runtime_login.rolinherit
        AND NOT runtime_login.rolcreaterole AND NOT runtime_login.rolcreatedb
        AND runtime_login.rolcanlogin AND NOT runtime_login.rolreplication
        AND NOT runtime_login.rolbypassrls
      ) AS runtime_login_attributes_safe,
      (
        NOT verify_login.rolsuper AND verify_login.rolinherit
        AND NOT verify_login.rolcreaterole AND NOT verify_login.rolcreatedb
        AND verify_login.rolcanlogin AND NOT verify_login.rolreplication
        AND NOT verify_login.rolbypassrls
      ) AS verify_login_attributes_safe,
      (
        NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.member IN (runtime_capability.oid, verify_capability.oid)
        )
        AND EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = runtime_capability.oid
             AND membership.member = migration_role.oid
             AND membership.admin_option
        )
        AND EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = verify_capability.oid
             AND membership.member = migration_role.oid
             AND membership.admin_option
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = runtime_capability.oid
             AND membership.member NOT IN (migration_role.oid, runtime_login.oid)
             AND NOT EXISTS (
               SELECT 1 FROM pg_roles allowed
                WHERE allowed.oid = membership.member
                  AND allowed.rolname = ANY($6::text[])
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM unnest($6::text[]) allowed_name
          LEFT JOIN pg_roles allowed ON allowed.rolname = allowed_name
          LEFT JOIN pg_auth_members membership
            ON membership.roleid = runtime_capability.oid
           AND membership.member = allowed.oid
         WHERE allowed.oid IS NULL
            OR membership.member IS NULL
            OR membership.admin_option
            OR NOT membership.inherit_option
            OR membership.set_option
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = verify_capability.oid
             AND membership.member NOT IN (migration_role.oid, verify_login.oid)
             AND NOT EXISTS (
               SELECT 1 FROM pg_roles allowed
                WHERE allowed.oid = membership.member
                  AND allowed.rolname = ANY($7::text[])
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM unnest($7::text[]) allowed_name
          LEFT JOIN pg_roles allowed ON allowed.rolname = allowed_name
          LEFT JOIN pg_auth_members membership
            ON membership.roleid = verify_capability.oid
           AND membership.member = allowed.oid
         WHERE allowed.oid IS NULL
            OR membership.member IS NULL
            OR membership.admin_option
            OR NOT membership.inherit_option
            OR membership.set_option
        )
      ) AS capability_memberships_safe,
      (
        (SELECT count(*) FROM pg_auth_members WHERE member = runtime_login.oid) = 1
        AND EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = runtime_capability.oid
             AND membership.member = runtime_login.oid
             AND NOT membership.admin_option
             AND membership.inherit_option
             AND NOT membership.set_option
        )
        AND (SELECT count(*) FROM pg_auth_members WHERE member = verify_login.oid) = 1
        AND EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = verify_capability.oid
             AND membership.member = verify_login.oid
             AND NOT membership.admin_option
             AND membership.inherit_option
             AND NOT membership.set_option
        )
      ) AS login_memberships_safe,
      (
        has_database_privilege($1, current_database(), 'CONNECT')
        AND has_database_privilege($2, current_database(), 'CONNECT')
        AND has_database_privilege($3, current_database(), 'CONNECT')
        AND has_database_privilege($4, current_database(), 'CONNECT')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(ARRAY['CREATE', 'TEMP']) privilege
           WHERE has_database_privilege($1, current_database(), privilege)
              OR has_database_privilege($2, current_database(), privilege)
              OR has_database_privilege($3, current_database(), privilege)
              OR has_database_privilege($4, current_database(), privilege)
        )
      ) AS database_privileges_safe,
      (
        has_schema_privilege($1, 'public', 'USAGE')
        AND has_schema_privilege($2, 'public', 'USAGE')
        AND has_schema_privilege($3, 'public', 'USAGE')
        AND has_schema_privilege($4, 'public', 'USAGE')
        AND NOT has_schema_privilege($1, 'public', 'CREATE')
        AND NOT has_schema_privilege($2, 'public', 'CREATE')
        AND NOT has_schema_privilege($3, 'public', 'CREATE')
        AND NOT has_schema_privilege($4, 'public', 'CREATE')
      ) AS schema_privileges_safe,
      (
        NOT EXISTS (
          SELECT 1 FROM app_relations
           WHERE EXISTS (
             SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege
              WHERE NOT has_table_privilege($1, oid, privilege)
                 OR NOT has_table_privilege($3, oid, privilege)
           )
              OR EXISTS (
                SELECT 1 FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
                 WHERE has_table_privilege($1, oid, privilege)
                    OR has_table_privilege($3, oid, privilege)
              )
              OR EXISTS (
                SELECT 1 FROM unnest(
                  ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                ) privilege
                 WHERE has_table_privilege($2, oid, privilege)
                    OR has_table_privilege($4, oid, privilege)
              )
        )
        AND to_regclass('public.schema_migrations') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM unnest(
            ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
          ) privilege
           WHERE has_table_privilege($1, 'public.schema_migrations', privilege)
              OR has_table_privilege($2, 'public.schema_migrations', privilege)
              OR has_table_privilege($3, 'public.schema_migrations', privilege)
              OR has_table_privilege($4, 'public.schema_migrations', privilege)
        )
        AND NOT EXISTS (
          SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) privilege
           WHERE has_any_column_privilege($1, 'public.schema_migrations', privilege)
              OR has_any_column_privilege($2, 'public.schema_migrations', privilege)
              OR has_any_column_privilege($3, 'public.schema_migrations', privilege)
              OR has_any_column_privilege($4, 'public.schema_migrations', privilege)
        )
      ) AS table_privileges_safe,
      NOT EXISTS (
        SELECT 1 FROM public_sequences
         WHERE NOT has_sequence_privilege($1, oid, 'USAGE')
            OR NOT has_sequence_privilege($3, oid, 'USAGE')
            OR EXISTS (
              SELECT 1 FROM unnest(ARRAY['SELECT', 'UPDATE']) privilege
               WHERE has_sequence_privilege($1, oid, privilege)
                  OR has_sequence_privilege($3, oid, privilege)
            )
            OR EXISTS (
              SELECT 1 FROM unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']) privilege
               WHERE has_sequence_privilege($2, oid, privilege)
                  OR has_sequence_privilege($4, oid, privilege)
            )
      ) AS sequence_privileges_safe,
      NOT EXISTS (
        SELECT 1 FROM public_routines
         WHERE has_function_privilege($1, oid, 'EXECUTE')
            OR has_function_privilege($2, oid, 'EXECUTE')
            OR has_function_privilege($3, oid, 'EXECUTE')
            OR has_function_privilege($4, oid, 'EXECUTE')
      ) AS routine_privileges_safe,
      NOT EXISTS (SELECT 1 FROM direct_column_grants) AS column_acl_safe,
      NOT EXISTS (
        SELECT 1
          FROM pg_default_acl defaults
          CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
         WHERE defaults.defaclrole = migration_role.oid
           AND acl.grantee IN (
             0,
             runtime_capability.oid,
             verify_capability.oid,
             runtime_login.oid,
             verify_login.oid
           )
           AND NOT (
             acl.grantee = runtime_capability.oid
             AND defaults.defaclnamespace = (
               SELECT oid FROM pg_namespace WHERE nspname = 'public'
             )
             AND (
               (
                 defaults.defaclobjtype = 'r'
                 AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
               )
               OR (
                 defaults.defaclobjtype = 'S'
                 AND acl.privilege_type = 'USAGE'
               )
               OR (
                 defaults.defaclobjtype = 'T'
                 AND acl.privilege_type = 'USAGE'
               )
             )
           )
      ) AS default_acl_inventory_safe,
      (
        COALESCE(runtime_login.rolconfig, '{}') @> ARRAY['search_path=pg_catalog, public']
        AND COALESCE(verify_login.rolconfig, '{}') @> ARRAY['search_path=pg_catalog, public']
        AND COALESCE(verify_login.rolconfig, '{}') @> ARRAY['default_transaction_read_only=on']
      ) AS role_settings_safe,
      (
        NOT EXISTS (
          SELECT 1 FROM pg_database
           WHERE datdba IN (
             runtime_capability.oid, verify_capability.oid,
             runtime_login.oid, verify_login.oid
           )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_namespace
           WHERE nspowner IN (
             runtime_capability.oid, verify_capability.oid,
             runtime_login.oid, verify_login.oid
           )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_class
           WHERE relowner IN (
             runtime_capability.oid, verify_capability.oid,
             runtime_login.oid, verify_login.oid
           )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_proc
           WHERE proowner IN (
             runtime_capability.oid, verify_capability.oid,
             runtime_login.oid, verify_login.oid
           )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typowner IN (
             runtime_capability.oid, verify_capability.oid,
             runtime_login.oid, verify_login.oid
           )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_shdepend dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
             AND dependency.refobjid IN (
               runtime_capability.oid, verify_capability.oid,
               runtime_login.oid, verify_login.oid
             )
             AND dependency.deptype = 'o'
        )
      ) AS owns_nothing
    FROM runtime_capability
    CROSS JOIN verify_capability
    CROSS JOIN runtime_login
    CROSS JOIN verify_login
    CROSS JOIN migration_role
  `, [
    options.runtimeCapabilityRole,
    options.verifyCapabilityRole,
    options.runtimeLoginRole,
    options.verifyLoginRole,
    options.migrationRole,
    options.runtimeExistingLoginRoles,
    options.verifyExistingLoginRoles,
  ]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || PROVISIONED_STATE_CHECKS.some((key) => row[key] !== true)
  ) {
    throw fixedError("database_access_role_postcondition_failed");
  }
}

async function requireDefaultPrivilegeState(client, options) {
  const suffix = randomBytes(8).toString("hex");
  const tableName = `axel_acl_probe_${suffix}`;
  const sequenceName = `${tableName}_id_seq`;
  const routineName = `${tableName}_routine`;
  const schemaName = `${tableName}_schema`;
  const typeName = `${tableName}_type`;
  const relation = `public.${tableName}`;
  const sequence = `public.${sequenceName}`;
  const routine = `public.${routineName}()`;

  await client.query(`CREATE TABLE public.${tableName} (id bigserial PRIMARY KEY, value text)`);
  await client.query(
    `CREATE FUNCTION public.${routineName}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
  );
  await client.query(`CREATE SCHEMA ${schemaName}`);
  await client.query(`CREATE TYPE public.${typeName} AS ENUM ('probe')`);
  const result = await client.query(`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege
         WHERE NOT has_table_privilege($1, $5::text, privilege)
            OR NOT has_table_privilege($3, $5::text, privilege)
      )
        AND NOT EXISTS (
          SELECT 1 FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
           WHERE has_table_privilege($1, $5::text, privilege)
              OR has_table_privilege($3, $5::text, privilege)
        )
        AND has_sequence_privilege($1, $6::text, 'USAGE')
        AND has_sequence_privilege($3, $6::text, 'USAGE')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(ARRAY['SELECT', 'UPDATE']) privilege
           WHERE has_sequence_privilege($1, $6::text, privilege)
              OR has_sequence_privilege($3, $6::text, privilege)
        )
        AND NOT has_function_privilege($1, $7::text, 'EXECUTE')
        AND NOT has_function_privilege($3, $7::text, 'EXECUTE')
        AND has_type_privilege($1, $9::text, 'USAGE')
        AND has_type_privilege($3, $9::text, 'USAGE')
        AND NOT has_schema_privilege($1, $8::text, 'USAGE')
        AND NOT has_schema_privilege($1, $8::text, 'CREATE')
        AND NOT has_schema_privilege($3, $8::text, 'USAGE')
        AND NOT has_schema_privilege($3, $8::text, 'CREATE')
        AS runtime_defaults_safe,
      NOT EXISTS (
        SELECT 1 FROM unnest(
          ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        ) privilege
         WHERE has_table_privilege($2, $5::text, privilege)
            OR has_table_privilege($4, $5::text, privilege)
      )
        AND NOT EXISTS (
          SELECT 1 FROM unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']) privilege
           WHERE has_sequence_privilege($2, $6::text, privilege)
              OR has_sequence_privilege($4, $6::text, privilege)
        )
        AND NOT has_function_privilege($2, $7::text, 'EXECUTE')
        AND NOT has_function_privilege($4, $7::text, 'EXECUTE')
        AND NOT has_type_privilege($2, $9::text, 'USAGE')
        AND NOT has_type_privilege($4, $9::text, 'USAGE')
        AND NOT has_schema_privilege($2, $8::text, 'USAGE')
        AND NOT has_schema_privilege($4, $8::text, 'USAGE')
        AS verify_defaults_safe,
      NOT EXISTS (
        SELECT 1
          FROM pg_class relation
          CROSS JOIN LATERAL aclexplode(
            COALESCE(relation.relacl, acldefault(
              CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
              relation.relowner
            ))
          ) acl
         WHERE relation.oid IN (to_regclass($5), to_regclass($6))
           AND acl.grantee = 0
      )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_proc routine
            CROSS JOIN LATERAL aclexplode(
              COALESCE(routine.proacl, acldefault('f', routine.proowner))
            ) acl
           WHERE routine.oid = to_regprocedure($7)
             AND acl.grantee = 0
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_namespace namespace
            CROSS JOIN LATERAL aclexplode(
              COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
            ) acl
           WHERE namespace.oid = $8::regnamespace
             AND acl.grantee = 0
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_type type
            CROSS JOIN LATERAL aclexplode(
              COALESCE(type.typacl, acldefault('T', type.typowner))
            ) acl
           WHERE type.oid = $9::regtype
             AND acl.grantee = 0
        )
        AS public_defaults_safe,
      NOT EXISTS (
        SELECT 1
          FROM pg_attribute attribute
          CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
         WHERE attribute.attrelid = to_regclass($5)
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND acl.grantee IN (
             0,
             (SELECT oid FROM pg_roles WHERE rolname = $1),
             (SELECT oid FROM pg_roles WHERE rolname = $2),
             (SELECT oid FROM pg_roles WHERE rolname = $3),
             (SELECT oid FROM pg_roles WHERE rolname = $4)
           )
      ) AS column_defaults_safe
  `, [
    options.runtimeCapabilityRole,
    options.verifyCapabilityRole,
    options.runtimeLoginRole,
    options.verifyLoginRole,
    relation,
    sequence,
    routine,
    schemaName,
    `public.${typeName}`,
  ]);
  await client.query(`DROP TYPE public.${typeName}`);
  await client.query(`DROP SCHEMA ${schemaName}`);
  await client.query(`DROP FUNCTION public.${routineName}()`);
  await client.query(`DROP TABLE public.${tableName}`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row.runtime_defaults_safe !== true
    || row.verify_defaults_safe !== true
    || row.public_defaults_safe !== true
    || row.column_defaults_safe !== true
  ) {
    throw fixedError("database_access_role_default_privilege_postcondition_failed");
  }
}

export async function provisionDatabaseAccessRoles(client, rawOptions) {
  const options = validateDatabaseAccessInputs(rawOptions);
  const quote = (value) => `"${value}"`;
  const runtimePasswordVerifier = postgresScramSha256Verifier(options.runtimePassword);
  const verifyPasswordVerifier = postgresScramSha256Verifier(options.verifyPassword);

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await client.query(`SET LOCAL ROLE ${quote(options.migrationRole)}`);
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('axel-database-access-roles-v1', 0))");
    await requireProvisioningAuthority(client, options, true);
    await requireMigrationLoginRolesSafe(client, options);
    await requirePublicAclAllowlist(client, options);

    await requireExistingLoginRolesSafe(
      client,
      options.runtimeCapabilityRole,
      options.runtimeExistingLoginRoles,
      false,
    );
    await requireExistingLoginRolesSafe(
      client,
      options.verifyCapabilityRole,
      options.verifyExistingLoginRoles,
      true,
    );

    const runtimeCapabilityExists = await requireCapabilitySafeOrMissing(
      client,
      options.runtimeCapabilityRole,
      options.migrationRole,
      options.runtimeExistingLoginRoles,
    );
    const verifyCapabilityExists = await requireCapabilitySafeOrMissing(
      client,
      options.verifyCapabilityRole,
      options.migrationRole,
      options.verifyExistingLoginRoles,
    );
    const loginCollision = await client.query(
      "SELECT count(*)::integer AS count FROM pg_roles WHERE rolname = ANY($1::text[])",
      [[options.runtimeLoginRole, options.verifyLoginRole]],
    );
    if (loginCollision.rows[0]?.count !== 0) throw fixedError("database_login_role_collision");

    await client.query(
      `SELECT set_config('axel.runtime_password_verifier', $1, true),
              set_config('axel.verify_password_verifier', $2, true)`,
      [runtimePasswordVerifier, verifyPasswordVerifier],
    );

    if (!runtimeCapabilityExists) {
      await client.query(`
        CREATE ROLE ${quote(options.runtimeCapabilityRole)}
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS
      `);
    }
    if (!verifyCapabilityExists) {
      await client.query(`
        CREATE ROLE ${quote(options.verifyCapabilityRole)}
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS
      `);
    }

    await client.query(`
      DO $axel$
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          '${options.runtimeLoginRole}', current_setting('axel.runtime_password_verifier')
        );
        EXECUTE format(
          'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          '${options.verifyLoginRole}', current_setting('axel.verify_password_verifier')
        );
      END
      $axel$;
    `);

    await client.query(`
      GRANT ${quote(options.runtimeCapabilityRole)} TO ${quote(options.runtimeLoginRole)}
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
    `);
    await client.query(`
      GRANT ${quote(options.verifyCapabilityRole)} TO ${quote(options.verifyLoginRole)}
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
    `);

    await client.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    await client.query(`
      DO $axel$
      BEGIN
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
          current_database()
        );
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO %I',
          current_database(),
          session_user
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I, %I',
          current_database(),
          '${options.runtimeCapabilityRole}',
          '${options.verifyCapabilityRole}'
        );
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO %I, %I',
          current_database(),
          '${options.runtimeCapabilityRole}',
          '${options.verifyCapabilityRole}'
        );
      END
      $axel$;
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON SCHEMA public
        FROM ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
        FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
        FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
    `);
    await client.query(`
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public
        FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
    `);
    await client.query(`
      DO $axel$
      DECLARE column_grant record;
      BEGIN
        FOR column_grant IN
          SELECT namespace.nspname AS schema_name,
                 relation.relname AS relation_name,
                 attribute.attname AS column_name,
                 acl.privilege_type,
                 grantee.rolname AS grantee_name,
                 acl.grantee = 0 AS is_public
            FROM pg_attribute attribute
            JOIN pg_class relation ON relation.oid = attribute.attrelid
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
           WHERE namespace.nspname = 'public'
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
             AND (
               acl.grantee = 0
               OR grantee.rolname IN (
                 '${options.runtimeCapabilityRole}',
                 '${options.verifyCapabilityRole}'
               )
             )
        LOOP
          IF column_grant.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN
            RAISE EXCEPTION 'unexpected column privilege';
          END IF;
          IF column_grant.is_public THEN
            EXECUTE format(
              'REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',
              column_grant.privilege_type,
              column_grant.column_name,
              column_grant.schema_name,
              column_grant.relation_name
            );
          ELSE
            EXECUTE format(
              'REVOKE %s (%I) ON TABLE %I.%I FROM %I',
              column_grant.privilege_type,
              column_grant.column_name,
              column_grant.schema_name,
              column_grant.relation_name,
              column_grant.grantee_name
            );
          END IF;
        END LOOP;
      END
      $axel$;
    `);

    for (const scope of ["", " IN SCHEMA public"]) {
      await client.query(`
        ALTER DEFAULT PRIVILEGES${scope}
          REVOKE ALL PRIVILEGES ON TABLES
          FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
      `);
      await client.query(`
        ALTER DEFAULT PRIVILEGES${scope}
          REVOKE ALL PRIVILEGES ON SEQUENCES
          FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
      `);
      await client.query(`
        ALTER DEFAULT PRIVILEGES${scope}
          REVOKE ALL PRIVILEGES ON ROUTINES
          FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
      `);
      await client.query(`
        ALTER DEFAULT PRIVILEGES${scope}
          REVOKE ALL PRIVILEGES ON TYPES
          FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
      `);
    }
    await client.query(`
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON SCHEMAS
        FROM PUBLIC, ${quote(options.runtimeCapabilityRole)}, ${quote(options.verifyCapabilityRole)}
    `);

    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(options.runtimeCapabilityRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(options.verifyCapabilityRole)}`);
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
        TO ${quote(options.runtimeCapabilityRole)}
    `);
    await client.query(`
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${quote(options.runtimeCapabilityRole)}
    `);
    await client.query(`
      DO $axel$
      BEGIN
        IF to_regclass('public.schema_migrations') IS NOT NULL THEN
          EXECUTE format(
            'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM %I, %I, PUBLIC',
            '${options.runtimeCapabilityRole}', '${options.verifyCapabilityRole}'
          );
        END IF;
      END
      $axel$;
    `);
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quote(options.runtimeCapabilityRole)}
    `);
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO ${quote(options.runtimeCapabilityRole)}
    `);
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE ON TYPES TO ${quote(options.runtimeCapabilityRole)}
    `);
    await client.query(`ALTER ROLE ${quote(options.runtimeLoginRole)} SET search_path = pg_catalog, public`);
    await client.query(`ALTER ROLE ${quote(options.verifyLoginRole)} SET search_path = pg_catalog, public`);
    await client.query(`ALTER ROLE ${quote(options.verifyLoginRole)} SET default_transaction_read_only = on`);

    await requireProvisionedState(client, options);
    await requireDefaultPrivilegeState(client, options);
    await requireProvisioningAuthority(client, options, true);
    await requireMigrationLoginRolesSafe(client, options);

    const counts = await client.query(`
      SELECT count(*) FILTER (WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f'))::integer AS tables,
             count(*) FILTER (WHERE relation.relkind = 'S')::integer AS sequences
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
    `);
    await client.query("COMMIT");
    return {
      tableCount: counts.rows[0]?.tables ?? 0,
      sequenceCount: counts.rows[0]?.sequences ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  // This CLI granted every current and future table to one shared runtime.
  // Keep the implementation importable for its disposable regression fixture,
  // but do not allow an operator to recreate that production state.
  throw fixedError("database_legacy_broad_runtime_provisioner_disabled");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("database_access_role_provisioning_failed\n");
    process.exitCode = 1;
  });
}
