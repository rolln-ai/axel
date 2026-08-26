import "server-only";
import type Stripe from "stripe";
import type { Queryable } from "../db";
import { db } from "../db";
import { captureServerEvent } from "../posthog-server";
import { computePlanState, pushPlanStates } from "./plan-state";

/**
 * Stripe event types we forward to PostHog, mapped to product event names.
 * Only the lifecycle moments worth a funnel — we skip high-frequency
 * `customer.subscription.updated` and `invoice.paid` to avoid analytics noise.
 */
const POSTHOG_BILLING_EVENTS: Record<string, string> = {
  "customer.subscription.created": "subscription started",
  "customer.subscription.deleted": "subscription canceled",
  "invoice.payment_failed": "invoice payment failed",
};

/**
 * Stripe webhook idempotent processor.
 *
 * Every delivery from Stripe is INSERTed into `billing_events` by
 * `event.id` first. A repeat delivery (Stripe retries on 5xx, and
 * sometimes ships duplicates even on 2xx) hits the PK conflict and
 * we exit early — no double-application of subscription state.
 *
 * The events we care about and what they change:
 *
 *   customer.subscription.created/updated
 *     → workspaces.stripe_subscription_id, plan='pro',
 *       billing_status (derived from subscription.status),
 *       billing_period_start/end mirrored from
 *       subscription.current_period_*
 *
 *   customer.subscription.deleted
 *     → plan='free', stripe_subscription_id=NULL,
 *       billing_status='canceled', billing_period_*=NULL
 *
 *   invoice.created / invoice.finalized / invoice.paid /
 *   invoice.payment_failed / invoice.voided
 *     → upsert into billing_invoices; on payment_failed, flip the
 *       workspace's billing_status to 'past_due' (Stripe Smart
 *       Retries continues dunning; the next paid/finalized resets it).
 *
 * Anything else is journaled (so /admin/billing/webhooks can show
 * it) and treated as a no-op.
 */

export interface WebhookProcessResult {
  /** True when we processed this event (or no-op'd a known type). */
  processed: boolean;
  /** True when this event.id was already in `billing_events` and we exited early. */
  alreadySeen: boolean;
  /** Event type, copied through for the route's response body. */
  type: string;
}

export async function processStripeWebhook(
  event: Stripe.Event,
  deps: { pg?: Queryable } = {},
): Promise<WebhookProcessResult> {
  const pg = deps.pg ?? db();

  const workspaceId = await resolveWorkspaceId(event, pg);

  const insert = await pg.query<{ id: string }>(
    `INSERT INTO billing_events (id, type, workspace_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, workspaceId, JSON.stringify(event)],
  );

  if (insert.rows.length === 0) {
    // The event id is already journaled. Distinguish a genuine duplicate from
    // a prior attempt that failed mid-apply: only the latter has
    // processed_at IS NULL (the catch below intentionally leaves it unset).
    // Re-applying is safe because every apply* helper is idempotent
    // (UPDATE-by-customer / upsert-by-invoice-id), so we let Stripe's retry
    // finish the job instead of permanently dropping the state change.
    const prior = await pg.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM billing_events WHERE id = $1`,
      [event.id],
    );
    const priorRow = prior.rows[0];
    if (!priorRow || priorRow.processed_at != null) {
      return { processed: false, alreadySeen: true, type: event.type };
    }
    // else: incomplete prior attempt — fall through and re-apply.
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await applyStripeSubscription(pg, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await applySubscriptionDeleted(
          pg,
          event.data.object as Stripe.Subscription,
        );
        break;
      case "invoice.created":
      case "invoice.finalized":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.voided":
        await applyInvoice(pg, event.type, event.data.object as Stripe.Invoice);
        break;
      default:
        // Journaled above; nothing to do.
        break;
    }
    await pg.query(
      `UPDATE billing_events SET processed_at = now(), error = NULL WHERE id = $1`,
      [event.id],
    );
    // Plan state may have changed (subscription created/deleted →
    // plan flip; invoice payment_failed/paid → billing_status flip).
    // Push fresh state to the ingest worker so enforcement doesn't
    // wait for the next hourly rollup. Best-effort; an error here
    // would cause Stripe to retry the whole webhook, double-applying
    // state — instead we log and let the next rollup catch up.
    if (workspaceId) {
      try {
        const planState = await computePlanState(workspaceId, { pg });
        if (planState) await pushPlanStates([planState]);
      } catch (planErr) {
        console.error(`[stripe-webhook] plan-state push failed for ${workspaceId}:`, planErr);
      }

      // Backend-side billing analytics. There's no logged-in user on a webhook,
      // so we attribute the event to the workspace via its group and use the
      // workspace id as the distinct id. Best-effort; never blocks the 200.
      const phEvent = POSTHOG_BILLING_EVENTS[event.type];
      if (phEvent) {
        await captureServerEvent({
          distinctId: workspaceId,
          event: phEvent,
          properties: { stripe_event_type: event.type },
          groups: { workspace: workspaceId },
        });
      }
    }
    return { processed: true, alreadySeen: false, type: event.type };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the error but DO NOT set processed_at — leaving it NULL lets the
    // next Stripe retry (we surface this as a 500) re-enter the apply path
    // above instead of short-circuiting as an "already seen" duplicate and
    // permanently dropping the state change.
    await pg.query(
      `UPDATE billing_events SET error = $2 WHERE id = $1`,
      [event.id, message.slice(0, 500)],
    );
    throw err;
  }
}

async function resolveWorkspaceId(
  event: Stripe.Event,
  pg: Queryable,
): Promise<string | null> {
  const customerId = extractCustomerId(event);
  if (!customerId) return null;
  const { rows } = await pg.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId],
  );
  return rows[0]?.id ?? null;
}

