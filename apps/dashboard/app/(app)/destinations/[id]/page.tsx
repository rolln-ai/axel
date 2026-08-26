import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { getDestinationSummary } from "../../../../lib/destination-inspect";
import { schemaFor } from "../../../../lib/destination-defaults";
import { hasClickhouseUrl } from "../../../../lib/clickhouse";
import {
  formatRelative,
  getDestinationDeliverySummary,
  getDestinationLastDelivery,
  listRecentDestinationAttempts,
} from "../../../../lib/destination-metrics";
import { DeliveryHealthCards } from "./DeliveryHealthCards";
import { RecentAttemptsLog } from "./RecentAttemptsLog";
import { Section } from "../../../_components/Section";
import { StatCard } from "../../../_components/StatCard";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";

interface RouteAttachmentRow {
  route_id: string;
  source_id: string;
  source_name: string;
  status: "active" | "disabled" | "errored";
}

/**
 * Destination overview — the landing tile for /destinations/[id].
 *
 * Keeps the page intentionally light: at-a-glance health, attached
 * routes, and recent attempts. Deeper analytics live under /health,
 * forms under /configuration, etc. — see AppNav's destination subnav.
 */
export default async function DestinationOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ attempts?: string }>;
}) {
  const { id } = await params;
  const failuresOnly = (await searchParams).attempts === "failures";
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  const [destination, attachments] = await Promise.all([
    getDestinationSummary(id, workspaceId),
    db().query<RouteAttachmentRow>(
      `SELECT r.id AS route_id, r.source_id, s.name AS source_name, r.status
         FROM route_destinations rd
         JOIN routes r ON r.id = rd.route_id
         JOIN sources s ON s.id = r.source_id
        WHERE rd.destination_id = $1 AND r.workspace_id = $2
        ORDER BY r.created_at DESC`,
      [id, workspaceId],
    ),
  ]);
  if (!destination) notFound();

  const schema = schemaFor(destination.type);

  return (
    <>
      <section className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Destination summary">
        <StatCard label="Type" value={schema.label} sub={destination.type} />
        <StatCard
          label="Routes attached"
          value={String(attachments.rows.length)}
          sub={
            attachments.rows.length === 0
              ? "no pipelines yet"
              : attachments.rows.map((a) => a.source_name).slice(0, 3).join(", ")
          }
        />
        {/* Last delivery — the operational "is this working right now" signal,
            and the most useful third highlight. Streamed (ClickHouse lookup) so
            it never blocks the header. The credential moved to the Credential
            tab, where the fingerprint + rotation live. */}
        {hasClickhouseUrl() ? (
          <Suspense fallback={<LastDeliverySkeleton />}>
            <LastDeliveryStat destinationId={destination.id} workspaceId={workspaceId} />
          </Suspense>
        ) : (
          <StatCard label="Last delivery" value="—" sub="analytics not configured" />
        )}
      </section>

      {hasClickhouseUrl() ? (
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewMetrics
            destinationId={destination.id}
            workspaceId={workspaceId}
            failuresOnly={failuresOnly}
          />
        </Suspense>
      ) : (
        <Section title="Delivery snapshot" pill="analytics not configured">
          <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
            <small className="text-sm text-muted-foreground">
              Set <code className="font-mono">CLICKHOUSE_URL</code> to surface delivery health here.
            </small>
          </div>
        </Section>
      )}

      {attachments.rows.length > 0 ? (
        <Section title="Routes using this destination" pill={`${attachments.rows.length} route${attachments.rows.length === 1 ? "" : "s"}`}>
          <ul className="divide-y divide-border text-sm">
            {attachments.rows.slice(0, 10).map((a) => (
              <li key={a.route_id} className="flex items-center justify-between py-2">
                <Link href={`/routes/${a.route_id}`} prefetch={false} className="font-mono text-foreground hover:underline">
                  {a.route_id}
                </Link>
                <span className="text-xs text-muted-foreground">
                  from <span className="font-mono">{a.source_name}</span> · {a.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

async function OverviewMetrics({
  destinationId,
  workspaceId,
  failuresOnly,
}: {
  destinationId: string;
  workspaceId: string;
  failuresOnly: boolean;
}) {
  const [summary24h, summary7d, recentAttempts] = await Promise.all([
    getDestinationDeliverySummary(workspaceId, destinationId, 24),
    getDestinationDeliverySummary(workspaceId, destinationId, 24 * 7),
    listRecentDestinationAttempts(workspaceId, destinationId, 15, {}, failuresOnly),
  ]);

  return (
    <>
      <Section title="Delivery health" pill="last 24h · last 7d">
        <DeliveryHealthCards last24h={summary24h} last7d={summary7d} />
      </Section>
      {/* On a busy destination, 15 chronological rows are all successes even
          while dead-letters accumulate — the Failures lens keeps them
          findable without leaving the page (ROL-628). */}
      <Section
        title="Recent attempts"
        pill={
          <span className="flex items-center gap-1.5">
            <AttemptsFilterLink href={`/destinations/${destinationId}`} active={!failuresOnly}>
              All
            </AttemptsFilterLink>
            <AttemptsFilterLink
              href={`/destinations/${destinationId}?attempts=failures`}
              active={failuresOnly}
            >
              Failures
            </AttemptsFilterLink>
          </span>
        }
      >
        <RecentAttemptsLog
          rows={recentAttempts}
          emptyMessage={
            failuresOnly ? "No failed attempts logged for this destination." : undefined
          }
        />
        <div className="text-right">
          <Link
            href={`/destinations/${destinationId}/health`}
            prefetch={false}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Failure breakdown by error type →
          </Link>
        </div>
      </Section>
    </>
  );
}

function AttemptsFilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "border-foreground/30 bg-muted text-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

async function LastDeliveryStat({
  destinationId,
  workspaceId,
}: {
  destinationId: string;
  workspaceId: string;
}) {
  const { lastAttemptAt } = await getDestinationLastDelivery(workspaceId, destinationId);
  return (
    <StatCard
      label="Last delivery"
      value={lastAttemptAt ? formatRelative(lastAttemptAt) : "None yet"}
      sub={lastAttemptAt ? "most recent delivery attempt" : "no deliveries to this destination yet"}
    />
  );
}

function LastDeliverySkeleton() {
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Last delivery
      </span>
      <Skeleton className="mt-0.5 h-6 w-24" />
      <Skeleton className="mt-1 h-3 w-36" />
    </article>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mt-6 space-y-6">
      <Skeleton className="h-44 w-full rounded-lg" />
      <Skeleton className="h-60 w-full rounded-lg" />
    </div>
  );
}
