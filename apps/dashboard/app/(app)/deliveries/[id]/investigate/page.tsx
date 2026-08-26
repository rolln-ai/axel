import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import {
  ArrowLeft,
  AlertTriangle,
  ShieldCheck,
  Wand2,
  ArrowRight,
  Layers,
  RotateCcw,
  Waypoints,
  Server,
  ShieldAlert,
  PauseCircle,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "../../../../../lib/db";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { requireSession } from "../../../../../lib/session";
import { findActiveDataContractForSource } from "../../../../../lib/data-contracts/repository";
import {
  explainFailure,
  previewPatch,
  type FailureContext,
  type ProposedPatch,
} from "../../../../../lib/data-contracts/explain";
import { sampleSourceEvents } from "../../../../../lib/data-contracts/sampler";
import { fetchPayloadForR2Key } from "../../../../../lib/sample-payload";
import type {
  GeneratedFilter,
  GeneratedTransform,
} from "../../../../../lib/data-contracts/codegen";
import type { InferredDataContract } from "../../../../../lib/data-contracts/inference";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "../../../../_components/LocalTime";
import { ReplayStateBadge } from "../../../../_components/StatusBadges";
import { InvestigationApprovalForm } from "./InvestigationApprovalForm";
import { PatchDiff, BeforeAfter } from "./PatchDiff";
import { AiExplainerCard } from "./AiExplainerCard";
import { InvestigationReplayAllButton } from "./InvestigationReplayAllButton";
import { InvestigationArchiveButton } from "./InvestigationArchiveButton";
import { RevealPayloadPanel } from "./RevealPayloadPanel";
import {
  getInvestigationReplayJob,
  replayJobProgress,
  type ActiveReplayJob,
} from "../../../../../lib/replay-jobs";
import { ReplayJobProgressCard } from "../../../../_components/ReplayJobProgressCard";
import { dataTypeRepairFor, type DeadLetterRepair } from "../../../../../lib/dead-letter-repair";

export const dynamic = "force-dynamic";
// Explain involves an LLM call + R2 fetches + ClickHouse + Postgres.
// The default per-page limit could clip on slow LLM responses.
export const maxDuration = 120;

interface DeadLetterFull {
  id: string;
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  destination_id: string | null;
  r2_key: string;
  reason: string;
  message: string;
  errored_at: string;
  resolved_at: string | null;
  ai_summary: string | null;
  ai_suggested_action: string | null;
  ai_summarized_at: string | null;
}

export default async function InvestigateDeadLetterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  // Same gate as /deliveries: archive + bulk replay are owner/admin-only, so
  // hide the buttons for member/viewer instead of letting them click through
  // the destructive confirm and only then hit the server-side rejection.
  const canReplay =
    session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  const dlResult = await db().query<DeadLetterFull>(
    `SELECT id::text         AS id,
            workspace_id::text AS workspace_id,
            event_id,
            source_id,
            route_id,
            NULLIF(destination_id, '') AS destination_id,
            r2_key,
            reason,
            message,
            errored_at::text AS errored_at,
            resolved_at::text AS resolved_at,
            ai_summary,
            ai_suggested_action,
            ai_summarized_at::text AS ai_summarized_at
       FROM dead_letters
      WHERE id = $1::bigint AND workspace_id = $2
      LIMIT 1`,
    [id, workspaceId],
  );
  const dl = dlResult.rows[0];
  if (!dl) notFound();
  const repair = dataTypeRepairFor({
    reason: dl.reason,
    message: dl.message,
    routeId: dl.route_id,
    destinationId: dl.destination_id,
  });

  const mapWithVersionPromise = findActiveDataContractForSource(workspaceId, dl.source_id);
  const relatedPromise = findRelatedDeadLetters(workspaceId, dl.source_id, dl.reason, dl.id);
  const replaysPromise = findReplaysForEvent(workspaceId, dl.event_id);
  const replayJobPromise = getInvestigationReplayJob(workspaceId, dl.source_id, dl.reason);

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex flex-col gap-1 min-w-0">
          <Link
            href="/deliveries"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            Back to Deliveries
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Investigate failure
          </h1>
          <small className="font-mono text-xs text-muted-foreground">
            event {dl.event_id} • route {dl.route_id || "(none)"}
          </small>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant="destructive">{dl.reason}</Badge>
          <span className="text-xs text-muted-foreground">
            <LocalTime value={dl.errored_at} />
          </span>
        </div>
      </div>

      <AiExplainerCard
        deadLetterId={dl.id}
        initialSummary={dl.ai_summary}
        initialSuggestedAction={dl.ai_suggested_action}
        initialSummarizedAt={dl.ai_summarized_at}
      />

      <Suspense fallback={<SectionSkeleton title="What we know" />}>
        <FailureSummarySection dl={dl} workspaceId={workspaceId} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Replays" />}>
        <ReplaysSection eventId={dl.event_id} replays={replaysPromise} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Related failures" />}>
        <RelatedFailuresSection
          deadLetterId={dl.id}
          sourceId={dl.source_id}
          reason={dl.reason}
          anchorResolved={Boolean(dl.resolved_at)}
          related={relatedPromise}
          replayJob={replayJobPromise}
          repair={repair}
          canReplay={canReplay}
        />
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Patch proposal" />}>
        <DataContractInvestigationSection
          dl={dl}
          mapWithVersion={mapWithVersionPromise}
        />
      </Suspense>
    </>
  );
}

