# ClickHouse migration for self-hosted installations

This public runbook covers the product-level order of operations. Axel Cloud
resource names, credential locations, vendor account details, and emergency
contacts belong in the private operations repository.

## Deploy the existing Axel Cloud service

The protected release workflow disables and reads back Render git auto-deploy
for `axel-clickhouse` before it can deploy. The initial hardening merge must use
Render's `[skip render]` commit guard so provider auto-deploy cannot race that
first enforcement. When the Dockerfile, image, or server configuration changes,
dispatch `Deploy Render Services` from protected `main` and select only
`axel-clickhouse`. Check the latest backup first, then enter
`deploy-stateful-clickhouse` in the confirmation field. The workflow deploys
the selected commit SHA, waits until that exact deploy is live, and runs the
production smoke and delivery canary.

The `all` option deliberately excludes ClickHouse. A ClickHouse deploy replaces
the database container and causes a short restart. Render keeps the attached
`clickhouse-data` disk, but that disk is not a backup. Use the separate
`Migrate ClickHouse` workflow for schema changes.

## Before the change

1. Record the current ClickHouse endpoint and image version in a private
   incident note. Do not paste passwords or access keys into the note.
2. Take a backup and restore it into a disposable ClickHouse instance.
3. Apply `infra/clickhouse/schema.sql` to the replacement instance.
4. Confirm `/ping`, an authenticated `SELECT version()`, and `SHOW TABLES`.
5. Freeze unrelated releases and choose a rollback deadline.

## Cut over

1. Update the ClickHouse URL and credentials in the deployment secret manager.
2. Deploy writers before readers. The ingest and delivery runtimes must write
   to the replacement before the dashboard starts querying it.
3. Send a synthetic webhook through a dedicated test source.
4. Confirm the event and its delivery attempt exist in the replacement.
5. Run the production smoke and canary checks.

Do not place a ClickHouse password in a shell history entry. Load it from the
operator's secret manager and clear any temporary environment after the check.

## Rollback

If writes, reads, or the canary fail before the rollback deadline:

1. Restore the previous endpoint and credentials for writers.
2. Restore them for readers.
3. Redeploy the affected services at the last known-good commit.
4. Verify a new synthetic event end to end.

Keep the old service read-only until the replacement has completed its soak and
the backup restore drill has passed. Decommissioning storage is a separate,
reviewed change.

## Evidence to retain

- Backup and restore timestamps.
- Schema migration workflow URL.
- Exact application commit.
- Synthetic event ID and delivery result.
- Rollback decision and decommission approval.
