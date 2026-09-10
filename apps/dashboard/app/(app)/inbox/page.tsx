import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { ReplayJobProgress } from "../../_components/ReplayJobProgress";
import { loadInboxGroups } from "../../../lib/inbox";
import { requireSession } from "../../../lib/session";
import { BillingAlerts } from "./BillingAlerts";
import { PipelineIncidents } from "./PipelineIncidents";
import { InboxClient } from "./InboxClient";

export const dynamic = "force-dynamic";

/**
 * AXE-57 — inbox-zero workflow for dead letters.
 *
 * Replaces the flat "5,000 dead letters" experience with grouped
 * fingerprints + bulk retry/mute. Pairs naturally with AXE-54's
 * "Why?" explainer on the per-row investigate page.
 *
 * Page renders the groups server-side, hands them to a client
 * component for keyboard navigation + bulk actions.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const showMuted = String(params.muted ?? "") === "1";
  // ?show=resolved flips the page to an Archive view: fingerprints
  // whose dead letters have been resolved in the last 24h. Gives the
  // operator a confirmation surface after clicking Retry — the row
  // moves OUT of the active inbox and INTO this view once the replay
  // lands.
  const showResolved = String(params.show ?? "") === "resolved";
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  const groups = await loadInboxGroups(workspaceId);
  // Three slices over the same group set:
  //   - active:   has unresolved letters (count > 0), not muted
  //   - resolved: archive — no unresolved letters, but has 24h resolves
  //   - muted:    has an active mute
  const activeGroups = groups.filter((g) => g.count > 0 && g.muted_until === null);
  const resolvedGroups = groups.filter((g) => g.count === 0 && g.resolved_24h > 0);
  const mutedCount = groups.filter((g) => g.muted_until !== null).length;
  const resolvedCount = resolvedGroups.length;

  const visibleGroups = showResolved
    ? resolvedGroups
    : showMuted
      ? groups.filter((g) => g.muted_until !== null)
      : activeGroups;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Inbox"
        description="Review data flow incidents and recover failed deliveries."
        actions={
          <Link
            href="/deliveries"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            Back to Deliveries
          </Link>
        }
      />

      {/* Same live progress banner the operator sees on /deliveries — surfaces
          the "Replay all N unresolved" job here too (their "message in my
          inbox" expectation). Renders nothing when no job is active. */}
      <ReplayJobProgress workspaceId={workspaceId} />
      <PipelineIncidents workspaceId={workspaceId} canMutate={session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin"} />

      {/* Unread billing alerts (quota / payment / suspension) — the bell
          is gone, so billing surfaces here alongside dead letters. */}
      <BillingAlerts workspaceId={workspaceId} userId={session.user.id} />

      {/* Tab strip — three mutually-exclusive views. Always visible
          so the operator knows the Resolved/Muted slices exist. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link
          href="/inbox"
          prefetch={false}
          className={`rounded-md border px-2.5 py-1 ${!showResolved && !showMuted ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
        >
          Active ({activeGroups.length})
        </Link>
        <Link
          href="/inbox?show=resolved"
          prefetch={false}
          className={`rounded-md border px-2.5 py-1 ${showResolved ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
        >
          Resolved 24h ({resolvedCount})
        </Link>
        {mutedCount > 0 ? (
          <Link
            href="/inbox?muted=1"
            prefetch={false}
            className={`rounded-md border px-2.5 py-1 ${showMuted ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
          >
            Muted ({mutedCount})
          </Link>
        ) : null}
      </div>

      {visibleGroups.length === 0 ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            title={emptyTitle({ showResolved, showMuted, mutedCount })}
            body={emptyBody({ showResolved, showMuted, mutedCount })}
          />
        </section>
      ) : (
        <InboxClient
          groups={visibleGroups}
          mutedCount={mutedCount}
          showMuted={showMuted}
          showResolved={showResolved}
        />
      )}
    </>
  );
}

function emptyTitle({
  showResolved,
  showMuted,
  mutedCount,
}: {
  showResolved: boolean;
  showMuted: boolean;
  mutedCount: number;
}): string {
  if (showResolved) return "Nothing resolved in the last 24h.";
  if (showMuted) return "No muted fingerprints.";
  return mutedCount > 0 ? "Inbox zero." : "No unresolved dead letters.";
}

function emptyBody({
  showResolved,
  showMuted,
  mutedCount,
}: {
  showResolved: boolean;
  showMuted: boolean;
  mutedCount: number;
}): string {
  if (showResolved) {
    return "Retried fingerprints whose replays succeed show up here for 24h, then drop off. Click Retry on an Active row and refresh — if the replay lands, the row moves here.";
  }
  if (showMuted) {
    return "Muted fingerprints surface here. They won't reappear in Active until the mute expires.";
  }
  return mutedCount > 0
    ? `${mutedCount} fingerprint${mutedCount === 1 ? " is" : "s are"} currently muted. ${mutedCount === 1 ? "It" : "They"} won't appear here until the mute expires.`
    : "No unresolved failures are recorded here. Check data flow incidents above for sources that stopped sending.";
}
