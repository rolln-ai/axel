# Ordered delivery — Durable Object (Phase 2 scaffold)

This directory holds the **first Durable Object in the codebase**: the per-key
serializer for FIFO/ordered delivery. It is a deliberate, reviewable scaffold —
the DO class, its binding, and its unit-tested core exist, but the **call sites
are not yet wired**. Nothing reaches the DO until the wiring below ships *and* a
source sets `ordering_enabled`, so this is inert in production.

## What's here
- `@axel/shared` `OrderingQueueCore` — the runtime-agnostic state machine (one
  in-flight per key; advance only on terminal success/dead; `retry` = no-op
  head-of-line block; dead = unblock + record gap; idempotent `report`). Fully
  unit-tested in `apps/ingest-worker/test/ordering-core.test.ts` against a fake
  storage, because router-edge has no test runner and a DO needs workerd.
- `durable-object.ts` — thin CF wrapper: `state.storage` + a `dispatch` that
  sends the head delivery to `DELIVERY_QUEUE` stamped with `ordering_token`.
- `wrangler.toml` — `ORDERING` binding + `v1-ordering-do` migration tag.
- `DestinationQueueMessage.ordering_token?` — the echo-back token (additive).
- Phase 1 (already on main): ingest extracts `ordering_key`, shards by it.

## Remaining wiring (must land together)
Enqueue without report would **stall a key** (the in-flight slot never clears),
so these ship as one unit, behind `ordering_key` presence (inert otherwise):

1. **Router enqueue** (`apps/router-edge/src/index.ts`, leaf loop ~329–428):
   for a message with `ordering_key`, instead of `DELIVERY_QUEUE.send` / native
   HTTP, call the DO: `env.ORDERING.get(env.ORDERING.idFromName(ordering_key))`
   `.fetch(..., {op:"enqueue", leaf:{event_id, message: destinationMessage}})`.
   Unordered messages keep the existing path verbatim.

2. **Delivery report** — on terminal outcome, echo `ordering_token` back:
   - `apps/delivery-edge` (queue path): in the `success`/`dead`/`retry` switch,
     if `ordering_token` is set, call the DO `{op:"report", seq, outcome}`.
     delivery-edge binds the same DO namespace via `script_name`.
   - **Native path** (`router-edge` direct-HTTP `mongodb`/`databricks`, and the
     Node `delivery-service`): the Node service can't bind a DO. Options: a tiny
     report-forwarder route on an edge worker, or a Cloudflare RPC binding.
     Until resolved, **ordered + native destination is unsupported** — guard it
     at config time rather than silently reordering.

3. **Spill keys**: ordered leaves still spill oversize bodies to R2 before
   enqueue; the DO stores the spilled message as-is.

## Open questions (carried from the design)
- Report-loss watchdog via DO `alarm()` (re-probe `delivery_idempotency.state`).
- Ordering scope: per `(key, route, destination, leaf)` vs. across a route.
- DO regional placement / latency; key cardinality vs. DO count + `alarm()` GC.
- Replay of an ordered event must get a fresh `ordering_token` (not jump the
  live key's queue).

## Why this isn't deployed yet
Introducing DOs adds a new deploy/local-dev (`wrangler dev`)/on-call surface.
Per the design, socialize that before enabling Phase 2 in production. This
branch is for review of the DO approach and its invariants; it is intentionally
unpushed.
