import { Badge } from "@/components/ui/badge";
import {
  estimateInvoiceCents,
  FREE_TIER_TASK_CAP,
  PRO_INCLUDED_TASKS,
  type BillingInvoiceRow,
  type WorkspaceBillingState,
} from "../../../lib/billing/state";
import { BillingActionButtons } from "./BillingActionButtons";

export interface BillingPanelProps {
  state: WorkspaceBillingState;
  /** Whether the current user is the workspace owner — controls action buttons. */
  isOwner: boolean;
  /** Pre-checked at the route level so the panel can render an inert state on misconfig. */
  stripeConfigured: boolean;
}

export function BillingPanel({ state, isOwner, stripeConfigured }: BillingPanelProps) {
  // Comped (billing_exempt) and hand-rolled Enterprise workspaces have no
  // self-serve Stripe billing and no enforced cap (plan-state.ts deriveGate),
  // so the Pro included-threshold bar and overage warning don't apply to them.
  // Stripe-less deployments enforce no cap at all — same exclusion.
  const hasIncludedLimit = stripeConfigured && !state.billingExempt && state.plan !== "enterprise";
  const limit = state.plan === "free" ? FREE_TIER_TASK_CAP : PRO_INCLUDED_TASKS;
  const usedPct = Math.min(100, Math.round((state.tasksThisPeriod / Math.max(1, limit)) * 100));
  const overage = hasIncludedLimit ? Math.max(0, state.tasksThisPeriod - limit) : 0;
  // estimateInvoiceCents applies the Pro $20-base formula to any non-free
  // plan — only project it when a real Stripe subscription will invoice it.
  const showInvoiceEstimate =
    state.plan === "pro" && !state.billingExempt && state.stripeSubscriptionId !== null;
  const nextInvoiceCents = estimateInvoiceCents(state);

  const statusVariant: Record<typeof state.billingStatus, "default" | "secondary" | "destructive" | "outline"> = {
    ok: "secondary",
    grace: "outline",
    past_due: "destructive",
    suspended: "destructive",
    canceled: "outline",
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Plan</h2>
          <div className="flex items-center gap-2">
            <Badge className="capitalize" variant={state.plan === "free" ? "outline" : "default"}>
              {state.plan}
            </Badge>
            {state.billingExempt ? (
              // Exempt workspaces are never gated on billing_status, so a stale
              // past_due/suspended badge would be false alarm — show the truth.
              <Badge variant="secondary">managed</Badge>
            ) : (
              <Badge variant={statusVariant[state.billingStatus]}>
                {state.billingStatus.replace("_", " ")}
              </Badge>
            )}
          </div>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">{planDescription(state, stripeConfigured)}</p>

          {stripeConfigured ? (
            <BillingActionButtons
              plan={state.plan}
              isOwner={isOwner}
              billingExempt={state.billingExempt}
              hasStripeCustomer={state.stripeCustomerId !== null}
            />
          ) : (
            <p className="rounded border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Stripe is not configured on this deployment. Self-serve upgrade is disabled — contact your
              workspace owner to enable billing.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Usage this period</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Period started {state.currentPeriodStart}. Only accepted inbound events are metered.
            Destination pushes and retries are included.
          </p>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold text-foreground">
              {state.tasksThisPeriod.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              {hasIncludedLimit ? `of ${limit.toLocaleString()} included` : "no cap"}
            </span>
          </div>
          {hasIncludedLimit ? (
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div
                className={`h-full ${overage > 0 ? "bg-amber-500" : "bg-foreground"}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
          ) : null}
          {overage > 0 ? (
            <p className="text-xs text-muted-foreground">
              {overage.toLocaleString()} inbound events over the included threshold.
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-3 pt-2 text-sm md:grid-cols-2">
            <Stat
              label="Next invoice (est.)"
              value={showInvoiceEstimate ? `$${(nextInvoiceCents / 100).toFixed(2)}` : "—"}
            />
            <Stat
              label="Last reported to Stripe"
              value={
                state.reportedToStripeAt
                  ? new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(state.reportedToStripeAt)
                  : "—"
              }
            />
          </dl>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Recent invoices</h2>
        </div>
        {state.recentInvoices.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {state.recentInvoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">{formatInvoicePeriod(inv)}</span>
                  <span className="text-xs text-muted-foreground capitalize">{inv.status}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">
                    ${(inv.totalCents / 100).toFixed(2)} {inv.currency.toUpperCase()}
                  </span>
                  {inv.hostedUrl ? (
                    <a
                      className="text-xs text-primary underline-offset-2 hover:underline"
                      href={inv.hostedUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      View
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function planDescription(state: WorkspaceBillingState, stripeConfigured: boolean): string {
  if (!stripeConfigured) {
    return "Self-hosted deployment — no usage caps or charges apply.";
  }
  if (state.billingExempt) {
    return "Billing for this workspace is managed by Axel — no usage caps or charges apply.";
  }
  if (state.plan === "enterprise") {
    return "Enterprise plan — custom contract, no event cap. Billing is handled outside self-serve; contact us to make changes.";
  }
  if (state.plan === "free") {
    return `Free plan — ${FREE_TIER_TASK_CAP.toLocaleString()} inbound events per calendar month. Ingest returns 429 once the cap is reached.`;
  }
  return `Pro plan — $20/month applied as usage credit (covering about ${PRO_INCLUDED_TASKS.toLocaleString()} inbound events), then $0.015 per 1,000 inbound events. Destination pushes and retries are included.`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}

function formatInvoicePeriod(inv: BillingInvoiceRow): string {
  if (!inv.periodStart || !inv.periodEnd) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(inv.createdAt);
  }
  const start = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(inv.periodStart);
  const end = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(inv.periodEnd);
  return `${start} – ${end}`;
}
