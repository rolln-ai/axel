WITH input_values AS (
  SELECT :'expected_role'::text AS expected_role,
         :'capability_role'::text AS capability_role,
         :'owner_role'::text AS owner_role,
         :'existing_login_roles'::text AS existing_login_roles,
         :'runtime_capability_role'::text AS runtime_capability_role,
         :'migration_login_roles'::text AS migration_login_roles
), database_state AS (
  SELECT oid, datdba, datacl
    FROM pg_database
   WHERE datname = current_database()
), me AS (
  SELECT oid, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
         rolcanlogin, rolreplication, rolbypassrls, rolconfig
    FROM pg_roles
   WHERE rolname = current_user
), capability AS (
  SELECT role.*
    FROM pg_roles role
    CROSS JOIN input_values input
   WHERE role.rolname = input.capability_role
), runtime_capability AS (
  SELECT role.*
    FROM pg_roles role
    CROSS JOIN input_values input
   WHERE role.rolname = input.runtime_capability_role
), stable_owner AS (
  SELECT role.*
    FROM pg_roles role
    JOIN database_state database ON database.datdba = role.oid
    CROSS JOIN input_values input
   WHERE role.rolname = input.owner_role
), expected_login_names AS (
  SELECT input.expected_role AS name
    FROM input_values input
  UNION ALL
  SELECT btrim(candidate.name)
    FROM input_values input
    CROSS JOIN LATERAL regexp_split_to_table(input.existing_login_roles, ',') candidate(name)
   WHERE btrim(candidate.name) <> ''
), expected_logins AS (
  SELECT expected.name, role.*
    FROM expected_login_names expected
    LEFT JOIN pg_roles role ON role.rolname = expected.name
), expected_migration_login_names AS (
  SELECT btrim(candidate.name) AS name
    FROM input_values input
    CROSS JOIN LATERAL regexp_split_to_table(input.migration_login_roles, ',') candidate(name)
   WHERE btrim(candidate.name) <> ''
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
  SELECT relation.oid
    FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
), non_system_sequences AS (
  SELECT relation.oid
    FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind = 'S'
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
SELECT (
  current_user = input.expected_role
  AND session_user = input.expected_role
  AND regexp_replace(current_setting('search_path'), '[[:space:]]+', '', 'g') =
    'pg_catalog,public'
  AND current_setting('default_transaction_read_only') = 'on'
  AND input.expected_role ~ '^[a-z][a-z0-9_]{2,62}$'
  AND input.capability_role ~ '^[a-z][a-z0-9_]{2,62}$'
  AND input.owner_role ~ '^[a-z][a-z0-9_]{2,62}$'
  AND input.runtime_capability_role ~ '^[a-z][a-z0-9_]{2,62}$'
  AND input.capability_role <> input.owner_role
  AND input.runtime_capability_role NOT IN (input.capability_role, input.owner_role)
  AND input.capability_role NOT IN (SELECT name FROM expected_login_names)
  AND input.runtime_capability_role NOT IN (SELECT name FROM expected_login_names)
  AND input.owner_role NOT IN (SELECT name FROM expected_login_names)
  AND NOT EXISTS (
    SELECT 1 FROM expected_login_names expected
     WHERE expected.name !~ '^[a-z][a-z0-9_]{2,62}$'
  )
  AND (SELECT count(*) FROM expected_login_names) =
    (SELECT count(DISTINCT name) FROM expected_login_names)
  AND (SELECT count(*) FROM expected_migration_login_names) > 0
  AND (SELECT count(*) FROM expected_migration_login_names) =
    (SELECT count(DISTINCT name) FROM expected_migration_login_names)
  AND NOT EXISTS (
    SELECT 1 FROM expected_migration_login_names expected
     WHERE expected.name !~ '^[a-z][a-z0-9_]{2,62}$'
        OR expected.name IN (
          input.capability_role,
          input.runtime_capability_role,
          input.owner_role
        )
        OR expected.name IN (SELECT name FROM expected_login_names)
  )
  AND NOT me.rolsuper AND me.rolinherit AND NOT me.rolcreaterole
  AND NOT me.rolcreatedb AND me.rolcanlogin AND NOT me.rolreplication
  AND NOT me.rolbypassrls
  AND NOT capability.rolsuper AND NOT capability.rolinherit
  AND NOT capability.rolcreaterole AND NOT capability.rolcreatedb
  AND NOT capability.rolcanlogin AND NOT capability.rolreplication
  AND NOT capability.rolbypassrls
  AND NOT runtime_capability.rolsuper AND NOT runtime_capability.rolinherit
  AND NOT runtime_capability.rolcreaterole AND NOT runtime_capability.rolcreatedb
  AND NOT runtime_capability.rolcanlogin AND NOT runtime_capability.rolreplication
  AND NOT runtime_capability.rolbypassrls
  AND NOT stable_owner.rolsuper AND NOT stable_owner.rolinherit
  AND stable_owner.rolcreaterole AND NOT stable_owner.rolcreatedb
  AND NOT stable_owner.rolcanlogin AND NOT stable_owner.rolreplication
  AND NOT stable_owner.rolbypassrls
  AND EXISTS (
    SELECT 1 FROM pg_namespace namespace
     WHERE namespace.nspname = 'public'
       AND namespace.nspowner = stable_owner.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE membership.member = capability.oid
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_auth_members membership
     WHERE membership.roleid = capability.oid
       AND NOT (
         (
           membership.member = stable_owner.oid
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
  AND EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE membership.roleid = capability.oid
       AND membership.member = stable_owner.oid
       AND membership.admin_option
       AND NOT membership.inherit_option
       AND NOT membership.set_option
  )
  AND NOT EXISTS (
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
        OR NOT COALESCE(login.rolconfig, '{}') @> ARRAY['default_transaction_read_only=on']
        OR (SELECT count(*) FROM pg_auth_members WHERE member = login.oid) <> 1
        OR NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
           WHERE membership.roleid = capability.oid
             AND membership.member = login.oid
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
          SELECT 1 FROM pg_shdepend dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
             AND dependency.refobjid = login.oid
             AND dependency.deptype = 'o'
        )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM expected_migration_logins login
     WHERE login.oid IS NULL
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
           WHERE membership.roleid = stable_owner.oid
             AND membership.member = login.oid
             AND NOT membership.admin_option
             AND NOT membership.inherit_option
             AND membership.set_option
        )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM checked_roles role
     WHERE NOT has_database_privilege(role.oid, current_database(), 'CONNECT')
        OR has_database_privilege(role.oid, current_database(), 'TEMP')
        OR has_database_privilege(role.oid, current_database(), 'CREATE')
  )
  AND NOT EXISTS (
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
  )
  AND NOT EXISTS (
    SELECT 1
      FROM non_system_relations relation
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
  AND NOT EXISTS (SELECT 1 FROM direct_column_grants)
  AND NOT EXISTS (SELECT 1 FROM database_acl_grants WHERE grantee = 0)
  AND NOT EXISTS (SELECT 1 FROM schema_acl_grants WHERE grantee = 0)
  AND NOT EXISTS (SELECT 1 FROM class_acl_grants WHERE grantee = 0)
  AND NOT EXISTS (SELECT 1 FROM routine_acl_grants WHERE grantee = 0)
  AND NOT EXISTS (
    SELECT 1
      FROM database_acl_grants grant_row
     WHERE NOT (
       grant_row.grantee = stable_owner.oid
       OR (
         grant_row.grantee IN (capability.oid, runtime_capability.oid)
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
     WHERE NOT (
       grant_row.grantee = stable_owner.oid
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
         AND grant_row.grantee IN (capability.oid, runtime_capability.oid)
         AND grant_row.privilege_type = 'USAGE'
         AND NOT grant_row.is_grantable
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM class_acl_grants grant_row
     WHERE NOT (
       grant_row.grantee = stable_owner.oid
       OR (
         grant_row.grantee = runtime_capability.oid
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
     WHERE grant_row.grantee <> stable_owner.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM non_system_schemas namespace
     WHERE namespace.nspowner <> stable_owner.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN non_system_schemas namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relowner <> stable_owner.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM non_system_routines routine
     WHERE routine.proowner <> stable_owner.oid
  )
  -- Global routine/type rows remove PostgreSQL's hard-wired PUBLIC defaults;
  -- public table/sequence/type rows add only the reviewed runtime capability.
  AND (SELECT count(*) FROM owner_default_acl_rows) = 5
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
     WHERE NOT (
       grant_row.grantee = stable_owner.oid
       OR (
         grant_row.grantee = runtime_capability.oid
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
       AND grantee = runtime_capability.oid
  ) = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
  AND (
    SELECT array_agg(privilege_type ORDER BY privilege_type)
      FROM owner_default_acl_grants
     WHERE defaclobjtype = 'S'
       AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
       AND grantee = runtime_capability.oid
  ) = ARRAY['USAGE']::text[]
  AND (
    SELECT array_agg(privilege_type ORDER BY privilege_type)
      FROM owner_default_acl_grants
     WHERE defaclobjtype = 'T'
       AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
       AND grantee = runtime_capability.oid
  ) = ARRAY['USAGE']::text[]
  AND NOT EXISTS (
    SELECT 1
      FROM non_system_sequences sequence
      CROSS JOIN checked_roles role
     WHERE has_sequence_privilege(role.oid, sequence.oid, 'SELECT')
        OR has_sequence_privilege(role.oid, sequence.oid, 'USAGE')
        OR has_sequence_privilege(role.oid, sequence.oid, 'UPDATE')
  )
  AND NOT EXISTS (
    SELECT 1
      FROM non_system_routines routine
      CROSS JOIN checked_roles role
     WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
  )
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM checked_roles))
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
)::integer
FROM input_values input
CROSS JOIN me
CROSS JOIN capability
CROSS JOIN runtime_capability
CROSS JOIN stable_owner;
