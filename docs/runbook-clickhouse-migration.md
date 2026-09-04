# ClickHouse migration for self-hosted installations

This public runbook covers the product-level order of operations. Axel Cloud
resource names, credential locations, vendor account details, and emergency
contacts belong in the private operations repository.

## Keep database maintenance outside application releases

The protected application release workflow cannot deploy `axel-clickhouse`.
Database container changes require a separate, explicitly reviewed maintenance
procedure after the latest backup has been restored successfully. They must
never share an application release path.

A ClickHouse container replacement causes a restart. An attached data disk is
not a backup. Use the separate `Migrate ClickHouse` workflow for schema changes,
and record the independent approval, backup, restore, and rollback evidence for
any future database-container change in the private operations repository.

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
