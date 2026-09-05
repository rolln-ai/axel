-- Migration 0057: billing-exempt workspaces
--
-- Super-admin flag that comps a workspace: it never requires a payment method,
-- is never quota-blocked (free-tier task cap), and is never auto-suspended for
-- non-payment. The ingest billing gate (apps/dashboard/lib/billing/plan-state.ts
-- deriveGate) short-circuits to 'accept' when this is set, so enforcement is
-- lifted regardless of plan / billing_status / usage.
--
-- Used for internal + test spaces (e.g. unfiltered-dev) that should be usable
-- without a card. Toggled from the super-admin console (/admin/workspaces).
--
-- Matching declarative definition lives in infra/postgres/schema.sql.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;
