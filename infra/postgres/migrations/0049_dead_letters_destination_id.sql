-- Migration 0049: record the destination a dead-letter was bound for.
--
-- Per-destination failures knew their destination_id at throw time but had
-- nowhere durable to put it: dead_letters only carried route_id, and the
-- router catch-all (deadLetterRouterFailure) wrote route_id="" — so the
-- investigate page could show neither the route nor the destination of a
-- failure like `delivery_service_503: delivery_overloaded` (the native-
-- delivery backpressure shed). router-edge now threads route_id + destination_id
-- out of the dispatch loop via DeliveryDispatchError, and delivery-edge's DLQ
-- recorder persists it here.
--
-- Nullable on purpose: route-level dead-letters (raw_payload_missing,
-- declarative_engine_error) and unexpected pre-routing failures genuinely have
-- no single destination, and every row written before this migration has none.
-- No index: the investigate page looks the row up by primary key and joins
-- destinations by its primary key; list/inbox queries never filter on it.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS destination_id text;
