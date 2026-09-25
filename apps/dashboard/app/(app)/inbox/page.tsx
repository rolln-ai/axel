import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { ReplayJobProgress } from "../../_components/ReplayJobProgress";
import { loadInboxGroups } from "../../../lib/inbox";
import { requireSession } from "../../../lib/session";
import { BillingAlerts } from "./BillingAlerts";
import { Incidents } from "./Incidents";
import { InboxClient } from "./InboxClient";

export const dynamic = "force-dynamic";

/**
 * Inbox: one list of things that need attention, one button each.
 *
 * Each open incident is a card with "Fix now". Failed-delivery groups are
 * folded under the incident that owns them; only groups no incident covers
 * get their own list. Billing notices sit at the bottom. The resolved and
 * muted archives stay reachable from the footer links.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const showMuted = String(params.muted ?? "") === "1";
  const showResolved = String(params.show ?? "") === "resolved";
  const showIgnored = String(params.show ?? "") === "ignored";
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  const groups = await loadInboxGroups(workspaceId);
  const activeGroups = groups.filter((g) => g.count > 0 && g.muted_until === null);
  const resolvedGroups = groups.filter((g) => g.count === 0 && g.resolved_24h > 0);
  const mutedGroups = groups.filter((g) => g.muted_until !== null);

  const header = (
    <PageHeader
      eyebrow="Workspace"
      title="Inbox"
      description="Anything that needs your attention, with one button to fix it."
      actions={
        <Link href="/deliveries" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" />
          Back to Deliveries
        </Link>
      }
    />
  );

  if (showIgnored) {
    const { node } = await Incidents({ workspaceId, canMutate, groups: activeGroups, view: "ignored" });
    return (
      <>
        {header}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <Link href="/inbox" prefetch={false} className="rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground hover:text-foreground">
            ← Needs attention
          </Link>
          <span className="rounded-md border border-foreground bg-foreground px-2.5 py-1 text-background">Ignored</span>
        </div>
        {node}
      </>
    );
  }

  if (showResolved || showMuted) {
    const visible = showResolved ? resolvedGroups : mutedGroups;
    return (
      <>
        {header}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <Link href="/inbox" prefetch={false} className="rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground hover:text-foreground">
            ← Needs attention
          </Link>
          <span className="rounded-md border border-foreground bg-foreground px-2.5 py-1 text-background">
            {showResolved ? `Fixed in the last 24h (${resolvedGroups.length})` : `Muted (${mutedGroups.length})`}
          </span>
        </div>
        {visible.length === 0 ? (
          <section className="rounded-lg border border-border bg-card p-8">
            <EmptyState
              title={showResolved ? "Nothing fixed in the last 24h." : "Nothing muted."}
              body={showResolved ? "Failed deliveries that a fix replays successfully show up here for 24 hours." : "Muted groups stay out of the main list until the mute expires."}
            />
          </section>
        ) : (
          <InboxClient groups={visible} mutedCount={mutedGroups.length} showMuted={showMuted} showResolved={showResolved} />
        )}
      </>
    );
  }

  // Groups covered by an open incident render under it; the rest get their own list.
  const { node: incidents, unassigned, ignored } = await Incidents({ workspaceId, canMutate, groups: activeGroups });
  // Muted groups still belong to their incident (Fix now lifts the mute), but
  // never get their own list.
  const leftovers = unassigned.filter((g) => g.muted_until === null);

  return (
    <>
      {header}
      <ReplayJobProgress workspaceId={workspaceId} />
      {incidents}

      {leftovers.length > 0 ? (
        <section className="mb-6 space-y-2" aria-label="Other failed deliveries">
          <h2 className="text-sm font-semibold">Other failed deliveries</h2>
          <p className="text-xs text-muted-foreground">Failures not tied to an open incident. Retry replays the kept events.</p>
          <InboxClient groups={leftovers} mutedCount={mutedGroups.length} showMuted={false} showResolved={false} />
        </section>
      ) : null}

      <BillingAlerts workspaceId={workspaceId} userId={session.user.id} />

      {resolvedGroups.length > 0 || mutedGroups.length > 0 || ignored > 0 ? (
        <p className="mt-6 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {ignored > 0 ? (
            <Link href="/inbox?show=ignored" prefetch={false} className="hover:text-foreground">
              Ignored ({ignored})
            </Link>
          ) : null}
          {resolvedGroups.length > 0 ? (
            <Link href="/inbox?show=resolved" prefetch={false} className="hover:text-foreground">
              Fixed in the last 24h ({resolvedGroups.length})
            </Link>
          ) : null}
          {mutedGroups.length > 0 ? (
            <Link href="/inbox?muted=1" prefetch={false} className="hover:text-foreground">
              Muted ({mutedGroups.length})
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
