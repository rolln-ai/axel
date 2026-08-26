-- Migration 0044: per-source FIFO / ordered delivery config (Phase 1).
--
-- Opt-in, default-off. When `ordering_enabled` is true the ingest worker
-- resolves a per-event ordering key from `ordering_key_header` (wins when
-- present) or the dot-path `ordering_key_path` into the JSON body, and
-- co-locates same-key events on one shard. Later phases serialize delivery
-- per key through a Durable Object so event N+1 is never delivered before N
-- reaches a terminal outcome.
--
-- Phase 1 adds config only — no behavior change for existing sources, which
-- all default to ordering_enabled = false and keep event_id sharding.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS ordering_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ordering_key_header text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ordering_key_path text;
