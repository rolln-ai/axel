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