// What the failure was actually for. A dead-letter row knows route_id (now
// often populated, post-0049) and — for per-destination failures —
// destination_id. We hydrate those into something the operator can act on:
// the route's status, and the destination's name/type/endpoint + live health
// (circuit breaker, paused) so "debug the destination problem" has an answer.
interface DestinationTarget {
  id: string;
  name: string;
  type: string;
  status: "active" | "disabled";
  endpoint: string | null;
  circuit_state: "closed" | "open" | "half_open" | "disabled";
  delivery_paused: boolean;
}

interface FailureTargets {
  route: { id: string; status: string } | null;
  routeMissing: boolean; // route_id set but the route no longer exists
  destination: DestinationTarget | null; // the exact destination that failed
  attached: DestinationTarget[]; // fallback: destinations the route fans out to
}

// `delivery_overloaded` / circuit-breaker sheds are Axel-internal backpressure
// returned by our own delivery-service, not an error from the destination.
function isInternalShed(dl: DeadLetterFull): boolean {
  return (
    dl.reason === "router_processing_failed" &&
    /delivery_overloaded|breaker_open_cooldown_active|breaker_half_open_test_failed/.test(
      dl.message,
    )
  );
}

function destinationEndpoint(
  _type: string,
  config: Record<string, unknown>,
): string | null {
  const url = config?.url;
  if (typeof url === "string" && url.length > 0) return url;
  // Non-HTTP destinations don't have a URL; surface the most identifying
  // config field so the operator still knows where it was headed.
  for (const key of ["table", "collection", "bucket", "database", "host", "warehouse", "path"]) {
    const v = config?.[key];
    if (typeof v === "string" && v.length > 0) return `${key}: ${v}`;
  }
  return null;
}

