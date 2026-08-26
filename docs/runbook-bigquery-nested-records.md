# BigQuery nested-record rollout

Axel's `nested_records` mode preserves webhook objects as BigQuery
`RECORD`/`STRUCT` fields, normalizes scalar leaves to `STRING` for schema-drift
tolerance, and maps compatible arrays to `REPEATED` fields. Ambiguous arrays
are retained losslessly in a sibling `__json` field. Legacy `columns` and
`json_column` modes remain available for existing integrations.

## Dataset-per-route targets

A BigQuery destination owns one GCP `project_id`, one service-account
credential, and a required default dataset for legacy compatibility. New and
edited route bindings snapshot both `dataset` and `table`, so the same
destination can write to `demo_newsletter.events`,
`billing_analytics.events`, or any other dataset in that project that the service
account can access. Bare table names continue to resolve against the default
dataset, and legacy bindings without `dataset` keep their existing behavior.

Deploy the delivery-service connector support before deploying the dashboard
picker that emits `binding.dataset`. An older connector ignores that new key
and would otherwise write the selected table name into the destination's
default dataset. After the connector rollout, deploy the dashboard and verify
one route in a non-default dataset before enabling the rest.

## Safe rollout order

1. Merge and deploy the backend/shared-contract release that understands
   `nested_records`.
2. Confirm `axel-delivery-native` is healthy and running that commit.
3. Only then merge the dashboard release that exposes and defaults new routes
   to `nested_records`.
4. Choose a collision-free suffix and confirm the resulting table names do not
   already exist in the destination datasets.
5. Preview every binding cutover with the migration script (the one-shot
   `migrate-bigquery-nested-bindings.yml` workflow that wrapped it ran to
   completion in July 2026 and has been removed; it is recoverable from git
   history):

   ```sh
   DATABASE_URL=... node scripts/migrate-bigquery-nested-bindings.mjs \
     --suffix=_nested_v2
   ```

6. Apply the cutover:

   ```sh
   DATABASE_URL=... node scripts/migrate-bigquery-nested-bindings.mjs \
     --suffix=_nested_v2 --apply
   ```

The script keeps each existing target unchanged and points the route at a new
table whose name ends in `_nested`. The connector creates that table from the
first event. Migration metadata is stored in the binding so rollback is
transactional and idempotent.

The bulk workflow migrates legacy `columns` bindings only. `json_column`
bindings may accept non-object payloads that `nested_records` correctly rejects,
so they require a separate payload-eligibility review and explicit script
opt-in instead of being converted blindly.

Messages queued before the binding change retain the old binding and finish in
the old table. Router-edge also caches route bindings for up to 30 seconds, so
a small number of events routed shortly after the database commit can still use
the old table. Once the cache turns over, newly routed events use the nested
table. The cutover does not require a delivery pause.

## Verification

For every migrated binding:

1. Confirm the route binding has `mode: "nested_records"` and the suffixed
   table name.
2. Wait for a successful delivery attempt after the cutover.
3. Inspect the new BigQuery table schema. Object fields such as `data` and
   `data.subscriber` must be `RECORD`, not `JSON` or underscore-joined scalar
   columns.
4. Query a nested leaf with dot notation, for example:

   ```sql
   SELECT data.subscriber.email
   FROM `project.dataset.table_nested`
   LIMIT 10;
   ```

Historical rows remain in the preserved legacy table. Use Axel replay/backfill
after schema verification if historical data is required in the new table.

## Rollback

Rollback only changes the control-plane binding; it never deletes either
BigQuery table:

```sh
DATABASE_URL=... node scripts/migrate-bigquery-nested-bindings.mjs \
  --suffix=_nested_v2 --apply --rollback
```

Queued messages keep the binding captured when they were routed, so a small
number may still land in the nested table after rollback. Both tables should be
retained until the post-deploy observation window is complete.
