# Ordered delivery implementation notes

This directory contains a Durable Object and queue state machine for per-key
ordering. The router does not yet enqueue work through this object, and delivery
runtimes do not report results to it. Its presence in the repository does not
provide end-to-end ordered delivery.

Ingest already extracts `ordering_key` and uses it to choose a queue shard.
That alone does not serialize destination delivery.

## Components

- `OrderingQueueCore` in `@axel/shared` allows one delivery per key at a time.
  Success or terminal failure advances the queue. A retry keeps the current
  delivery in place; failure records a gap. Duplicate reports are harmless.
  Tests use fake storage in `apps/ingest-worker/test/ordering-core.test.ts`.
- `durable-object.ts` adapts the core to Cloudflare storage and sends the next
  message to `DELIVERY_QUEUE` with an `ordering_token`.
- `wrangler.toml` declares the `ORDERING` binding and `v1-ordering-do` migration.
- `DestinationQueueMessage.ordering_token` carries the result-report token.

## Work required before enabling delivery ordering

Enqueue and result reporting must ship together. Without a terminal result,
a key stays blocked indefinitely.

1. Route messages with `ordering_key` through the Durable Object's `enqueue`
   operation. Keep unordered messages on the existing path.
2. Have edge delivery report success, failure, and retry outcomes with the token.
   Bind it to the router's Durable Object namespace.
3. Provide an authenticated report path for Node delivery, which cannot bind a
   Durable Object directly. Reject unsupported ordered/native configurations
   until this path is implemented.
4. Preserve R2 spill handling for oversized messages. The object should store
   the message that references the spilled payload.
5. Give replayed events a new ordering token and place them in the queue normally.

Decide the ordering scope before integration: per key, per route, or per
route/destination/leaf. Also resolve lost-report recovery, alarm cleanup, and
placement latency. Test the complete path in Cloudflare before enabling it
for production sources.
