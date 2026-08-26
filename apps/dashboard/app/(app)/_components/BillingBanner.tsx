import Link from "next/link";
import { deriveBillingBannerNotice } from "../../../lib/billing/banner-notice";
import { loadWorkspaceBillingState } from "../../../lib/billing/state";
import { hasStripeConfigured } from "../../../lib/billing/stripe-client";

/**
 * Workspace-wide billing banner shown above (app) page content. Hidden
 * for healthy workspaces so it doesn't add noise. The branch matrix —
 * suspension, cancellation, dunning, free-tier cap, and the
 * billing_exempt short-circuit for comped workspaces — lives in
 * lib/billing/banner-notice.ts (deriveBillingBannerNotice) so it stays
 * unit-testable; this component just renders the outcome.
 *
 * Rendered as a Server Component so we hit Postgres once per request
 * (state.ts is already used by /settings?tab=billing — the same cached
 * pool call applies). Failure to load billing state is non-fatal: we
 * return null and let the page render without the banner.
 */
export async function BillingBanner({ workspaceId }: { workspaceId: string }) {
  // Stripe-less deployments enforce no gates (plan-state.ts deriveGate), so
  // every notice below would describe a block that never happens.
  if (!hasStripeConfigured()) return null;
  let state: Awaited<ReturnType<typeof loadWorkspaceBillingState>>;
  try {
    state = await loadWorkspaceBillingState(workspaceId);
  } catch {
    return null;
  }

  const notice = deriveBillingBannerNotice(state);
  if (!notice) return null;
  return <Notice tone={notice.tone} title={notice.title} body={notice.body} cta={notice.cta} />;
}

function Notice({
  tone,
  title,
  body,
  cta,
}: {
  tone: "warning" | "destructive";
  title: string;
  body: string;
  cta: string;
}) {
  const classes =
    tone === "destructive"
      ? "border-red-500/60 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
      : "border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200";
  return (
    <div className={`mb-4 flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${classes}`}>
      <div>
        <strong className="font-semibold">{title}.</strong> {body}
      </div>
      <Link
        href="/settings?tab=billing"
        className="rounded border border-current px-2.5 py-1 text-xs font-medium hover:opacity-80"
      >
        {cta}
      </Link>
    </div>
  );
}
