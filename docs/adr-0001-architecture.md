# ADR-0001: Original architecture

Date: 2026-04-30
Status: Historical. [ADR-0002](adr-0002-current-runtime.md) describes the current runtime.

## Requirements

The original design targeted bursts of 30,000 webhooks in under five seconds.
This was a capacity target, not a benchmark result.

Ingest would store the raw payload and queue the event before acknowledging it.
Routing and delivery would run asynchronously so a slow destination would not
hold the sender's connection open. The system would tolerate duplicates.

## Original design

1. A Cloudflare Worker authenticates the sender, enforces source limits, stores
   the body in R2, and sends metadata to a sharded queue before returning 202.
2. A Node router on Render consumes the ingest queues, reads R2, evaluates each
   route, and queues work for its destinations.
3. Node delivery workers run the connectors, record attempts, and retry failures.
4. Postgres stores configuration and credentials. R2 stores raw payloads, and
   ClickHouse stores searchable event and delivery metadata. Both event stores
   use a default 30-day retention period.

For current source authentication, see [webhook authentication](webhook-authentication.md).

## Reasons for the choices

Cloudflare Workers provide edge ingest with native R2 and Queue bindings. R2
avoids object-storage egress charges when the router reads each payload.
Sharded queues allow routing work to spread across consumers. ClickHouse keeps
event-search queries separate from the Postgres configuration database.

The ingest path avoids direct Postgres writes, though authentication can still
depend on the control API. Ingest can fail when authentication, storage, or
queueing is unavailable; asynchronous delivery does not remove those dependencies.

## Alternatives considered

- A single queue would simplify operation but limit how work can be partitioned.
- Synchronous delivery would couple webhook acceptance to destination availability.
- Kafka with a custom ingest service would add a broker and more infrastructure
  to operate. Reconsider it if Cloudflare Queues no longer meets the requirements.
- Postgres-only event logs would reduce the number of stores. The design chose
  ClickHouse for event analytics, without a published comparison benchmark.

## Consequences

The ingest path depends on Cloudflare APIs. Moving it requires replacing storage
and queue integration as well as the HTTP handler. The deployment spans multiple
providers, each with separate credentials, billing, and recovery procedures.

Delivery is at least once. Each connector and receiver needs a defined
idempotency policy.

## ClickHouse hosting change, 2026-05-26

ClickHouse moved from ClickHouse Cloud to a Render container. The schema stayed
the same. Manual schema migrations use `.github/workflows/migrate-clickhouse.yml`;
daily native backups to R2 use `.github/workflows/clickhouse-backup.yml` with an
R2 lifecycle rule for backup expiry.

See `render.yaml` for the current image and disk configuration, and the
[ClickHouse migration runbook](runbook-clickhouse-migration.md) for replacement
and rollback procedures. The original image and disk size are no longer setup
instructions.
