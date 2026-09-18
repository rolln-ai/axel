# Hosted PostgreSQL service roles

## Render deployments

Use `DATABASE_ACCESS_MODE=render` for the managed Render database. The provider's
owner login stays in the protected migration environment. Each application uses
its own restricted login. The owner does not enter an application deployment.
This model works with Render's ordinary PostgreSQL 17 owner permissions and does
not require a support ticket or a provider superuser.

Use `sslmode=verify-full` on hosted URLs. For verified connections, the migration
wrapper supplies Node's trusted CA certificates to `psql` when no libpq root
certificate is configured. Explicit `sslrootcert`, `PGSSLROOTCERT`, and the
standard `~/.postgresql/root.crt` take precedence. The temporary public CA bundle
is removed when the wrapper exits; certificate and hostname checks remain enabled.
With Render and `verify-full`, the wrapper also disables libpq's default SCRAM
channel binding, which the provider's TLS endpoint rejects. Explicit
`channel_binding` or `PGCHANNELBINDING` settings still take precedence. This does
not disable TLS, certificate validation, or hostname verification.

The checked-in `infra/postgres/hosted-access.json` names the five runtime
capabilities, their replaceable logins, and the metadata verifier. Set
`DATABASE_MIGRATION_ROLE` to the actual provider owner and
`DATABASE_SERVICE_REQUIRE_FINAL_STATE=1`. The per-service grants still come from
`scripts/database-service-access-profiles.mjs`. Verifiers check exact grants,
membership, ownership, default privileges, and login identity. Runtime roles
cannot migrate, create objects, grant privileges, or read the migration ledger.
Existing owner-owned demo or retired-feature tables may remain in the managed
database. Every service must have zero privileges on relations outside its
profile; the verifier checks those relations too. The transition preserves their
data and does not grant application roles access to them.

The managed mode permits connections and temporary objects in Render's
`postgres` maintenance database. Verification also connects there and rejects
writable persistent schemas. This is a provider administration database, not a
place for application data. Other databases remain inaccessible. Provider
superusers remain trusted administrators. The application database itself denies
runtime schema creation and temporary objects.

Initial transition, using credentials supplied through a secret manager or the
protected release environment:

1. Keep the current owner credential as `DATABASE_MIGRATION_URL`. Generate and
   retain independent passwords for the metadata verifier and five service logins.
   Never place credentials in command arguments, source control, or CI artifacts.
2. Run `node scripts/render-database-access.mjs prepare` with
   `DATABASE_VERIFY_PASSWORD` and
   `AXEL_HOSTED_DATABASE_BOOTSTRAP_CONFIRM=I_UNDERSTAND_THIS_CHANGES_DATABASE_ROLES`.
   This creates the metadata roles and removes the unused `vector` and `pg_trgm`
   extensions from the retired EDKG feature. `DROP EXTENSION ... RESTRICT` rolls
   the transaction back if any application object still depends on either one.
   This step is for initial setup; existing role names are a hard collision.
3. Run `node scripts/provision-database-service-roles.mjs` with the five
   `DATABASE_<SERVICE>_PASSWORD` values. It creates and grants the profiles in one
   transaction and verifies them before committing. Service stems are `DASHBOARD`,
   `DELIVERY_NATIVE`, `DELIVERY_WORKERS`, `PULL_WORKER`, and `DELIVERY_EDGE`.
4. Store each URL in its matching protected service secret. Render services also
   need an external preflight URL with the same login as the internal runtime URL.
   Store `DATABASE_VERIFY_URL` and set `DATABASE_VERIFY_LOGIN_ROLE` to the first
   verifier login in the registry.
5. Run the migration workflow before credential sync. Then use the existing
   credential-sync workflows, one service at a time. Render sync immediately
   deploys the reviewed commit with the saved credential. Deploy Vercel and
   Cloudflare through their release workflows after sync. Check exact deployment
   URLs, production domains, and the delivery canary. Keep old credentials valid
   until the rollout succeeds.
6. Verify that every runtime uses its service login and old owner sessions have
   drained. Rotate the owner password and update only the protected migration
   secret. Retire old application deployments and credentials through the normal
   provider controls. Restart the release observation window after mutations.

For runtime rotation, change the registry's `loginRole`, retain the old name in
`existingLoginRoles`, and provision with new passwords. Remove old login entries
only after all consumers have moved and the old sessions have drained.

The dashboard needs five pure JSON helper functions called by its data-contract
privacy triggers. Both hosted and self-hosted provisioning grant those exact
signatures to the dashboard capability. Other application functions stay denied;
the grants do not give the dashboard any additional table access.

Run `pnpm test:database` to verify the strict and Render paths against disposable
Postgres 17. The Render case performs no superuser operations after creating the
initial provider owner. It checks a real contract write, privacy scrubbing,
forbidden SQL operations, unexpected grants, and incremental migrations followed
by a no-op migration run. CI runs this command explicitly.

The strict role model below remains available for installations where an
administrator can manage cluster-wide roles and privileges. It is not a
prerequisite for the Render path above.

## Strict role model

The strict model also gives each runtime a separate credential. The
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
relations listed in the profile module. The dashboard also receives the five
JSON helper grants described above. Profiles receive no other routine execution,
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

Adding a grant on an existing table to a profile needs three pieces: the
profile entry, a capability-grant SQL file that `run-migrations.sh` applies
after the migrations (see `scripts/sync-dead-letter-triage-access.sql`), and a
marker migration. The Render owner preflight tolerates the missing grant only
while the marker is absent from the ledger; runtime verification stays strict.

`delivery-workers` intentionally excludes the native delivery database path.
Keep `PARQUET_DELIVERY_QUEUE_ID` absent. Enabling that loop requires a separate
profile review and code change. The Render blueprint omits the key so a fresh
deployment cannot enable the broader path by accident.

### Strict-model provisioning

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

Using this strict model on Render requires provider assistance. Render
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

### Strict-model production configuration

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

The credential-sync workflow authenticates the external preflight URL, then writes
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

### Strict-model rotation order

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
   credential or deployment mutation restarts the release observation window.

Do not retire the old credential until all five target-specific smoke checks
pass. Do not start the 72-hour clock until the final-state preflights pass.
