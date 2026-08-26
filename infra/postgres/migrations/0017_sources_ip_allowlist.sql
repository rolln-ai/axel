-- Migration 0017: source-level inbound IP allowlist (AXE-34).
--
-- When the operator pastes a list of CIDRs the ingest worker
-- rejects requests whose `cf-connecting-ip` is outside the union.
-- Useful for providers with documented IP ranges (Stripe, GitHub,
-- Shopify) where any other source IP is almost certainly forged.
--
-- Stored as a text[] of CIDR strings; NULL/empty = no allowlist
-- (current behaviour, accept any IP).

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS inbound_ip_allowlist TEXT[] NOT NULL DEFAULT '{}';
