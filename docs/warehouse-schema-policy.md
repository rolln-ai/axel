# Warehouse schema changes

BigQuery, Postgres dot-notation, and Databricks typed-column routes keep existing
table schemas unchanged by default. This includes bindings saved before
`schema_evolution` was introduced. A missing table can be created from the first
event. An existing empty table still needs a reviewed schema or explicit permission
to add fields.

An event requiring new fields fails delivery under this policy. Axel does not
remove unknown fields or report a partial row as delivered. The ordinary durable
dead-letter and replay path applies; replay availability remains limited by raw
payload retention. Review failures before that retention expires.

For a table where automatic additions have been reviewed, select **Allow new
fields** in the route editor or new-destination flow. The saved binding contains:

```json
{
  "dataset": "analytics",
  "table": "events",
  "mode": "typed_records",
  "schema_evolution": "add_columns"
}
```

Postgres and Databricks bindings use the same property without `dataset`.
`manual`, an omitted property, and unrecognized values never authorize additions.
Neither setting authorizes changing existing column types. Postgres no longer
widens a column automatically when a later event has a different value type.

## Why additions need a decision

A nullable field added to one BigQuery RECORD changes the corresponding STRUCT
type. A view that unions whole records from historical and current tables can
stop parsing even while inserts into the current table succeed. Top-level field
additions can also affect wildcard queries and consumers expecting a fixed schema.

Before allowing additions, review every downstream view, union, export, and
dashboard that depends on the target. Prefer explicit projections with consistent
field order and types. A compatibility check against sampled events proves only
that those events fit the target; it does not inspect all downstream consumers.
See [BigQuery conversion rules](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/conversion_rules).

## Upgrade existing installations

This is a deliberate behavior change. Do not enable additions globally to preserve
the old behavior. Inventory saved route bindings, their table schemas and downstream
consumers first. Provision reviewed missing fields, use a stable JSON column, or
explicitly allow additions on each appropriate route.

Deploy the connector before the dashboard controls. The previous connector ignores
`schema_evolution` and may still change an existing schema even if a newer dashboard
shows **Keep existing schema**. After deployment, check accepted source traffic,
delivery outcomes and downstream query validity separately. A successful synthetic
canary alone does not establish that client feeds are still flowing.

Queued messages retain their captured binding. Messages without the opt-in follow
the new manual policy when processed by the updated connector. Review and replay
failed events after the target schema or route policy has been updated.

No database migration, customer table alteration, or bulk binding update is part
of this code change.
