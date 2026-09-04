# Hosted PostgreSQL service roles

Hosted production does not share one database credential across runtimes. The
checked-in profiles in `scripts/database-service-access-profiles.mjs` are the
source of truth for table and sequence access.

The five profiles are:

- `dashboard` for the Vercel dashboard
- `delivery-native` for the Render delivery web service
- `delivery-workers` for the Render background worker
- `pull-worker` for the Render pull worker
- `delivery-edge` for the Cloudflare delivery worker

The ingest worker has no PostgreSQL credential. It sends erasure-index writes
through the authenticated delivery-service endpoint.

Every profile has a `NOLOGIN`, `NOINHERIT` capability role and a replaceable
`LOGIN`, `INHERIT` credential. A login inherits exactly one capability.
Capability roles receive `CONNECT`, `USAGE` on `public`, and the explicit
relations listed in the profile module. They receive no routine execution,
column ACL, default ACL, `schema_migrations` access, ownership, database create,
temporary-table access, or future-table grant.
They must also have no `CONNECT`, `CREATE`, or `TEMPORARY` privilege on any
other connectable, non-template database in the same cluster. Revoke the
PostgreSQL default `PUBLIC` database privileges with cluster-admin authority
before provisioning; the database owner cannot safely repair unrelated
database ACLs and the verifier fails closed instead.

Migration 0074 installs the `billing_events` payload guard before it scrubs old
rows. Keep that trigger in both the migration and schema snapshot. It changes
any explicit payload from an older dashboard process to an empty object, so the
migration can run before the application rollout without retaining a Stripe
body. The trigger function is `SECURITY INVOKER`, and `PUBLIC` cannot execute
it. Application roles do not need a routine grant for the trigger to fire.

Trusted extensions can contain routines and types owned by the provider's
bootstrap superuser even when the stable Axel owner owns the extension. The
verifiers accept that ownership only when PostgreSQL records the object as an
extension member and the extension itself is owned by the stable owner. This is
not an ACL exception: `PUBLIC` routine execution must still be revoked with
provider-admin authority, and any security-definer routine fails the preflight.

`delivery-workers` intentionally excludes the native delivery database path.
Keep `PARQUET_DELIVERY_QUEUE_ID` absent. Enabling that loop requires a separate
profile review and code change. The Render blueprint omits the key so a fresh
deployment cannot enable the broader path by accident.

## Provisioning

Run `scripts/hosted-database-bootstrap.mjs` before the service-role provisioner.
Its default and `--prepare`/`--finalize` invocations are read-only unless
`--apply` is also supplied. Apply mode additionally requires a dedicated
provider-admin URL and the exact
`AXEL_HOSTED_DATABASE_BOOTSTRAP_CONFIRM=I_UNDERSTAND_THIS_CHANGES_DATABASE_ROLES`
confirmation. The script prints only fixed blocker codes and aggregate counts.
It never prints a DSN, password, discovered object name, or catalog row.

The initial hosted transition keeps the existing database owner role as the
stable owner; no bulk ownership transfer is performed. During the bounded
overlap, set `DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE` to that exact owner role.
The verifier then accepts only the audited managed-provider shape: `LOGIN`,
`INHERIT`, `CREATEDB`, and `CREATEROLE`, with no superuser, replication, bypass
RLS, or role settings. Clear the variable before finalization. Finalization
requires zero sessions and converts the same role to `NOLOGIN`, `NOINHERIT`,
`NOCREATEDB`, and `CREATEROLE` inside a transaction that verifies every service
profile before and after the change.

PostgreSQL 17 automatically gives a non-superuser `CREATEROLE` role an
administrator edge on every role it creates. Role memberships cannot be
circular, so the stable owner cannot safely create a migration login and then
receive the required reverse SET-only membership from that login. A provider
bootstrap superuser, or an equivalent offline provider-admin role, must create
the migration login and grant the stable owner to it. The checked-in prepare
mode enforces that authority and hard-stops for an ordinary owner connection.

