WITH owner_role AS (
  SELECT role.oid, role.rolsuper, role.rolinherit, role.rolcreaterole,
         role.rolcreatedb, role.rolcanlogin, role.rolreplication,
         role.rolbypassrls
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = :'expected_owner_role'
), login_role AS (
  SELECT role.oid, role.rolsuper, role.rolinherit, role.rolcreaterole,
         role.rolcreatedb, role.rolcanlogin, role.rolreplication,
         role.rolbypassrls
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = :'expected_login_role'
), expected_login_names AS (
  SELECT pg_catalog.unnest(
    pg_catalog.string_to_array(:'expected_login_roles_csv', ',')
  ) AS rolname
), expected_login_roles AS (
  SELECT expected.rolname, role.oid, role.rolsuper, role.rolinherit,
         role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
         role.rolreplication, role.rolbypassrls
    FROM expected_login_names expected
    LEFT JOIN pg_catalog.pg_roles role ON role.rolname = expected.rolname
), expected_owner_parent_names AS (
  SELECT pg_catalog.unnest(
    CASE
      WHEN :'expected_owner_parent_roles_csv' = '' THEN ARRAY[]::text[]
      ELSE pg_catalog.string_to_array(:'expected_owner_parent_roles_csv', ',')
    END
  ) AS rolname
), expected_owner_parent_roles AS (
  SELECT expected.rolname, role.oid, role.rolsuper, role.rolinherit,
         role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
         role.rolreplication, role.rolbypassrls, role.rolconfig,
         role.rolconnlimit
    FROM expected_owner_parent_names expected
    LEFT JOIN pg_catalog.pg_roles role ON role.rolname = expected.rolname
), database_state AS (
  SELECT database.oid, database.datdba, database.datacl
    FROM pg_catalog.pg_database database
   WHERE database.datname = pg_catalog.current_database()
), public_schema AS (
  SELECT namespace.oid, namespace.nspowner, namespace.nspacl
    FROM pg_catalog.pg_namespace namespace
   WHERE namespace.nspname = 'public'
), schema_create_grants AS (
  SELECT acl.grantee
    FROM public_schema
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        public_schema.nspacl,
        pg_catalog.acldefault('n', public_schema.nspowner)
      )
    ) acl
   WHERE acl.privilege_type = 'CREATE'
), schema_grants AS (
  SELECT acl.grantee, acl.privilege_type
    FROM public_schema
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        public_schema.nspacl,
        pg_catalog.acldefault('n', public_schema.nspowner)
      )
    ) acl
), database_grants AS (
  SELECT acl.grantee, acl.privilege_type
    FROM database_state
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        database_state.datacl,
        pg_catalog.acldefault('d', database_state.datdba)
      )
    ) acl
), expected_runtime_capability_names AS (
  SELECT pg_catalog.unnest(
    pg_catalog.string_to_array(:'expected_runtime_capability_roles_csv', ',')
  ) AS rolname
), runtime_capability_roles AS (
  SELECT role.*
    FROM expected_runtime_capability_names expected
    LEFT JOIN pg_catalog.pg_roles role ON role.rolname = expected.rolname
), verify_capability_role AS (
  SELECT role.*
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = :'expected_verify_capability_role'
), canary_role AS (
  SELECT role.*
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = :'expected_canary_role'
), capability_roles AS (
  SELECT role.* FROM runtime_capability_roles role WHERE role.oid IS NOT NULL
  UNION ALL
  SELECT role.* FROM verify_capability_role role
), database_owner_role AS (
  SELECT role.oid
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = 'pg_database_owner'
), login_memberships AS (
  SELECT membership.roleid, membership.admin_option,
         membership.inherit_option, membership.set_option
    FROM pg_catalog.pg_auth_members membership
    JOIN login_role ON login_role.oid = membership.member
), owner_parent_memberships AS (
  SELECT parent.rolname, membership.admin_option,
         membership.inherit_option, membership.set_option
    FROM pg_catalog.pg_auth_members membership
    JOIN owner_role ON owner_role.oid = membership.member
    JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
), owner_child_memberships AS (
  SELECT child.rolname, membership.admin_option,
         membership.inherit_option, membership.set_option
    FROM pg_catalog.pg_auth_members membership
    JOIN owner_role ON owner_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles child ON child.oid = membership.member
), login_database_grants AS (
  SELECT acl.privilege_type
    FROM database_state
    CROSS JOIN login_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        database_state.datacl,
        pg_catalog.acldefault('d', database_state.datdba)
      )
    ) acl
   WHERE acl.grantee = login_role.oid
), public_relations AS (
  SELECT relation.oid, relation.relowner, relation.relkind, relation.relacl
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), public_routines AS (
  SELECT routine.oid, routine.proowner, routine.proacl,
         routine.prosecdef, extension.extowner AS extension_owner
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = routine.pronamespace
    LEFT JOIN pg_catalog.pg_depend dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     AND dependency.objid = routine.oid
     AND dependency.deptype = 'e'
    LEFT JOIN pg_catalog.pg_extension extension
      ON extension.oid = dependency.refobjid
   WHERE namespace.nspname = 'public'
), public_types AS (
  SELECT type.oid, type.typowner, extension.extowner AS extension_owner
    FROM pg_catalog.pg_type type
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = type.typnamespace
    LEFT JOIN pg_catalog.pg_depend dependency
      ON dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
     AND dependency.objid = type.oid
     AND dependency.deptype = 'e'
    LEFT JOIN pg_catalog.pg_extension extension
      ON extension.oid = dependency.refobjid
   WHERE namespace.nspname = 'public'
), public_relation_grants AS (
  SELECT relation.oid, relation.relkind, acl.grantee, acl.privilege_type
    FROM public_relations relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault(
          CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation.relowner
        )
      )
    ) acl
), public_routine_grants AS (
  SELECT routine.oid, routine.proowner, acl.grantee, acl.privilege_type, acl.is_grantable
    FROM public_routines routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) acl
), direct_column_grants AS (
  SELECT namespace.nspname, relation.relname, attribute.attname,
         acl.grantee, acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
   WHERE namespace.nspname !~ '^pg_'
     AND namespace.nspname <> 'information_schema'
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
), routine_default_acl AS (
  SELECT defaults.defaclacl
    FROM pg_catalog.pg_default_acl defaults
    JOIN owner_role ON owner_role.oid = defaults.defaclrole
   WHERE defaults.defaclobjtype = 'f'
     AND defaults.defaclnamespace = 0
)
SELECT (
  current_user = :'expected_owner_role'
  AND session_user = :'expected_login_role'
  AND :'expected_owner_role' <> :'expected_login_role'
  AND :'expected_verify_capability_role' ~ '^[a-z][a-z0-9_]{2,62}$'
  AND (SELECT pg_catalog.count(*) FROM expected_runtime_capability_names) > 0
  AND (SELECT pg_catalog.count(*) FROM expected_runtime_capability_names) =
    (SELECT pg_catalog.count(DISTINCT rolname) FROM expected_runtime_capability_names)
  AND (SELECT pg_catalog.count(*) FROM runtime_capability_roles WHERE oid IS NOT NULL) =
    (SELECT pg_catalog.count(*) FROM expected_runtime_capability_names)
  AND (SELECT pg_catalog.count(*) FROM verify_capability_role) = 1
  AND NOT EXISTS (
    SELECT 1 FROM expected_runtime_capability_names expected
     WHERE expected.rolname !~ '^[a-z][a-z0-9_]{2,62}$'
        OR expected.rolname = :'expected_verify_capability_role'
        OR expected.rolname IN (:'expected_owner_role', :'expected_login_role')
  )
  AND :'expected_verify_capability_role' NOT IN (
    :'expected_owner_role', :'expected_login_role'
  )
  AND pg_catalog.regexp_replace(
    pg_catalog.current_setting('search_path'),
    '[[:space:]]+',
    '',
    'g'
  ) = 'public'
  AND pg_catalog.current_schemas(true)::text[] =
    ARRAY['pg_catalog', 'public']::text[]
  AND NOT owner_role.rolsuper
  AND owner_role.rolcreaterole = (:'expected_owner_createrole' = '1')
  AND (
    (
      :'expected_transitional_owner' = '1'
      AND owner_role.rolinherit
      AND owner_role.rolcreatedb
      AND owner_role.rolcanlogin
    )
    OR (
      :'expected_transitional_owner' = '0'
      AND NOT owner_role.rolinherit
      AND NOT owner_role.rolcreatedb
      AND NOT owner_role.rolcanlogin
    )
  )
  AND NOT owner_role.rolreplication
  AND NOT owner_role.rolbypassrls
  AND NOT login_role.rolsuper AND NOT login_role.rolinherit
  AND NOT login_role.rolcreaterole AND NOT login_role.rolcreatedb
  AND login_role.rolcanlogin AND NOT login_role.rolreplication
  AND NOT login_role.rolbypassrls
  AND (SELECT pg_catalog.count(*) FROM login_memberships) = 1
  AND EXISTS (
    SELECT 1
      FROM login_memberships
     WHERE roleid = owner_role.oid
       AND NOT admin_option
       AND NOT inherit_option
       AND set_option
  )
  AND (SELECT pg_catalog.count(*) FROM login_database_grants) = 1
  AND EXISTS (
    SELECT 1 FROM login_database_grants
     WHERE privilege_type = 'CONNECT'
  )
  AND NOT EXISTS (
    SELECT 1 FROM owner_parent_memberships
     WHERE rolname NOT IN (
       SELECT expected.rolname FROM expected_owner_parent_names expected
     )
        OR NOT admin_option
        OR inherit_option
        OR set_option
  )
  AND NOT EXISTS (
    SELECT 1 FROM expected_owner_parent_roles expected
     WHERE expected.oid IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM owner_parent_memberships membership
           WHERE membership.rolname = expected.rolname
             AND membership.admin_option
             AND NOT membership.inherit_option
             AND NOT membership.set_option
        )
        OR (
          expected.oid IN (SELECT capability.oid FROM capability_roles capability)
          AND (
            expected.rolsuper
            OR expected.rolinherit
            OR expected.rolcreaterole
            OR expected.rolcreatedb
            OR expected.rolcanlogin
            OR expected.rolreplication
            OR expected.rolbypassrls
            OR COALESCE(expected.rolconfig, '{}'::text[]) <> '{}'::text[]
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = expected.oid
            )
          )
        )
        OR (
          expected.oid NOT IN (SELECT capability.oid FROM capability_roles capability)
          AND expected.rolname <> :'expected_canary_role'
          AND (
            expected.rolsuper
            OR NOT expected.rolinherit
            OR expected.rolcreaterole
            OR expected.rolcreatedb
            OR NOT expected.rolcanlogin
            OR expected.rolreplication
            OR expected.rolbypassrls
            OR NOT COALESCE(expected.rolconfig, '{}'::text[])
              @> ARRAY['search_path=pg_catalog, public']
            OR NOT COALESCE(expected.rolconfig, '{}'::text[])
              <@ ARRAY[
                'search_path=pg_catalog, public',
                'default_transaction_read_only=on'
              ]
            OR (
              SELECT pg_catalog.count(*)
                FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = expected.oid
            ) <> 1
            OR NOT EXISTS (
              SELECT 1
                FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = expected.oid
                 AND membership.roleid IN (
                   SELECT capability.oid FROM capability_roles capability
                 )
                 AND NOT membership.admin_option
                 AND membership.inherit_option
                 AND NOT membership.set_option
            )
          )
        )
        OR (
          :'expected_canary_role' <> ''
          AND expected.rolname = :'expected_canary_role'
          AND (
            expected.rolsuper
            OR expected.rolinherit
            OR expected.rolcreaterole
            OR expected.rolcreatedb
            OR NOT expected.rolcanlogin
            OR expected.rolreplication
            OR expected.rolbypassrls
            OR expected.rolconnlimit <> 4
            OR pg_catalog.cardinality(
              COALESCE(expected.rolconfig, '{}'::text[])
            ) <> 3
            OR NOT COALESCE(expected.rolconfig, '{}'::text[]) @> ARRAY[
              'search_path=pg_catalog, public',
              'statement_timeout=10s',
              'idle_in_transaction_session_timeout=15s'
            ]
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = expected.oid
            )
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members membership
               WHERE membership.roleid = expected.oid
                 AND NOT (
                   membership.member = owner_role.oid
                   AND membership.admin_option
                   AND NOT membership.inherit_option
                   AND NOT membership.set_option
                 )
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_database WHERE datdba = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_class WHERE relowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_type WHERE typowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = expected.oid
        )
        OR (
          expected.oid NOT IN (SELECT capability.oid FROM capability_roles capability)
          AND expected.rolname <> :'expected_canary_role'
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_shdepend dependency
             WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
               AND dependency.refobjid = expected.oid
               AND dependency.deptype IN ('a', 'o')
          )
        )
  )
  AND NOT EXISTS (
    SELECT 1 FROM capability_roles capability
     WHERE capability.rolsuper
        OR capability.rolinherit
        OR capability.rolcreaterole
        OR capability.rolcreatedb
        OR capability.rolcanlogin
        OR capability.rolreplication
        OR capability.rolbypassrls
        OR COALESCE(capability.rolconfig, '{}'::text[]) <> '{}'::text[]
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members membership
           WHERE membership.member = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_database WHERE datdba = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_class WHERE relowner = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_type WHERE typowner = capability.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = capability.oid
        )
  )
  AND NOT EXISTS (
    SELECT 1 FROM owner_child_memberships membership
     WHERE membership.rolname NOT IN (
       SELECT expected.rolname FROM expected_login_names expected
     )
        OR membership.admin_option
        OR membership.inherit_option
        OR NOT membership.set_option
  )
  AND NOT EXISTS (
    SELECT 1 FROM expected_login_roles expected
     WHERE expected.oid IS NULL
        OR expected.rolsuper
        OR expected.rolinherit
        OR expected.rolcreaterole
        OR expected.rolcreatedb
        OR NOT expected.rolcanlogin
        OR expected.rolreplication
        OR expected.rolbypassrls
        OR (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_auth_members membership
           WHERE membership.member = expected.oid
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_auth_members membership
           WHERE membership.member = expected.oid
             AND membership.roleid = owner_role.oid
             AND NOT membership.admin_option
             AND NOT membership.inherit_option
             AND membership.set_option
        )
        OR (
          SELECT pg_catalog.count(*)
            FROM database_state
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                database_state.datacl,
                pg_catalog.acldefault('d', database_state.datdba)
              )
            ) acl
           WHERE acl.grantee = expected.oid
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
            FROM database_state
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                database_state.datacl,
                pg_catalog.acldefault('d', database_state.datdba)
              )
            ) acl
           WHERE acl.grantee = expected.oid
             AND acl.privilege_type = 'CONNECT'
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_database WHERE datdba = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_class WHERE relowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = expected.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_type WHERE typowner = expected.oid
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_shdepend dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
             AND dependency.refobjid = expected.oid
             AND (
               dependency.deptype = 'o'
               OR (
                 dependency.deptype = 'a'
                 AND NOT (
                   dependency.dbid = 0
                   AND dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
                   AND dependency.objid = database_state.oid
                 )
               )
             )
        )
  )
  AND database_state.datdba = owner_role.oid
  AND public_schema.nspowner = owner_role.oid
  AND pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
  AND pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
  AND NOT EXISTS (
    SELECT 1
      FROM schema_create_grants
     WHERE grantee <> owner_role.oid
       AND grantee <> COALESCE((SELECT oid FROM database_owner_role), 0)
  )
  AND NOT EXISTS (
    SELECT 1 FROM schema_grants grant_state
     WHERE NOT (
       grant_state.grantee = owner_role.oid
       OR grant_state.grantee = COALESCE((SELECT oid FROM database_owner_role), 0)
       OR (
         grant_state.grantee IN (SELECT oid FROM capability_roles)
         AND grant_state.privilege_type = 'USAGE'
       )
       OR (
         grant_state.grantee IN (SELECT oid FROM canary_role)
         AND grant_state.privilege_type = 'USAGE'
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1 FROM database_grants grant_state
     WHERE NOT (
       grant_state.grantee = owner_role.oid
       OR (
         grant_state.grantee IN (SELECT oid FROM expected_login_roles)
         AND grant_state.privilege_type = 'CONNECT'
       )
       OR (
         grant_state.grantee IN (SELECT oid FROM capability_roles)
         AND grant_state.privilege_type = 'CONNECT'
       )
       OR (
         grant_state.grantee IN (SELECT oid FROM canary_role)
         AND grant_state.privilege_type = 'CONNECT'
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_relations relation
     WHERE relation.relowner <> owner_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_routines routine
     WHERE (
             routine.proowner <> owner_role.oid
             AND routine.extension_owner IS DISTINCT FROM owner_role.oid
           )
        OR routine.prosecdef
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_types type
     WHERE type.typowner <> owner_role.oid
       AND type.extension_owner IS DISTINCT FROM owner_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_relation_grants grant_state
     WHERE NOT (
       grant_state.grantee = owner_role.oid
       OR (
         grant_state.grantee IN (
           SELECT oid FROM runtime_capability_roles WHERE oid IS NOT NULL
         )
         AND (
           (
             grant_state.relkind = 'S'
             AND grant_state.privilege_type = 'USAGE'
           )
           OR (
             grant_state.relkind <> 'S'
             AND grant_state.oid <> pg_catalog.to_regclass('public.schema_migrations')
             AND grant_state.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
           )
         )
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_routine_grants grant_state
     WHERE (grant_state.grantee = 0
        OR (
          grant_state.grantee <> owner_role.oid
          AND grant_state.grantee <> grant_state.proowner
        ))
       AND NOT (
         grant_state.grantee IN (SELECT oid FROM runtime_capability_roles WHERE oid IS NOT NULL)
         AND grant_state.privilege_type = 'EXECUTE' AND NOT grant_state.is_grantable
         AND COALESCE(grant_state.oid = ANY(ARRAY[
           pg_catalog.to_regprocedure('public.axel_scrub_data_contract_schema_node(jsonb)'),
           pg_catalog.to_regprocedure('public.axel_scrub_data_contract_schema(jsonb)'),
           pg_catalog.to_regprocedure('public.axel_strip_data_contract_previews(jsonb)'),
           pg_catalog.to_regprocedure('public.axel_generalize_data_contract_fixture(jsonb)'),
           pg_catalog.to_regprocedure('public.axel_data_contract_json_allowlist(jsonb,text[])')
         ]::oid[]), false)
       )
  )
  AND (
    (
      :'expected_canary_role' = ''
      AND NOT EXISTS (SELECT 1 FROM direct_column_grants)
    )
    OR (
      :'expected_canary_role' <> ''
      AND (SELECT pg_catalog.count(*) FROM direct_column_grants) = 1
      AND EXISTS (
        SELECT 1 FROM direct_column_grants grant_state
         WHERE grant_state.nspname = 'public'
           AND grant_state.relname = 'delivery_canary_receipts'
           AND grant_state.attname = 'payload'
           AND grant_state.grantee IN (SELECT oid FROM canary_role)
           AND grant_state.privilege_type = 'INSERT'
           AND NOT grant_state.is_grantable
      )
    )
  )
  AND (
    (
      NOT EXISTS (SELECT 1 FROM public_relations)
      AND NOT EXISTS (SELECT 1 FROM public_routines)
    )
    OR (
      (SELECT pg_catalog.count(*) FROM routine_default_acl) = 1
      AND NOT EXISTS (
        SELECT 1
          FROM routine_default_acl defaults
          CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
         WHERE acl.grantee = 0
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
     WHERE datdba = login_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
     WHERE nspowner = login_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
     WHERE relowner = login_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
     WHERE proowner = login_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type
     WHERE typowner = login_role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend dependency
     WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
       AND dependency.refobjid = login_role.oid
       AND (
         dependency.deptype = 'o'
         OR (
           dependency.deptype = 'a'
           AND NOT (
             dependency.dbid = 0
             AND dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
             AND dependency.objid = database_state.oid
           )
         )
       )
  )
)::integer
FROM owner_role
CROSS JOIN login_role
CROSS JOIN database_state
CROSS JOIN public_schema;
