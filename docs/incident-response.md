# Incident response

## Severity

- `SEV-1`: Data loss, broad outage, credential exposure, or security breach.
- `SEV-2`: Degraded ingest/delivery for multiple customers.
- `SEV-3`: Single-customer issue or delayed analytics with no data loss.

## First 15 minutes

1. Record severity, affected customers, and the timeline in a private incident note.
2. Identify the failing component: ingest, router, delivery, dashboard,
   ClickHouse, Postgres, R2, Vercel, Render, or Cloudflare.
3. Freeze unrelated deploys.
4. Decide whether to roll back or deploy a fix.
5. Record timestamps and event, workspace, and deployment IDs privately.

## Recover a failure recorded before routing

`Inspect route health` reports `source_failures_before_routing` separately from
route failures. These records have no route ID, so a successful route-scoped
backfill does not automatically resolve them.

For a source with exactly one configured route and one destination, verify that
the route and destination are healthy, then use `Recovery backfill` with the
smallest receipt-time window containing the retained event. Recovery skips
completed delivery claims and waits for in-flight work. Inspect the exact job
until it is `done` and verify its destination delivery.

Run the same workflow with `action=reconcile`, the completed `job_id`, the
reviewed route's `expected_updated_at`, and
`confirm_production=reconcile-confirmed-source-failures`. Reconciliation requires
a successful replay and a completed delivery claim for the same event, retained
payload, workspace, route and destination after the original failure. It refuses
sources with additional routes, including disabled routes. It logs only the
resolved count and writes an audit entry; it neither sends another delivery nor
changes route settings. Use the source-wide dashboard replay controls when the
source has multiple routes.

Reinspect source failures afterwards. Incident recovery still requires the normal
healthy observation period; do not manually resolve an incident to hide an
unconfirmed delivery.

## Rollback

Application rollback:

1. Revert the offending pull request.
2. Let required checks pass.
3. Deploy from `main`.
4. Run smoke checks.

Schema rollback:

1. Stop dependent deploys.
2. Prefer fix-forward migrations when data may already be written.
3. If rollback is required, write a reviewed SQL migration and run it through
   the `Migrate Postgres` workflow.

## After the incident

Within 24 hours:

- Write a short report with the timeline, cause, and follow-up work.
- Add missing tests or alerts.
- Update the runbook if the response was unclear.