Hosted production is Render managed PostgreSQL. Render
[does not give customers PostgreSQL superuser access](https://render.com/docs/postgresql-pg-repack);
a Render workspace administrator or API token is not the database authority
required here. Open a Render support request for a bootstrap-superuser session
that can perform these exact operations:

- revoke `PUBLIC` execution from the provider-owned extension routines in the
  application database;
- revoke `PUBLIC` `CONNECT`, `CREATE`, and `TEMPORARY` from every other
  connectable, non-template database in the cluster;
- create the migration and verifier roles and their fixed PostgreSQL 17
  membership edges through the checked-in `--prepare --apply` path; and
- after every old-owner session drains, normalize the existing owner to
  `NOLOGIN`, `NOINHERIT`, `NOCREATEDB`, `CREATEROLE`, and a null password
  verifier through the checked-in `--finalize --apply` path.

The first two operations are intentionally not attempted by the ordinary owner
or service-role provisioner. If Render cannot authorize both cluster-wide ACL
changes, stop the transition; a direct revoke cannot override a `PUBLIC` grant.
Render's [managed-credential Dashboard/API](https://render.com/docs/postgresql-credentials)
can add, make default, and deactivate credentials, but it does not manage roles
created with SQL and is not a substitute for these superuser-only operations.

Run `scripts/provision-database-service-roles.mjs` only from a trusted process.
It requires PostgreSQL 17 and the protected migration connection. Supply the
five capability names, five new login names, reviewed old-login lists, and five
distinct candidate passwords through environment variables. The provisioner
creates SCRAM verifiers locally and never sends plaintext passwords in SQL or
prints them.

The provisioner validates the exact schema, role attributes, memberships,
ownership, raw ACLs, effective privileges, default ACLs, and owner-parent
memberships in one transaction. An unreviewed table, sequence, grant, role
parent, role child, or owner aborts the transaction.

The old `scripts/provision-database-access-roles.mjs` command is disabled. It
used one capability with grants on every current and future table, which is not
an acceptable hosted production state.

## Protected production configuration

Create one secret per profile:

- `DATABASE_DASHBOARD_URL`
- `DATABASE_DELIVERY_NATIVE_URL`
- `DATABASE_DELIVERY_WORKERS_URL`
- `DATABASE_PULL_WORKER_URL`
- `DATABASE_DELIVERY_EDGE_URL`

The three Render runtime URLs use the provider-internal database endpoint. A
GitHub runner cannot reach that private endpoint, so create separate external
preflight secrets for the same three login roles:

- `DATABASE_DELIVERY_NATIVE_PREFLIGHT_URL`
- `DATABASE_DELIVERY_WORKERS_PREFLIGHT_URL`
- `DATABASE_PULL_WORKER_PREFLIGHT_URL`

The bounded sync workflow authenticates the external preflight URL, then writes
only the internal runtime URL to Render. Vercel, Cloudflare, migration, and
metadata verification use external endpoints.

For each uppercase profile stem, create protected variables named
`DATABASE_<PROFILE>_CAPABILITY_ROLE`, `DATABASE_<PROFILE>_LOGIN_ROLE`, and
`DATABASE_<PROFILE>_EXISTING_LOGIN_ROLES`. Also define the current and old
migration and verifier login variables, `DATABASE_MIGRATION_OWNER_PARENT_ROLES`,
`DATABASE_RUNTIME_CAPABILITY_ROLES` as the exact comma-separated capability
inventory used by migration preflights,
`DATABASE_LEGACY_RUNTIME_CAPABILITY_ROLE`, and
`DATABASE_LEGACY_RUNTIME_LOGIN_ROLES`. Hosted production also sets
`DATABASE_CANARY_WRITER_ROLE=axel_delivery_canary_writer`. During only the
initial owner conversion, set `DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE` to the
stable owner role. Include the exact canary creator edge in
`DATABASE_MIGRATION_OWNER_PARENT_ROLES`.

Set `DATABASE_SERVICE_REQUIRE_FINAL_STATE=0` only during the bounded overlap
while services still use the old shared runtime. The candidate verifier then
requires either an exact safe legacy capability with reviewed legacy logins or
the one exact owner named by `DATABASE_TRANSITIONAL_OWNER_LOGIN_ROLE`. It does
not permit any other transitional role or owner attribute shape.

After every target uses its profile credential, retire the old login and
capability, clear both legacy-login allowlists, and set
`DATABASE_SERVICE_REQUIRE_FINAL_STATE=1`. Re-run every candidate preflight. In
final mode, the verifier rejects the legacy capability or login even when it
has no remaining grant.

## Rotation order

1. Freeze deploy and secret-sync reruns. Record the exact reviewed commit.
2. Provision all five new logins while the old credentials remain valid.
3. Save the five candidate URLs as separate protected secrets. Never place a
   URL in argv, logs, shell history, a temporary file, or the repository.
4. Dispatch `Sync Production Database Credential` once per target. The workflow
   exposes only that target's secret to its preflight and provider-save steps.
5. Deploy and smoke Vercel, each Render service, and delivery-edge separately.
   Confirm the end-to-end delivery canary after every mutation.
6. Confirm that the ingest worker has no `DATABASE_URL` binding and that the
   Render worker has no `PARQUET_DELIVERY_QUEUE_ID` environment key.
7. Wait for old-login sessions to reach zero. Retire each old login separately
   and prove that its DSN rejects a new connection.
8. Revoke and retire the broad legacy capability. Switch the protected final
   state flag to `1`, run all five preflights again, and run a no-op migration.
9. Clear reviewed-old-login variables immediately after retirement. Any
   credential or deployment mutation restarts the soak clock.

Do not retire the old credential until all five target-specific smoke checks
pass. Do not start the 72-hour clock until the final-state preflights pass.