function extractCustomerId(event: Stripe.Event): string | null {
  // Subscription + invoice objects both carry a `customer` field
  // (string or expanded object). Other event shapes either also have
  // `.customer` or do not target a workspace.
  const obj = event.data.object as { customer?: unknown };
  const c = obj.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && "id" in c && typeof (c as { id: unknown }).id === "string") {
    return (c as { id: string }).id;
  }
  return null;
}

/**
 * Mirror a live Stripe subscription onto its workspace.
 *
 * Exported so the post-Checkout return path can perform the same idempotent
 * synchronization before the webhook arrives. Stripe webhooks remain the
 * authoritative retryable path; this closes only the user-visible redirect
 * race.
 */
export async function applyStripeSubscription(
  pg: Queryable,
  sub: Stripe.Subscription,
): Promise<void> {
  const status = subscriptionStatusToBillingStatus(sub.status);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Stripe moved current_period_start/end from the top-level Subscription
  // object onto each SubscriptionItem in API 2024-09-30+ (current pinned
  // version 2026-04-22.dahlia). Prefer the item-level fields; fall back
  // to top-level for older test fixtures or legacy payloads.
  const item = sub.items?.data?.[0] as
    | { current_period_start?: number | null; current_period_end?: number | null }
    | undefined;
  const periodStart = readUnixSeconds(
    item?.current_period_start
      ?? (sub as unknown as { current_period_start?: number | null }).current_period_start,
  );
  const periodEnd = readUnixSeconds(
    item?.current_period_end
      ?? (sub as unknown as { current_period_end?: number | null }).current_period_end,
  );

  await pg.query(
    `UPDATE workspaces
        SET plan = 'pro',
            stripe_subscription_id = $2,
            billing_status = $3,
            billing_period_start = $4,
            billing_period_end = $5
      WHERE stripe_customer_id = $1`,
    [customerId, sub.id, status, periodStart, periodEnd],
  );
}

async function applySubscriptionDeleted(
  pg: Queryable,
  sub: Stripe.Subscription,
): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Per the pricing-page lifecycle: cancellation downgrades to free
  // immediately on customer.subscription.deleted (Stripe fires that
  // at the end of the paid period, so we are not cutting service
  // mid-period). Keep stripe_customer_id so the user can re-upgrade
  // without re-creating their Customer object.
  //
  // billing_status MUST be 'ok' here, not 'canceled': this is a graceful
  // end-of-period downgrade to the free tier, and deriveGate() maps 'canceled'
  // to reject_suspended regardless of plan — so 'canceled' would 402 every
  // ingest for an ex-Pro workspace that intends to keep using the free tier,
  // with no recovery short of re-subscribing. Hard cancellations (Stripe
  // subscription.status = canceled / incomplete_expired) flow through
  // applySubscription → subscriptionStatusToBillingStatus instead and stay
  // suspended; this handler is only the clean end-of-term path.
  await pg.query(
    `UPDATE workspaces
        SET plan = 'free',
            stripe_subscription_id = NULL,
            billing_status = 'ok',
            billing_period_start = NULL,
            billing_period_end = NULL
      WHERE stripe_customer_id = $1 AND stripe_subscription_id = $2`,
    [customerId, sub.id],
  );
}

async function applyInvoice(
  pg: Queryable,
  eventType: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return;

  const { rows } = await pg.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId],
  );
  const workspaceId = rows[0]?.id;
  if (!workspaceId) return; // Customer not bound to a workspace yet.

  // Period for line item — Stripe sets invoice.period_start/end on
  // subscription invoices; fall back to created if absent.
  const periodStart = readUnixSeconds(invoice.period_start);
  const periodEnd = readUnixSeconds(invoice.period_end);

  await pg.query(
    `INSERT INTO billing_invoices
       (id, workspace_id, status, total_cents, currency,
        period_start, period_end, hosted_url, pdf_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           total_cents = EXCLUDED.total_cents,
           currency = EXCLUDED.currency,
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           hosted_url = COALESCE(EXCLUDED.hosted_url, billing_invoices.hosted_url),
           pdf_url = COALESCE(EXCLUDED.pdf_url, billing_invoices.pdf_url),
           updated_at = now()`,
    [
      invoice.id,
      workspaceId,
      invoice.status ?? "open",
      invoice.total ?? 0,
      invoice.currency ?? "usd",
      periodStart,
      periodEnd,
      invoice.hosted_invoice_url ?? null,
      invoice.invoice_pdf ?? null,
    ],
  );

  if (eventType === "invoice.payment_failed") {
    await pg.query(
      `UPDATE workspaces
          SET billing_status = 'past_due'
        WHERE stripe_customer_id = $1
          AND billing_status NOT IN ('suspended', 'canceled')`,
      [customerId],
    );
  } else if (eventType === "invoice.paid") {
    // A successful payment clears a dunning state. Include 'canceled' so a
    // re-subscription invoice also recovers a hard-canceled workspace (the
    // end-of-period downgrade now lands on 'ok', so in practice this resets
    // the subscription.status=canceled path). 'suspended' stays sticky until
    // applySubscription re-derives it from the live subscription.
    await pg.query(
      `UPDATE workspaces
          SET billing_status = 'ok'
        WHERE stripe_customer_id = $1
          AND billing_status IN ('past_due', 'canceled')`,
      [customerId],
    );
  }
}

function subscriptionStatusToBillingStatus(
  status: Stripe.Subscription.Status,
): "ok" | "past_due" | "grace" | "suspended" | "canceled" {
  switch (status) {
    case "active":
    case "trialing":
      return "ok";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "suspended";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    case "paused":
      return "grace";
    default:
      return "ok";
  }
}

function readUnixSeconds(input: unknown): Date | null {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return null;
  }
  return new Date(input * 1000);
}
