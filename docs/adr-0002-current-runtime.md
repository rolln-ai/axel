# ADR-0002: Current runtime and contribution boundaries

Date: 2026-09-04
Status: Accepted. Supersedes the deployment topology in ADR-0001.

Axel runs routing and delivery asynchronously so a slow destination does not
hold a webhook sender's connection open. Database connectors run in Node because
they need libraries that edge workers cannot run.
The repository contains shared libraries under `apps/` as well as deployable
services. A folder under `apps/` does not imply another service to operate.

## Hosted topology

```text
Webhook sender
  -> ingest-worker: authenticate, enforce limits, store raw bytes in R2
  -> sharded Cloudflare Queues
  -> router-edge: fetch source routes, evaluate declarative rules, fan out
     -> delivery-edge: HTTP, signed webhook, R2, and JSON S3
     -> native delivery queue
        -> delivery-service: Postgres, MongoDB, BigQuery, Databricks, Parquet S3

Dashboard on Vercel -> Postgres for configuration, auth, and durable control state
                   -> ClickHouse for event search and delivery analytics
Pull worker        -> the same authenticated ingest path
```

The ingest acknowledgement follows the R2 write and queue send. Ingest may
reject or return a retryable failure when authentication, source authority,
storage, or queueing is unavailable. It does not wait for a destination.

`router-edge` gets routes through the authenticated Node control API. Source
edits fence source authority before mutating Postgres, then publish committed
configuration. A short cache TTL alone is insufficient for credential revocation.

`render.yaml` runs `delivery-service` in two roles. The `web` role serves
internal APIs and consumes the native queue; queue leases allow replicas.
The singleton `worker` role owns periodic work, including replay, retention,
and the production delivery canary. Do not scale the singleton with web traffic.
The source package `apps/router` provides routing, replay, and alert utilities;
`apps/delivery-worker` provides delivery processing. Neither is a separate
production deployment. `requiresNativeRuntimeDestination` in `packages/shared`
is the routing policy. Edge delivery forwards misplaced native jobs to the Node
queue; it does not keep a second Postgres connector implementation.

## Data and correctness

Postgres stores configuration, membership, idempotency leases, replay work,
and terminal failure state. R2 stores raw payloads. ClickHouse stores searchable
metadata and attempts. Avoid moving payload bodies into Postgres, error logs,
or diagnostic responses.

Delivery is at least once. A receiver may accept a request before Axel loses
the response. Fenced idempotency claims prevent concurrent owners, but external
receivers still need to honor the delivery idempotency key. A pipeline leaf
also participates in that key when present.

Retry a database connection before sending a statement. Once SQL has been
sent, a connection error can leave its outcome unknown; replaying the statement
can repeat a committed write. Transaction rollback failures must evict the
connection without replacing the original error.

Delivery outcome analytics collapse retries and replays by base event, route,
and destination. The `delivery_base_latest_outcomes` ReplacingMergeTree is
ordered by that identity. Read it with `FINAL` to select the latest version
without building an aggregate state for every event. Raw attempts still need
`argMax` grouping. Apply report end dates after selecting the latest outcome
so a later replay cannot resurrect an obsolete failure in an earlier report.
The Docker-backed analytics test verifies these cases before background merges.

## Small self-host profile

The small profile uses one ingest queue and one Node delivery service with
Postgres, migrations, dashboard, cron, and Caddy. It omits ClickHouse and the
hosted edge delivery split. Event search and usage analytics therefore require
additional infrastructure. Shorter raw retention and indexed subject erasure
remain disabled until their indexes and cleanup paths exist. See
[self-hosting](self-hosting.md) for the exact setup and queue retention limits.

## What to keep separate

- A successful build, healthy HTTP endpoint, worker heartbeat, and delivered
  canary prove different things. Keep each check and report unavailable data
  honestly. An unset release-observation pin must not prevent routine canaries.
  Router and delivery-edge send scheduled heartbeats every two minutes so an
  idle queue does not look stalled. Router heartbeat metadata identifies
  scheduled ticks; these prove worker liveness, while canaries prove delivery.
- Unit tests cover isolated logic. Public browser checks cover layouts and
  redirects. Database integration tests execute SQL. None substitutes for an
  authenticated product walkthrough or the post-deploy delivery canary.
  `pnpm test:dashboard` signs into a disposable database and checks a persisted
  workspace edit, source navigation, tenant isolation, and sign-out.
- Production promotions remain separate from publishing the source. Keep
  history cleanup and public repository release out of application deployments.

The main remaining architectural costs are duplicated edge/Node orchestration,
ClickHouse-dependent visibility in self-hosting, and broad runtime modules.
Extract a shared contract when behavior changes in both runtimes, with tests
against both consumers. A broad rewrite before release would make reliability
harder to assess. Keep the working pipeline and reduce those costs incrementally.
