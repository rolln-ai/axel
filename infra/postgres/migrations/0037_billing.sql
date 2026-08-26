-- Migration 0037: billing & payments — workspace plan, Stripe identity,
-- per-period task counters, Stripe webhook journal, invoice mirror.
--
-- See axelapp.ai/pricing for the canonical pricing model this schema
-- supports. Plans:
--   free  — $0/month, 10k tasks/month hard cap (ingest returns 429
--           plan_quota_exceeded once total_tasks ≥ 10000 in the
--           current calendar-month period).
--   pro   — $20/month flat subscription via Stripe + a separate
--           metered Stripe Price for overage at $0.03 per 1,000 tasks
--           above the 666,666-task included threshold. Pro never
--           blocks ingest on volume; overage is reported, not gated.
--
-- A "task" is defined as one accepted webhook ingest event OR one
-- *initial* delivery push to a destination. Retries are NOT counted.
-- The ingest-worker and delivery-worker stamp `billable=true` on
-- ClickHouse rows at the point of count; a nightly rollup
-- (apps/dashboard/app/api/cron/billing-rollup) aggregates yesterday's
-- billable rows into `workspace_usage_period` and forwards the delta
-- to the Stripe Meter ("axel_tasks") for Pro workspaces.
--
-- Postgres is the billing system of record (subscription identity,
-- period counters, invoice mirror). Stripe is the wallet (cards,
-- dunning, invoice rendering, customer portal). We keep a denormalized
-- mirror of invoices in `billing_invoices` so /admin and
-- /settings/billing can render without round-tripping to Stripe on
-- every page load.

-- ── workspaces: billing identity ───────────────────────────────────────

-- `plan` is the source of truth for which pricing tier a workspace is
-- on. Defaulted 'free' so all existing rows backfill correctly. The
-- check constraint keeps 'enterprise' open for hand-rolled deals
-- without requiring another migration.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise'));

-- One-to-one with Stripe customer/subscription. NULL on free
-- workspaces (no Stripe object exists). UNIQUE so a Stripe webhook
-- can locate the workspace by customer or subscription id without
-- ambiguity.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_stripe_customer_unique'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_stripe_customer_unique UNIQUE (stripe_customer_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_stripe_subscription_unique'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_stripe_subscription_unique UNIQUE (stripe_subscription_id);
  END IF;
END $$;

-- `billing_status` is the operational state used by the ingest worker
-- and dashboard banners. Distinct from `status` (workspace lifecycle):
--   ok        — current, no action needed
--   past_due  — payment failed, dunning in progress; ingest still flows
--   grace    — dunning exhausted but inside grace window; ingest flows
--   suspended — locked; ingest returns 402 payment_required
--   canceled  — subscription canceled; workspace downgraded to free at
--               period end (handled by webhook + nightly job)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'ok'
    CHECK (billing_status IN ('ok', 'past_due', 'grace', 'suspended', 'canceled'));

-- Current Stripe subscription period anchor — copied from
-- subscription.current_period_start/end on every customer.subscription.*
-- webhook. Lets us bucket usage_period rows by the exact same period
-- Stripe will invoice, even when the period doesn't align with the
-- calendar month (mid-month upgrade etc.).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_period_start timestamptz;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_period_end timestamptz;

CREATE INDEX IF NOT EXISTS workspaces_plan_idx
  ON workspaces (plan) WHERE plan <> 'free';

CREATE INDEX IF NOT EXISTS workspaces_billing_status_idx
  ON workspaces (billing_status) WHERE billing_status <> 'ok';

-- ── workspace_usage_period: per-workspace task counters ────────────────

-- One row per workspace per billing period. `period_start` is the
-- first day of the period (UTC midnight). For free workspaces this is
-- the first of each calendar month; for Pro it's
-- billing_period_start (which may not be the 1st). The nightly rollup
-- upserts (workspace_id, period_start) and bumps the counters by
-- yesterday's ClickHouse-aggregated billable rows.
--
-- `total_tasks` is generated so we never accidentally drift between
-- the breakdown columns and the sum; queries hit it directly.
-- `reported_to_stripe_at` is the last time we forwarded the delta to
-- the Stripe Meter — only set on Pro rows.
CREATE TABLE IF NOT EXISTS workspace_usage_period (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  ingest_tasks bigint NOT NULL DEFAULT 0 CHECK (ingest_tasks >= 0),
  delivery_tasks bigint NOT NULL DEFAULT 0 CHECK (delivery_tasks >= 0),
  total_tasks bigint GENERATED ALWAYS AS (ingest_tasks + delivery_tasks) STORED,
  reported_to_stripe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, period_start)
);

CREATE INDEX IF NOT EXISTS workspace_usage_period_period_idx
  ON workspace_usage_period (period_start DESC);

-- Cross-workspace totals for /admin/overview tiles ("tasks billed
-- this month"). The partial filter keeps the index narrow.
CREATE INDEX IF NOT EXISTS workspace_usage_period_unreported_idx
  ON workspace_usage_period (workspace_id, period_start)
  WHERE reported_to_stripe_at IS NULL;

-- ── billing_events: Stripe webhook journal (idempotency + audit) ───────

-- Every Stripe webhook delivery is INSERTed by id before processing.
-- A repeat delivery (Stripe retries on 5xx) hits the PK conflict and
-- the handler exits early — no double-application of subscription
-- state changes. `processed_at` lets ops see which events stalled.
CREATE TABLE IF NOT EXISTS billing_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS billing_events_workspace_time_idx
  ON billing_events (workspace_id, received_at DESC);

CREATE INDEX IF NOT EXISTS billing_events_type_time_idx
  ON billing_events (type, received_at DESC);

CREATE INDEX IF NOT EXISTS billing_events_unprocessed_idx
  ON billing_events (received_at)
  WHERE processed_at IS NULL;

-- ── billing_invoices: denormalized read model for admin + settings ─────

-- Mirrors invoice.created / invoice.finalized / invoice.paid Stripe
-- webhooks. Lets /admin/billing and /settings/billing list invoices
-- without hitting Stripe on every page load. `hosted_url` and
-- `pdf_url` come from the Stripe invoice object — followed by the
-- user from a row click, no proxy in our app.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL,
  total_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  task_count bigint,
  period_start timestamptz,
  period_end timestamptz,
  hosted_url text,
  pdf_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_invoices_workspace_time_idx
  ON billing_invoices (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_invoices_status_idx
  ON billing_invoices (status, created_at DESC)
  WHERE status IN ('open', 'past_due', 'uncollectible');
