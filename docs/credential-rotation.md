# Credential rotation

## Credential master key

`CREDENTIALS_MASTER_KEY` is shared by dashboard, delivery-edge, and
delivery-service. It decrypts destination credentials, so rotate carefully.

Current storage uses AES-256-GCM under one master key. Until envelope
encryption is introduced, rotation is a maintenance operation.

## Planned master-key rotation

1. Freeze destination credential writes.
2. Add support for `CREDENTIALS_MASTER_KEY_PREVIOUS` and dual-read/new-write
   behavior.
3. Deploy dashboard, delivery-edge, and delivery-service.
4. Re-encrypt all credential rows with the new key.
5. Verify delivery to each credential-backed destination type.
6. Remove the previous key from every runtime.

## Emergency rotation

If you suspect the key was compromised:

1. Disable credential-backed deliveries if exposure risk is active.
2. Rotate the master key.
3. Force customers to rotate destination credentials.
4. Audit `destination_credentials` and credential read logs.

Track the work privately with the maintainers.

## Internal delivery and source-lookup bearers

`DELIVERY_SHARED_SECRET` authenticates the Cloudflare ingest, router, and
delivery-edge callers to the native Render delivery service.
`SOURCE_LOOKUP_SHARED_SECRET` is the narrower credential used by ingest for
source lookup and erasure-index calls. The native service accepts one temporary
`*_PREVIOUS` value for each bearer so callers can cut over without downtime.

Use distinct random values of at least 32 characters and retain the known old
values in the approved password manager. Never fetch an existing Render or
GitHub value into terminal output. Rotate in this order:

1. Put the new current values and the known old values under
   `DELIVERY_SHARED_SECRET`, `DELIVERY_SHARED_SECRET_PREVIOUS`,
   `SOURCE_LOOKUP_SHARED_SECRET`, and
   `SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS` in the GitHub `Production`
   environment. Send every value to `gh secret set --env Production` on
   standard input.
2. Dispatch `Sync Render Runtime Secrets` for exactly
   `axel-delivery-native`. It performs one preserving bulk save and readback;
   it does not deploy. Deploy only `axel-delivery-native` at the reviewed main
   commit and prove the old callers still succeed through the overlap.
3. Dispatch `Sync Cloudflare Runtime Secrets` separately for `ingest-worker`,
   `router-edge`, and `delivery-edge`. Each workflow stages a complete
   code-and-secret version, activates that one version atomically, and runs the
   production smoke and delivery canary. Stop after any failure. Do not remove
   the old Render bearer while an old Worker version can still receive traffic.
4. Sync and deploy `axel-delivery-workers` so its dormant delivery credential
   is current. It does not receive either previous bearer or the source-lookup
   bearer.
5. Delete both GitHub `*_PREVIOUS` secrets, sync `axel-delivery-native` again
   (a missing optional input deliberately saves an empty Render value), deploy
   that exact target, and verify the old bearers now receive 401 while the
   current bearers remain healthy.

Any failed save, deployment, smoke, or canary stops the sequence with the old
bearer retained. Render secret sync has no `all` target and never copies values
between services. Do not use a Blueprint sync as a substitute for this
rotation boundary.

## Control-plane PostgreSQL credentials

