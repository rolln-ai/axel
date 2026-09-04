# ADR-0001 — Architecture Baseline

Date: 2026-04-30
Status: Historical. Deployment topology superseded by [ADR-0002](adr-0002-current-runtime.md).
## Context

Axel must capture webhook bursts (30k events in <5s) and deliver to multiple destination types without dropping events. The architectural commitment is: ingest never blocks; everything after ingest is async; raw payload is the source of truth; system tolerates duplicates.

## Decision

We adopt a four-tier pipeline:

1. **Edge ingest** — Cloudflare Worker. Validates a custom source token from the `x-axel-token` header or a named provider's configured authentication, applies source caps/rate limits, generates `event_id`, puts the raw body in R2, sends a compact message to a sharded queue, returns 202. Source credentials in URL query parameters are rejected.
2. **Router** — Render Node service. Consumes ingest queues, fetches payload from R2, evaluates filter/transform per route, fans out to per-destination queues.
3. **Delivery workers** — Render service per destination type. Each consumes a destination queue, fetches payload, runs the connector, logs the attempt, retries on failure.
4. **Storage split** — Postgres for config (users, sources, routes, destinations, credentials). R2 for raw payloads (immutable, 30d TTL). ClickHouse for searchable event + delivery logs (30d TTL).

### Component reasoning

- **CF Workers for ingest**, not Render: edge presence + cold-start absence + native R2 + native Queues binding. We pay for this with vendor lock at the ingest layer; that lock is acceptable because the ingest contract is intentionally tiny.
- **R2 over S3**: lower egress cost for the router (which reads every payload), and bundled with Workers.
- **Sharded queue fanout**: lets the router scale horizontally without a single-queue bottleneck. Shard count is a constant in `packages/shared` so router/worker code share it.
- **ClickHouse over Postgres for logs**: 30d retention with millions of rows requires column-store performance; Postgres would buckle on event search.
- **No direct DB writes from ingest**: a downstream Postgres outage must not 500 a webhook.

## Rejected alternatives

- **Single queue**: simpler but creates head-of-line blocking on burst.
- **Synchronous ingest → connector**: violates the "ingest never blocks" principle and couples our reliability to every customer destination.
- **Kafka + custom edge**: heavier ops than Render/CF gives us; revisit only if CF Queues becomes a constraint.
- **Postgres-only logs**: cheaper short-term, fails by Phase 7 load test.

## Consequences

- We accept Cloudflare lock-in for ingest. Mitigation: ingest contract is small enough to port to a Render edge service in days if we ever need to.
- We accept a multi-vendor cost surface (CF + Render + Neon + ClickHouse Cloud + MongoDB Atlas + Vercel + Clerk). CTO will produce a monthly cost projection before Phase 2.
- Idempotency is a connector responsibility and must be defined per connector.

## Status of implementation

- Phase 0 ingest worker scaffolded in `apps/ingest-worker` per this ADR.
- Router and delivery workers now have bounded-concurrency batch processors.
- Delivery idempotency, retry scheduling, and durable Postgres/ClickHouse
  schemas are represented in code and infra files.

## 2026-05-26 addendum — ClickHouse hosting

ClickHouse has moved from ClickHouse Cloud to **self-hosted on Render Standard**, as the original cost model anticipated. The schema is unchanged; the only differences are operational:

- Service definition: `render.yaml` → `axel-clickhouse` (Docker image `clickhouse/clickhouse-server:24.8`, 50 GB persistent disk).
- Schema deploys: `.github/workflows/migrate-clickhouse.yml` (manual `workflow_dispatch`, mirrors the Postgres pattern).
- Backups: `.github/workflows/clickhouse-backup.yml` runs the native `BACKUP ... TO S3(...)` command against R2 daily; retention is enforced by an R2 lifecycle rule.
- Cutover runbook: `docs/runbook-clickhouse-migration.md`.

This addresses the "backup story" the original ADR referenced as a prerequisite for self-hosting. The component-reasoning paragraph above still holds — ClickHouse remains the right shape for the workload; only the operator changed.