async function loadFailureTargets(
  dl: DeadLetterFull,
  workspaceId: string,
): Promise<FailureTargets> {
  const routeId = dl.route_id && dl.route_id.length > 0 ? dl.route_id : null;
  const destinationId = dl.destination_id && dl.destination_id.length > 0 ? dl.destination_id : null;

  const [routeRow, summary] = await Promise.all([
    routeId
      ? db()
          .query<{ id: string; status: string }>(
            `SELECT id, status FROM routes WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
            [routeId, workspaceId],
          )
          .then((r) => r.rows[0] ?? null)
          .catch(() => null)
      : Promise.resolve(null),
    destinationId
      ? getDestinationSummary(destinationId, workspaceId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const destination: DestinationTarget | null = summary
    ? {
        id: summary.id,
        name: summary.name,
        type: summary.type,
        status: summary.status,
        endpoint: destinationEndpoint(summary.type, summary.config),
        circuit_state: summary.circuit_state,
        delivery_paused: summary.delivery_paused,
      }
    : null;

  // Only fall back to "every destination this route targets" when we don't
  // have the exact one. A route can fan out to several, so list them.
  let attached: DestinationTarget[] = [];
  if (!destination && routeId) {
    const res = await db()
      .query<{
        id: string;
        name: string | null;
        type: string;
        status: "active" | "disabled";
        config: Record<string, unknown>;
        circuit_state: "closed" | "open" | "half_open" | "disabled";
        delivery_paused: boolean;
      }>(
        `SELECT d.id, d.name, d.type, d.status, d.config,
                d.circuit_state, d.delivery_paused
           FROM route_destinations rd
           JOIN destinations d ON d.id = rd.destination_id
          WHERE rd.route_id = $1 AND d.workspace_id = $2
          ORDER BY d.name NULLS LAST, d.id
          LIMIT 10`,
        [routeId, workspaceId],
      )
      .catch(() => ({ rows: [] as never[] }));
    attached = res.rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      type: r.type,
      status: r.status,
      endpoint: destinationEndpoint(r.type, r.config),
      circuit_state: r.circuit_state,
      delivery_paused: r.delivery_paused,
    }));
  }

  return {
    route: routeRow,
    routeMissing: routeId !== null && routeRow === null,
    destination,
    attached,
  };
}

async function FailureSummarySection({
  dl,
  workspaceId,
}: {
  dl: DeadLetterFull;
  workspaceId: string;
}) {
  const targets = await loadFailureTargets(dl, workspaceId).catch(() => ({
    route: null,
    routeMissing: false,
    destination: null,
    attached: [] as DestinationTarget[],
  }));
  return <FailureSummaryCard dl={dl} targets={targets} />;
}

function DestinationHealthBadges({ dest }: { dest: DestinationTarget }) {
  return (
    <>
      {dest.status === "disabled" ? (
        <Badge variant="outline" className="ml-1">disabled</Badge>
      ) : null}
      {dest.circuit_state !== "closed" ? (
        <Badge variant="destructive" className="ml-1">
          <ShieldAlert className="mr-0.5 size-3" />
          breaker {dest.circuit_state}
        </Badge>
      ) : null}
      {dest.delivery_paused ? (
        <Badge variant="destructive" className="ml-1">
          <PauseCircle className="mr-0.5 size-3" />
          paused
        </Badge>
      ) : null}
    </>
  );
}

function DestinationLine({ dest }: { dest: DestinationTarget }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Server className="size-3 text-muted-foreground" />
        <Link
          href={`/destinations/${dest.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {dest.name}
        </Link>
        <Badge variant="secondary">{dest.type}</Badge>
        <DestinationHealthBadges dest={dest} />
      </div>
      {dest.endpoint ? (
        <span className="break-all pl-[1.125rem] font-mono text-[10px] text-muted-foreground">
          {dest.endpoint}
        </span>
      ) : null}
    </div>
  );
}

function FailureSummaryCard({
  dl,
  targets,
}: {
  dl: DeadLetterFull;
  targets: FailureTargets;
}) {
  const shed = isInternalShed(dl);
  const repair = dataTypeRepairFor({
    reason: dl.reason,
    message: dl.message,
    routeId: dl.route_id,
    destinationId: dl.destination_id,
  });
  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
        <AlertTriangle className="size-3.5 text-destructive" /> What we know
      </h2>
      <dl className="grid gap-x-4 gap-y-1.5 text-xs md:grid-cols-[auto_1fr] md:items-baseline">
        <dt className="text-muted-foreground">Source</dt>
        <dd>
          <Link
            href={`/sources/${dl.source_id}`}
            className="font-mono text-foreground hover:underline"
          >
            {dl.source_id}
          </Link>
        </dd>

        <dt className="text-muted-foreground">Route</dt>
        <dd>
          {targets.route ? (
            <span className="inline-flex items-center gap-1.5">
              <Waypoints className="size-3 text-muted-foreground" />
              <Link
                href={`/routes/${targets.route.id}`}
                className="font-mono text-foreground hover:underline"
              >
                {targets.route.id}
              </Link>
              <Badge variant={targets.route.status === "active" ? "secondary" : "outline"}>
                {targets.route.status}
              </Badge>
            </span>
          ) : targets.routeMissing ? (
            <span className="font-mono text-muted-foreground">
              {dl.route_id} <span className="font-sans italic">(route deleted)</span>
            </span>
          ) : (
            <span className="text-muted-foreground italic">
              not recorded — failed before a route was selected
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Destination</dt>
        <dd>
          {targets.destination ? (
            <DestinationLine dest={targets.destination} />
          ) : targets.attached.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground">
                Not recorded for this failure. This route targets:
              </span>
              {targets.attached.map((d) => (
                <DestinationLine key={d.id} dest={d} />
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground italic">
              {shed
                ? "never reached — request was shed before a destination was contacted"
                : "not recorded"}
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Reason</dt>
        <dd>
          <Badge variant="destructive">{dl.reason}</Badge>
        </dd>
        {dl.message ? (
          <>
            <dt className="text-muted-foreground">Connector message</dt>
            <dd>
              <pre className="max-h-40 overflow-auto rounded-sm bg-muted p-2 font-mono text-[10px]">
                {dl.message}
              </pre>
            </dd>
          </>
        ) : null}
      </dl>

      <RevealPayloadPanel deadLetterId={dl.id} />

      {shed ? (
        <p className="mt-3 rounded-sm border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-foreground">
          <span className="font-semibold">Not a destination error.</span> This
          request was shed by Axel&rsquo;s delivery-service before the
          destination was contacted — either its inbound capacity gate
          (<span className="font-mono">MAX_DELIVER_INFLIGHT</span>) or an open
          circuit breaker. The lever is delivery-service capacity / the
          destination&rsquo;s recent latency, not a 503 returned by the
          destination itself.
        </p>
      ) : null}
      {repair ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <Wrench className="size-3.5" /> {repair.title}
          </p>
          <p className="mt-1 text-muted-foreground">{repair.detail}</p>
          {repair.href ? (
            <Button asChild variant="outline" size="sm" className="mt-2 h-7">
              <Link href={repair.href}>{repair.actionLabel} <ArrowRight className="ml-1 size-3" /></Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface RelatedDeadLetter {
  id: string;
  event_id: string;
  route_id: string | null;
  errored_at: string;
  message: string | null;
}

const RELATED_PREVIEW_LIMIT = 10;

async function findRelatedDeadLetters(
  workspaceId: string,
  sourceId: string,
  reason: string,
  excludeId: string,
): Promise<{ rows: RelatedDeadLetter[]; total: number }> {
  const [rowsResult, countResult] = await Promise.all([
    db().query<RelatedDeadLetter>(
      `SELECT id::text         AS id,
              event_id,
              route_id,
              errored_at::text AS errored_at,
              message
         FROM dead_letters
        WHERE workspace_id = $1
          AND source_id = $2
          AND reason = $3
          AND id <> $4::bigint
          AND resolved_at IS NULL
        ORDER BY errored_at DESC
        LIMIT $5`,
      [workspaceId, sourceId, reason, excludeId, RELATED_PREVIEW_LIMIT],
    ),
    db().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM dead_letters
        WHERE workspace_id = $1
          AND source_id = $2
          AND reason = $3
          AND id <> $4::bigint
          AND resolved_at IS NULL`,
      [workspaceId, sourceId, reason, excludeId],
    ),
  ]);

  return {
    rows: rowsResult.rows,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

function RelatedFailuresCard({
  deadLetterId,
  sourceId,
  reason,
  anchorResolved,
  related,
  replayJob,
  repair,
  canReplay,
}: {
  deadLetterId: string;
  sourceId: string;
  reason: string;
  anchorResolved: boolean;
  related: { rows: RelatedDeadLetter[]; total: number };
  replayJob: ActiveReplayJob | null;
  repair: DeadLetterRepair | null;
  canReplay: boolean;
}) {
  const viewAllHref = `/deliveries?status=failed&source=${encodeURIComponent(
    sourceId,
  )}&q=${encodeURIComponent(reason)}`;
  const unresolvedCount = related.total + (anchorResolved ? 0 : 1);
  const progress = replayJob ? replayJobProgress(replayJob) : null;

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <h2 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Layers className="size-3.5 text-muted-foreground" /> Related failures
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({unresolvedCount.toLocaleString("en-US")} unresolved on this source with{" "}
            <Badge variant="destructive">{reason}</Badge>)
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {canReplay && unresolvedCount > 0 ? (
            <>
              {!repair ? (
                <InvestigationReplayAllButton
                  deadLetterId={deadLetterId}
                  unresolvedCount={unresolvedCount}
                />
              ) : null}
              <InvestigationArchiveButton
                deadLetterId={deadLetterId}
                unresolvedCount={unresolvedCount}
              />
            </>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href={viewAllHref}>
              View all <ArrowRight className="ml-1 size-3" />
            </Link>
          </Button>
        </div>
      </div>
      {progress && replayJob ? (
        <ReplayJobProgressCard
          className="mb-3"
          title="Replaying related failures"
          progress={{
            state: replayJob.state,
            ...progress,
            startedAt: replayJob.started_at,
            finishedAt: replayJob.finished_at,
          }}
        />
      ) : null}
      {related.rows.length > 0 ? (
        <ul className="divide-y divide-border text-xs">
          {related.rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-1.5">
              <Link
                href={`/deliveries/${row.id}/investigate`}
                className="min-w-0 flex-1 truncate font-mono text-foreground hover:underline"
              >
                {row.event_id}
              </Link>
              {row.message ? (
                <span className="hidden min-w-0 flex-1 truncate text-muted-foreground md:inline">
                  {row.message}
                </span>
              ) : null}
              <span className="shrink-0 text-muted-foreground">
                <LocalTime value={row.errored_at} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {unresolvedCount === 0
            ? "All failures in this group are resolved."
            : "This is the only unresolved failure in the group."}
        </p>
      )}
    </section>
  );
}

async function RelatedFailuresSection({
  deadLetterId,
  sourceId,
  reason,
  anchorResolved,
  related,
  replayJob,
  repair,
  canReplay,
}: {
  deadLetterId: string;
  sourceId: string;
  reason: string;
  anchorResolved: boolean;
  related: Promise<{ rows: RelatedDeadLetter[]; total: number }>;
  replayJob: Promise<ActiveReplayJob | null>;
  repair: DeadLetterRepair | null;
  canReplay: boolean;
}) {
  const [rows, job] = await Promise.all([
    related.catch(() => ({ rows: [], total: 0 })),
    replayJob.catch(() => null),
  ]);
  return (
    <RelatedFailuresCard
      deadLetterId={deadLetterId}
      sourceId={sourceId}
      reason={reason}
      anchorResolved={anchorResolved}
      related={rows}
      replayJob={job}
      repair={repair}
      canReplay={canReplay}
    />
  );
}

interface ReplayRow {
  id: string;
  scope: "route" | "destination" | "all";
  state: "pending" | "in_progress" | "done" | "failed";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

const REPLAY_PREVIEW_LIMIT = 10;

async function findReplaysForEvent(
  workspaceId: string,
  eventId: string,
): Promise<ReplayRow[]> {
  const result = await db().query<ReplayRow>(
    `SELECT id,
            scope,
            state,
            requested_at::text   AS requested_at,
            started_at::text     AS started_at,
            finished_at::text    AS finished_at,
            error_message
       FROM replay_requests
      WHERE workspace_id = $1 AND event_id = $2
      ORDER BY requested_at DESC
      LIMIT $3`,
    [workspaceId, eventId, REPLAY_PREVIEW_LIMIT],
  );
  return result.rows;
}

function ReplaysCard({
  eventId,
  replays,
}: {
  eventId: string;
  replays: ReplayRow[];
}) {
  if (replays.length === 0) {
    return (
      <section className="mb-6 rounded-md border border-border bg-card p-4">
        <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
          <RotateCcw className="size-3.5 text-muted-foreground" /> Replays
        </h2>
        <p className="text-xs text-muted-foreground">
          No replays queued for this event yet. Approve a patch below, or replay
          manually from the{" "}
          <Link
            href={`/deliveries?q=${encodeURIComponent(eventId)}`}
            className="text-foreground underline hover:no-underline"
          >
            Deliveries page
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
        <RotateCcw className="size-3.5 text-muted-foreground" /> Replays
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          ({replays.length} for this event)
        </span>
      </h2>
      <ul className="divide-y divide-border text-xs">
        {replays.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <ReplayStateBadge state={row.state} />
                <span className="font-mono text-muted-foreground">
                  scope: {row.scope}
                </span>
                <span className="font-mono text-muted-foreground truncate">
                  {row.id}
                </span>
              </div>
              <span className="shrink-0 text-muted-foreground">
                <LocalTime value={row.finished_at ?? row.started_at ?? row.requested_at} />
              </span>
            </div>
            {row.error_message ? (
              <pre className="max-h-32 overflow-auto rounded-sm bg-muted p-2 font-mono text-[10px] text-foreground">
                {row.error_message}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function ReplaysSection({
  eventId,
  replays,
}: {
  eventId: string;
  replays: Promise<ReplayRow[]>;
}) {
  const rows = await replays.catch(() => []);
  return <ReplaysCard eventId={eventId} replays={rows} />;
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      <div className="grid gap-2">
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    </section>
  );
}

function AiPatchSkeleton({ dataContractName }: { dataContractName: string }) {
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
        <Wand2 className="size-3.5" /> AI-proposed explanation
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Preparing a patch proposal from Data Contract{" "}
        <span className="font-mono text-foreground">{dataContractName}</span>.
      </p>
      <div className="grid gap-2">
        <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </section>
  );
}

async function DataContractInvestigationSection({
  dl,
  mapWithVersion,
}: {
  dl: DeadLetterFull;
  mapWithVersion: ReturnType<typeof findActiveDataContractForSource>;
}) {
  const activeContract = await mapWithVersion.catch(() => null);

  if (!activeContract) {
    return <NoDataContractNotice sourceId={dl.source_id} />;
  }

  return (
    <Suspense fallback={<AiPatchSkeleton dataContractName={activeContract.map.name} />}>
      <InvestigationBody
        dl={dl}
        dataContractId={activeContract.map.id}
        dataContractName={activeContract.map.name}
        dataContractVersion={activeContract.version}
      />
    </Suspense>
  );
}

function NoDataContractNotice({ sourceId }: { sourceId: string }) {
  return (
    <section className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
      <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
        <ShieldCheck className="size-3.5" /> No active Data Contract for this source
      </h2>
      <p className="mb-3">
        Investigations use the source's Data Contract to reason about the failure — the
        schema, current transform, and recent samples are the model's context. There
        isn't one for this source yet.
      </p>
      <Link
        href={`/sources/${sourceId}`}
        className="inline-flex items-center gap-1 text-foreground underline hover:no-underline"
      >
        Go to source → click <span className="rounded-sm bg-muted px-1 font-mono text-xs">Understand source</span>
      </Link>
    </section>
  );
}

// The Archive / Replay-all buttons call router.refresh() on success, which
// re-runs this whole server tree — including the billable LLM call below.
// The proposal's inputs (failed payload, transform, schema) are fixed for a
// given (dead letter, contract version), so cache on exactly that key: a
// refresh after archiving reuses the proposal instead of re-paying for a
// fresh inference + R2 fetch. React's cache() only dedupes within one
// request, so this needs unstable_cache; the wrapper lives here (not in
// explainFailure itself) because drift triage reuses explainFailure with
// genuinely fresh contexts.
const cachedExplainFailure = unstable_cache(
  async (_deadLetterId: string, _versionId: string, context: FailureContext) =>
    explainFailure(context),
  ["investigate-explain-failure"],
  { revalidate: 60 * 60 },
);

// Server component: actually fires the LLM call. Streams in as the page
// loads. Doing this in the request lifecycle (vs a client-fired action)
// keeps the URL deep-linkable — sharing a /investigate URL with a
// teammate reproduces the same explanation.
async function InvestigationBody({
  dl,
  dataContractId,
  dataContractName,
  dataContractVersion,
}: {
  dl: DeadLetterFull;
  dataContractId: string;
  dataContractName: string;
  dataContractVersion: Awaited<
    ReturnType<typeof findActiveDataContractForSource>
  > extends infer R
    ? R extends null
      ? never
      : R extends { version: infer V }
        ? V
        : never
    : never;
}) {
  // Pull the failed payload from R2 and a fresh batch of recent samples
  // for fixture regeneration on approval. Both are best-effort; if R2 is
  // momentarily unavailable we still render the page with whatever
  // context we have.
  const [failedPayload, samples] = await Promise.all([
    fetchPayloadForR2Key(dl.r2_key).catch(() => null),
    sampleSourceEvents(dl.workspace_id, dl.source_id, { maxEvents: 30 }).catch(
      () => [],
    ),
  ]);

  const inferred = dataContractVersion.inferred_schema as InferredDataContract;
  const currentTransform = parseTransform(dataContractVersion.generated_transform);
  const currentFilter = parseFilter(dataContractVersion.generated_filter);

  const failureContext: FailureContext = {
    data_contract_id: dataContractId,
    data_contract_version_id: dataContractVersion.id,
    inferred_schema: inferred,
    current_transform: currentTransform,
    current_filter: currentFilter,
    failed_events:
      failedPayload === null
        ? []
        : [
            {
              event_id: dl.event_id,
              received_at: dl.errored_at,
              shard: 0,
              headers: {},
              payload: failedPayload,
              shape_hash: "investigate",
            },
          ],
    response: {
      status: 0,
      body_excerpt: dl.message ?? "",
    },
    connector_message: dl.message ?? null,
  };

  const patch = await cachedExplainFailure(dl.id, dataContractVersion.id, failureContext);

  // Compute a preview using the EXISTING fixtures from the version
  // (if any). If there are none, the patch-gate will block on approval
  // — surfaced in the result UI.
  const preview = previewPatch(patch, failureContext, []);

  return (
    <div className="grid gap-6">
      <section className="rounded-md border border-border bg-card p-4">
        <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
          <Wand2 className="size-3.5" /> AI-proposed explanation
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Based on the Data Contract{" "}
          <Link
            href={`/data-contracts/${dataContractId}`}
            className="font-mono text-foreground hover:underline"
          >
            {dataContractName}
          </Link>{" "}
          (version <span className="font-mono">{dataContractVersion.id}</span>)
          {patch.model && (
            <>
              {" • "}
              model <span className="font-mono">{patch.model}</span>
              {patch.ms !== null && patch.ms !== undefined ? ` (${patch.ms}ms)` : ""}
            </>
          )}
        </p>
        <p className="text-sm text-foreground">{patch.likely_cause}</p>
        {patch.rationale ? (
          <p className="mt-2 text-xs text-muted-foreground">{patch.rationale}</p>
        ) : null}
        <ConfidenceBar value={patch.confidence} kind={patch.patch_kind} />
      </section>

      {patch.patch_kind === "none" ? (
        <section className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
          The model didn't propose a confident patch. You can still replay the
          event manually from the Deliveries page once the underlying
          destination issue is fixed.
        </section>
      ) : (
        <>
          <PatchDiff
            patchKind={patch.patch_kind}
            currentTransform={currentTransform}
            currentFilter={currentFilter}
            patchedTransform={patch.patched_transform}
            patchedFilter={patch.patched_filter}
          />
          {preview.per_event.length > 0 ? (
            <BeforeAfter rows={preview.per_event} />
          ) : null}
          <InvestigationApprovalForm
            dataContractId={dataContractId}
            currentVersion={dataContractVersion}
            patch={patch}
            failedDelivery={{
              event_id: dl.event_id,
              source_id: dl.source_id,
              route_id: dl.route_id,
              r2_key: dl.r2_key,
            }}
            samples={samples}
          />
        </>
      )}
    </div>
  );
}

function ConfidenceBar({
  value,
  kind,
}: {
  value: number;
  kind: ProposedPatch["patch_kind"];
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className="font-semibold">{kind}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full bg-foreground/70 transition-[width]"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <span className="font-mono">{Math.round(pct * 100)}%</span>
    </div>
  );
}

function parseTransform(serialized: string | null): GeneratedTransform {
  if (!serialized) return { kind: "passthrough" };
  try {
    const parsed = JSON.parse(serialized) as GeneratedTransform;
    return parsed;
  } catch {
    return { kind: "passthrough" };
  }
}

function parseFilter(serialized: string | null): GeneratedFilter | null {
  if (!serialized) return null;
  try {
    return JSON.parse(serialized) as GeneratedFilter;
  } catch {
    return null;
  }
}
