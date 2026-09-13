# Production scale targets

The design targets millions of accepted webhooks per hour, p95 ingest
acknowledgement below 250 ms, and p95 delivery below 5 seconds for healthy
destinations. These are targets, not published benchmark results.

## Load model

- 1 million/hour = 278 events/second sustained.
- 10 million/hour = 2,778 events/second sustained.
- Burst target remains higher than sustained target; ingest must absorb bursts
  by writing raw payloads and queueing compact messages before returning.

## Runtime requirements

- Keep ingest CPU bounded: token validation, byte/depth caps, R2 put, queue send.
- Keep declarative route evaluation off the ingest hot path.
- Router and delivery workers process batches with bounded concurrency.
- Route evaluation is eval-free and does not execute customer JavaScript.
- Each delivery has a deterministic idempotency key:
  `workspace:event:route:destination`.
- Retry uses exponential backoff with jitter and a max-attempt cap.
- ClickHouse receives append-only logs; Postgres handles config and small
  mutable state only.

## Scaling

- Increase queue shard count and worker replica count together.
- Increase router batch concurrency only after measuring RSS, CPU, and queue lag
  on the router instance size.
- Scale delivery capacity by connector type. Limit database connections per
  destination, and keep the periodic worker at one instance.
- Keep raw payload retention short enough that replay cost stays bounded.

## Deployment requirements

- Fence source authority before source or credential changes, then publish the
  committed configuration. A short cache TTL alone cannot revoke credentials.
- Route/destination config must be cached in router workers and invalidated on
  control-plane writes.
- Postgres must use partial indexes for active route lookups and TTL cleanup for
  idempotency rows.
- ClickHouse inserts should be batched; single-row inserts are not acceptable at
  sustained high volume.
- Alert on queue lag, retry rate, route-evaluation error rate, dead-letter count,
  destination p95 latency, and R2 read/write errors.
