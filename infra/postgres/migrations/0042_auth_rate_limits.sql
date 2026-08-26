-- Migration 0042: auth rate-limiting buckets (fixed-window).
--
-- Brute-force protection for sign-in / sign-up / password-reset. Postgres-
-- backed because the dashboard runs serverless on Vercel — an in-memory
-- limiter would reset on every cold start and never share state across
-- instances. One atomic upsert per check (see lib/rate-limit.ts).
--
-- Stale buckets are harmless (overwritten on the next hit for the same key)
-- but accumulate as distinct IPs/emails churn; prune window_start older than a
-- day opportunistically (follow-up: wire into the retention loop).

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON auth_rate_limits (window_start);
