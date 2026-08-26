# Production Scale Target

Target: millions of accepted webhooks per hour with p95 ingest acknowledgement
under 250ms and p95 end-to-end delivery under 5s for healthy destinations.

## Load Model

- 1 million/hour = 278 events/second sustained.
- 10 million/hour = 2,778 events/second sustained.
- Burst target remains higher than sustained target; ingest must absorb bursts
  by writing raw payloads and queueing compact messages before returning.

## Required Runtime Controls

- Keep ingest CPU bounded: token validation, byte/depth caps, R2 put, queue send.
- Keep declarative route evaluation off the ingest hot path.
- Router and delivery workers process batches with bounded concurrency.
- Route evaluation is eval-free and does not execute customer JavaScript.
- Each delivery has a deterministic idempotency key:
  `workspace:event:route:destination`.
- Retry uses exponential backoff with jitter and a max-attempt cap.
- ClickHouse receives append-only logs; Postgres handles config and small
  mutable state only.

## Scaling Knobs

- Increase queue shard count and worker replica count together.
- Increase router batch concurrency only after measuring RSS, CPU, and queue lag
  on the router instance size.
- Scale delivery workers independently by connector class. HTTP can scale
  broadest; database connectors need per-destination connection caps.
- Keep raw payload retention short enough that replay cost stays bounded.

## Deployment Requirements

- Source config must be cached at the edge with short TTL and explicit purge on
  source/token changes.
- Route/destination config must be cached in router workers and invalidated on
  control-plane writes.
- Postgres must use partial indexes for active route lookups and TTL cleanup for
  idempotency rows.
- ClickHouse inserts should be batched; single-row inserts are not acceptable at
  sustained high volume.
- Alert on queue lag, retry rate, route-evaluation error rate, dead-letter count,
  destination p95 latency, and R2 read/write errors.