For the managed Render database, use `DATABASE_ACCESS_MODE=render`. The owner
login remains in the protected migration environment; each application uses a
separate restricted login. Follow the [Render setup and rotation instructions](database-service-roles.md#render-deployments).
That path does not require a provider superuser.

The rest of this section covers the optional strict role model. It requires
cluster-admin access and uses these roles:

- `DATABASE_MIGRATION_URL` is a replaceable, non-owner login available only to
  protected migration and deployment jobs. It can only `SET ROLE` to the
  stable owner.
- Five replaceable service logins cover dashboard, native delivery, delivery
  workers, pull worker, and edge delivery. Each inherits one explicit
  capability from `scripts/database-service-access-profiles.mjs`.
- `DATABASE_VERIFY_URL` is a metadata-only login used by the table-existence
  workflow. It cannot read application rows.

The ingest worker receives no PostgreSQL credential. See
[database service roles](database-service-roles.md) for the exact profiles, protected variable
names, final-state gate, and target-by-target rotation order.

The stable object owner is a role, not a long-lived application login. Every
migration connection must set the validated `DATABASE_MIGRATION_ROLE` at
session startup. `DATABASE_MIGRATION_LOGIN_ROLE` pins the separate session
login, which must be `NOINHERIT`, own nothing, and have exactly one SET-only
membership in the owner. This keeps new objects and default privileges owned
by the same role when the login changes.
`DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES` records whether the reviewed owner
has `CREATEROLE`: hosted role provisioning uses `1`, while the self-host owner
uses the narrower `0` policy. `DATABASE_MIGRATION_OWNER_PARENT_ROLES` is the
exact comma-separated allowlist of roles granted to the owner. Keep it empty
only when the owner has no parent memberships.
During an overlap, `DATABASE_MIGRATION_EXISTING_LOGIN_ROLES` is a comma-separated
allowlist of reviewed older migration logins that still need access. Clear it as
soon as those logins are retired; an unlisted child of the owner blocks every
migration.

### Strict-model rotation with credential overlap

1. Freeze deploy reruns, broad secret-sync workflows, and Render Blueprint
   syncs. Keep the old credential active throughout validation.
2. Generate distinct high-entropy service and verifier passwords in a trusted
   process. Do not place them in argv, logs, shell history, temporary files, or
   repository files.
3. Run `scripts/hosted-database-bootstrap.mjs --prepare` first. This is a
   read-only preflight. Resolve every blocker before asking the managed database
   provider to run its reviewed `--prepare --apply` path with bootstrap-superuser
   authority. The existing database owner cannot create its own SET-only
   migration login on PostgreSQL 17 because the automatic creator membership
   would form a prohibited cycle. The provider-admin path creates the migration
   and verifier roles without that edge. On Render managed PostgreSQL this is a
   Render support operation, not a workspace-admin/API operation; Render does
   not expose PostgreSQL superuser access to customers. The same support request
   must revoke `PUBLIC` execution on provider-owned extension routines and
   `PUBLIC` database privileges on the provider maintenance database before the
   prepare preflight can pass.
4. Run `scripts/provision-database-service-roles.mjs` with its inputs supplied as
   environment variables. The provisioner requires PostgreSQL 17, a stable
   owner with complete ownership of the `public` schema objects, and a direct
   database endpoint. It creates five replaceable logins behind no-login
   capability roles and grants only reviewed current relations. The legacy
   broad provisioner command is disabled.
5. Authenticate all five service logins and run the checked-in privilege
   preflights. Stop on a schema mismatch, rogue ACL, unexpected role edge,
   ownership, routine access, `schema_migrations` access, or `TRUNCATE` access.
6. For later migration-login rotations, use the same provider-admin path. The
   login must have exact safe login
   attributes and one `ADMIN FALSE, INHERIT FALSE, SET TRUE` membership in the
   stable owner. Confirm `current_user` is the owner, `session_user` is the new
   login, and neither ACL nor ownership dependencies point at the login.
   Put the still-live prior login in `DATABASE_MIGRATION_EXISTING_LOGIN_ROLES`
   before changing the primary login variable.
7. Save `DATABASE_MIGRATION_URL`, `DATABASE_VERIFY_URL`, and the five
   target-specific service URLs as GitHub `Production` environment secrets via stdin.
   Save the stable owner and verifier login names as protected non-secret
   variables, including `DATABASE_MIGRATION_LOGIN_ROLE`,
   `DATABASE_MIGRATION_OWNER_PARENT_ROLES`, and
   `DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES`. Verify names and update
   timestamps only.
8. Dispatch `Sync Production Database Credential` once per target. Protected
   variables pin the exact expected login and capability. Vercel saves only the
   next production configuration and requires an exact-commit deployment
   afterward. The current Render path saves and immediately redeploys the exact
   reviewed commit. Each Cloudflare secret update activates immediately. Render
   and Cloudflare therefore run the production smoke and delivery canary before
   the dispatch completes.
9. Deploy and verify Vercel first, then each Render runtime separately, then one
   Cloudflare Worker at a time. Keep every superseded migration, runtime, and
   verifier login valid until every smoke, canary, and sanitized error check is
   green. Confirm the ingest Worker has no database binding and the Render
   delivery worker has no `PARQUET_DELIVERY_QUEUE_ID` environment key.
10. Run the migration workflow with no pending migrations. Confirm the new
   migration login owns no database object.
11. Retire each superseded migration, service, and verifier login separately.
    For each login, wait until it has zero sessions, delete or deactivate it
    with audited SQL under the provider-admin/stable-owner boundary, then prove
    its superseded DSN rejects a new connection. SQL-created roles are not
    managed credentials and do not appear in the provider credential API. Use
    the provider's credential deactivation only for the original provider-managed
    owner login. Do not treat one login's retirement proof as proof for another.
    Clear each corresponding existing-login allowlist immediately after the
    retirement proof.
12. Remove the legacy shared runtime secret from every GitHub secret scope,
    retire the broad capability, and set `DATABASE_SERVICE_REQUIRE_FINAL_STATE=1`.
    Any credential or deployment change restarts the soak clock.

Before deactivating the original managed owner login, add and secure a new
provider-managed default credential for break-glass administration. The
provider's documented delete action for the original user revokes `LOGIN` but
does not promise to remove `INHERIT` or `CREATEDB`; provider-admin finalization
must normalize all attributes and the checked-in finalizer must pass afterward.

If the new managed login cannot assume the stable owner, stop before disabling
the old login. Provider assistance or a separately reviewed ownership transfer
is required; silently changing object ownership is not an acceptable fallback.
