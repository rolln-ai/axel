import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { EmptyState } from "../../../../../EmptyState";
import { LocalTime } from "../../../../../_components/LocalTime";
import { Section } from "../../../../../_components/Section";
import { DeliveryStatusBadge } from "../../../../../_components/StatusBadges";
import { db } from "../../../../../../lib/db";
import { requireSession } from "../../../../../../lib/session";
import {
  formatBytes,
  getEventDetail,
  listDeliveryAttemptsForEvent,
  usageEnabled,
  type DeliveryAttemptRow,
  type EventDetailRow,
} from "../../../../../../lib/usage";
import { fetchPayloadForR2Key, fetchRawPayloadBase64ForR2Key, GENERIC_SAMPLE } from "../../../../../../lib/sample-payload";
import { EventReplayPanel } from "./EventReplayPanel";
import { projectPayload } from "../../../../../../lib/field-selection";
import { loadDiffPair } from "../../../../../../lib/event-diff";
import { EventDiffPanel } from "./EventDiffPanel";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

interface SourceLite {
  id: string;
  name: string;
  field_selection: string[] | null;
}

interface DestinationLite {
  id: string;
  name: string;
  type: string;
}

interface RouteLite {
  id: string;
  name: string | null;
}

interface RouteBindingRow {
  route_id: string;
  destination_id: string;
  collection: string | null;
  idempotency_field: string | null;
}

/** A place this event actually fanned out to, for the payload panel. */
interface DeliveryTarget {
  key: string;
  name: string;
  type: string;
  collection: string | null;
  idempotency_field: string | null;
  succeeded: boolean;
}

interface DeadLetterRow {
  reason: string;
  message: string;
  errored_at: string;
  route_id: string | null;
}

interface ReplayRow {
  id: string;
  scope: string;
  state: "pending" | "in_progress" | "done" | "failed";
  requested_at: string;
  completed_at: string | null;
  destination_id: string | null;
  route_id: string | null;
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: sourceId, eventId } = await params;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  const sourceResult = await db().query<SourceLite>(
    `SELECT id, name, field_selection
       FROM sources
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [sourceId, workspaceId],
  );
  const source = sourceResult.rows[0];
  if (!source) notFound();

  let event: EventDetailRow | null = null;
  let deliveryAttempts: DeliveryAttemptRow[] = [];
  let clickhouseError: string | null = null;
  if (usageEnabled()) {
    try {
      [event, deliveryAttempts] = await Promise.all([
        getEventDetail(workspaceId, eventId),
        listDeliveryAttemptsForEvent(workspaceId, eventId),
      ]);
    } catch (err) {
      clickhouseError = err instanceof Error ? err.message : "ClickHouse query failed.";
    }
  }
  if (!event && !clickhouseError && usageEnabled()) {
    notFound();
  }

  const [deadLetters, replays, destinations, routes, routeBindings] = await Promise.all([
    db().query<DeadLetterRow>(
      `SELECT reason, message, errored_at::text, route_id
         FROM dead_letters
        WHERE workspace_id = $1 AND event_id = $2
        ORDER BY errored_at DESC`,
      [workspaceId, eventId],
    ),
    db().query<ReplayRow>(
      `SELECT id, scope, state,
              requested_at::text,
              finished_at::text AS completed_at,
              destination_id, route_id
         FROM replay_requests
        WHERE workspace_id = $1 AND event_id = $2
        ORDER BY requested_at DESC`,
      [workspaceId, eventId],
    ),
    db().query<DestinationLite>(
      `SELECT d.id,
              COALESCE(to_jsonb(d)->>'name', d.id) AS name,
              d.type
         FROM destinations d
        WHERE d.workspace_id = $1`,
      [workspaceId],
    ),
    db().query<RouteLite>(
      `SELECT r.id,
              to_jsonb(r)->>'name' AS name
         FROM routes r
        WHERE r.workspace_id = $1`,
      [workspaceId],
    ),
    // Per-route collection binding for MongoDB destinations, so the
    // delivery history can show *which* collection an event landed in.
    // Newer attempts also carry `collection` on the response itself; this
    // covers attempts recorded before that and stays in sync with config.
    db().query<RouteBindingRow>(
      `SELECT rd.route_id, rd.destination_id,
              rd.binding->>'collection' AS collection,
              rd.binding->>'idempotency_field' AS idempotency_field
         FROM route_destinations rd
         JOIN destinations d ON d.id = rd.destination_id
        WHERE d.workspace_id = $1 AND d.type = 'mongodb'`,
      [workspaceId],
    ),
  ]);

  const destById = new Map(destinations.rows.map((d) => [d.id, d]));
  const routeById = new Map(routes.rows.map((r) => [r.id, r]));
  const bindingByRouteDest = new Map(
    routeBindings.rows.map((b) => [`${b.route_id}:${b.destination_id}`, b]),
  );
  const collectionByRouteDest = new Map(
    routeBindings.rows
      .filter((b) => b.collection)
      .map((b) => [`${b.route_id}:${b.destination_id}`, b.collection as string]),
  );

  // Where this event actually landed — one entry per (route, destination) it
  // fanned out to. Drives the "Where this lands" half of the payload panel,
  // which is far more useful than an empty field-selection preview when the
  // destination is MongoDB (or any non-projecting sink).
  const deliveryTargets: DeliveryTarget[] = [];
  const seenTargets = new Set<string>();
  for (const a of deliveryAttempts) {
    const key = `${a.route_id}:${a.destination_id}`;
    if (seenTargets.has(key)) {
      if (a.status === "success") {
        const t = deliveryTargets.find((d) => d.key === key);
        if (t) t.succeeded = true;
      }
      continue;
    }
    seenTargets.add(key);
    const dest = destById.get(a.destination_id);
    const binding = bindingByRouteDest.get(key);
    deliveryTargets.push({
      key,
      name: dest?.name ?? a.destination_id,
      type: dest?.type ?? "destination",
      collection: binding?.collection ?? null,
      idempotency_field: binding?.idempotency_field ?? null,
      succeeded: a.status === "success",
    });
  }

  const payloadPromise: Promise<unknown> = event
    ? fetchPayloadForR2Key(event.r2_key)
        .then((p) => p ?? GENERIC_SAMPLE)
        .catch(() => GENERIC_SAMPLE)
    : Promise.resolve(null);
  // Raw bytes for the AXE-53 cURL / Replay panel — separate fetch so
  // a missing R2 object only degrades the replay snippet, not the
  // pretty-printed payload above.
  const rawBytesBase64Promise: Promise<string | null> = event
    ? fetchRawPayloadBase64ForR2Key(event.r2_key).catch(() => null)
    : Promise.resolve(null);
  // AXE-55 — fetch the previous event from the same source for the diff
  // panel. Best-effort; if either ClickHouse or R2 hiccups we render an
  // empty-state panel rather than crashing the page.
  const diffPairPromise = event
    ? loadDiffPair(workspaceId, sourceId, {
        event_id: event.event_id,
        received_at: event.received_at,
        r2_key: event.r2_key,
      }).catch(() => null)
    : Promise.resolve(null);

  const status = deliveryStatusBadge(deliveryAttempts, deadLetters.rows);
  const statusVariant: "default" | "secondary" | "destructive" | "outline" =
    status === "success" ? "default" :
    status === "failure" ? "destructive" :
    status === "failure (retry)" ? "secondary" : "outline";

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/sources/${sourceId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            {source.name}
          </Link>
          <h1 className="break-all font-mono text-base font-semibold leading-snug text-foreground md:text-lg">
            {eventId}
          </h1>
          <small className="text-xs text-muted-foreground">
            {event ? <LocalTime value={event.received_at.replace(" ", "T") + "Z"} /> : "event details unavailable"}
          </small>
        </div>
        <Badge variant={statusVariant} className="capitalize">{status}</Badge>
      </div>

      {clickhouseError ? (
        <section className="mb-6 rounded-lg border border-border bg-card p-5">
          <EmptyState
            title="Couldn't load event from ClickHouse"
            body={`Query failed: ${clickhouseError}`}
          />
        </section>
      ) : null}

      {event ? (
        <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Event summary">
          <SmallStat label="Source" value={source.name} sub={event.source_id} mono />
          <SmallStat label="Size" value={formatBytes(event.size_bytes)} sub={event.content_type} />
          <SmallStat label="Shard" value={String(event.shard).padStart(2, "0")} sub="queue partition" />
          <SmallStat label="Delivery attempts" value={String(deliveryAttempts.length)} sub="across all destinations" />
        </section>
      ) : null}

      <Section title="Delivery history" pill="where this event was synced">
        {deliveryAttempts.length === 0 && deadLetters.rows.length === 0 ? (
          <EmptyState
            title="No delivery records"
            body="Either no routes match this source yet, or this event was received before delivery-attempt logging was enabled."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Destination</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Attempt</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveryAttempts.map((attempt) => {
                const dest = destById.get(attempt.destination_id);
                const route = routeById.get(attempt.route_id);
                return (
                  <TableRow key={attempt.attempt_id}>
                    <TableCell>
                      <strong className="text-sm text-foreground">{dest?.name ?? attempt.destination_id}</strong>
                      {dest ? (
                        <small className="block text-xs text-muted-foreground">{dest.type}</small>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{route?.name ?? attempt.route_id}</TableCell>
                    <TableCell>
                      <DeliveryStatusBadge status={attempt.status} />
                    </TableCell>
                    <TableCell className="text-sm">{attempt.latency_ms}ms</TableCell>
                    <TableCell className="text-xs">
                      {renderResponseDetail(
                        attempt.response,
                        collectionByRouteDest.get(`${attempt.route_id}:${attempt.destination_id}`),
                      )}
                    </TableCell>
                    <TableCell className="text-xs">#{attempt.attempt_no}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <LocalTime value={attempt.created_at.replace(" ", "T") + "Z"} mode="time" />
                    </TableCell>
                  </TableRow>
                );
              })}
              {deadLetters.rows.map((dl, idx) => (
                <TableRow key={`dl-${idx}`}>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="font-mono text-xs">
                    {dl.route_id ? (routeById.get(dl.route_id)?.name ?? dl.route_id) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="destructive">failure</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs">
                    <strong>{dl.reason}</strong> — {dl.message}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <LocalTime value={dl.errored_at} mode="time" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {event ? (
        <Section title="Schema diff vs. previous event" pill="catches drift before it breaks deliveries">
          <Suspense fallback={<EmptyState title="Loading diff…" body="" />}>
            <DiffLoader
              sourceId={sourceId}
              diffPairPromise={diffPairPromise}
            />
          </Suspense>
        </Section>
      ) : null}

      <Section title="Raw payload" pill="stored in R2 — replay-safe">
        <Suspense fallback={<PayloadSkeleton />}>
          <PayloadView
            payloadPromise={payloadPromise}
            fieldSelection={source.field_selection}
            targets={deliveryTargets}
          />
        </Suspense>
        <small className="block text-xs text-muted-foreground">
          R2 key:{" "}
          <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">
            {event?.r2_key ?? "n/a"}
          </code>
        </small>
      </Section>

      {event ? (
        <Section title="Send this event again" pill="cURL + axel CLI snippets">
          <Suspense fallback={<EmptyState title="Loading raw bytes…" body="" />}>
            <ReplayPanelLoader
              eventId={event.event_id}
              contentType={event.content_type}
              headers={event.headers}
              rawBytesBase64Promise={rawBytesBase64Promise}
            />
          </Suspense>
        </Section>
      ) : null}

      {event && (Object.keys(event.headers).length > 0 || Object.keys(event.query).length > 0) ? (
        <Section title="Request metadata" pill="headers + query string captured at ingest">
          <div className="grid gap-4">
            {Object.keys(event.headers).length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Headers
                </h3>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {formatKeyValue(event.headers)}
                </pre>
              </div>
            ) : null}
            {Object.keys(event.query).length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Query string
                </h3>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {formatKeyValue(event.query)}
                </pre>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {replays.rows.length > 0 ? (
        <Section title="Replays" pill={`${replays.rows.length} request${replays.rows.length === 1 ? "" : "s"}`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {replays.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{r.scope}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.destination_id ?? r.route_id ?? "all"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.state === "done" ? "default" : r.state === "failed" ? "destructive" : "secondary"}>
                      {r.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground"><LocalTime value={r.requested_at} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.completed_at ? <LocalTime value={r.completed_at} /> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
    </>
  );
}

function SmallStat({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub: string;
  mono?: boolean;
}) {
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <strong className={`text-base font-semibold text-foreground ${mono ? "font-mono" : ""}`}>
        {value}
      </strong>
      <small className="truncate text-xs text-muted-foreground">{sub}</small>
    </article>
  );
}

function deliveryStatusBadge(
  attempts: DeliveryAttemptRow[],
  deadLetters: DeadLetterRow[],
): "success" | "failure (retry)" | "failure" | "pending" {
  if (deadLetters.length > 0) return "failure";
  if (attempts.length === 0) return "pending";
  const byDest = new Map<string, DeliveryAttemptRow["status"][]>();
  for (const a of attempts) {
    const arr = byDest.get(a.destination_id) ?? [];
    arr.push(a.status);
    byDest.set(a.destination_id, arr);
  }
  let anyRetry = false;
  let anyDead = false;
  for (const statuses of byDest.values()) {
    if (statuses.includes("success")) continue;
    if (statuses.includes("dead")) anyDead = true;
    else anyRetry = true;
  }
  if (anyDead) return "failure";
  if (anyRetry) return "failure (retry)";
  return "success";
}

function renderResponseDetail(
  response: DeliveryAttemptRow["response"],
  collection?: string,
): React.ReactNode {
  const parts: string[] = [];
  if (typeof response.http_status === "number") parts.push(`HTTP ${response.http_status}`);
  if (response.error) parts.push(response.error);

  // MongoDB deliveries land in a specific collection — surface it so it's
  // clear *where* the event was saved. Prefer the value recorded on the
  // attempt; fall back to the route's current binding for older attempts.
  const coll = typeof response.collection === "string" ? response.collection : collection;
  if (coll) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-muted-foreground">collection</span>
        <code className="rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground">{coll}</code>
        {parts.length > 0 ? <span className="text-muted-foreground">· {parts.join(" · ")}</span> : null}
      </span>
    );
  }

  if (parts.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span>{parts.join(" · ")}</span>;
}

function formatKeyValue(record: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const safeValue = SENSITIVE_KEY.test(key) ? maskSecret(value) : value;
    lines.push(`${key}: ${safeValue}`);
  }
  return lines.join("\n");
}

const SENSITIVE_KEY = /authorization|token|cookie|secret|api[_-]?key|x-axel-token/i;

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function ReplayPanelLoader({
  eventId,
  contentType,
  headers,
  rawBytesBase64Promise,
}: {
  eventId: string;
  contentType: string;
  headers: Record<string, string>;
  rawBytesBase64Promise: Promise<string | null>;
}) {
  const bodyBase64 = await rawBytesBase64Promise;
  if (!bodyBase64) {
    return (
      <EmptyState
        title="Raw bytes unavailable"
        body="The R2 payload for this event couldn't be loaded — replay snippets need the original bytes. This usually means CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID aren't set on the dashboard, or the payload exceeds the 5 MB cap."
      />
    );
  }
  return (
    <EventReplayPanel
      eventId={eventId}
      contentType={contentType}
      headers={headers}
      bodyBase64={bodyBase64}
    />
  );
}

async function DiffLoader({
  sourceId,
  diffPairPromise,
}: {
  sourceId: string;
  diffPairPromise: Promise<Awaited<ReturnType<typeof loadDiffPair>> | null>;
}) {
  const pair = await diffPairPromise;
  if (!pair) {
    return (
      <EmptyState
        title="Diff unavailable"
        body="Couldn't load adjacent events from ClickHouse. Diff comes back once the analytics path is healthy."
      />
    );
  }
  return <EventDiffPanel sourceId={sourceId} before={pair.before} after={pair.after} />;
}

async function PayloadView({
  payloadPromise,
  fieldSelection,
  targets,
}: {
  payloadPromise: Promise<unknown>;
  fieldSelection: string[] | null;
  targets: DeliveryTarget[];
}) {
  const payload = await payloadPromise;
  const hasSelection = Boolean(fieldSelection && fieldSelection.length > 0);
  const projected = hasSelection ? projectPayload(payload, fieldSelection) : null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Raw (as received)
        </span>
        <pre className="max-h-[480px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
          {prettyJson(payload)}
        </pre>
      </div>
      <div className="flex flex-col gap-4">
        {/* What destinations receive — only meaningful when a projection is set. */}
        <div>
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {projected !== null ? "Projected (after field selection)" : "Field selection"}
          </span>
          {projected !== null ? (
            <pre className="max-h-[280px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {prettyJson(projected)}
            </pre>
          ) : (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              No field selection on this source — destinations receive the full payload shown on the left.
            </p>
          )}
        </div>

        {/* Where this lands — far more useful than dead space when the sink is
            MongoDB (collection + write mode) or any other destination. */}
        <div>
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Where this lands
          </span>
          {targets.length === 0 ? (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              No deliveries recorded for this event yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {targets.map((t) => (
                <li
                  key={t.key}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md bg-muted px-3 py-2 text-xs"
                >
                  <strong className="text-sm text-foreground">{t.name}</strong>
                  <span className="text-muted-foreground">{t.type}</span>
                  {t.collection ? (
                    <span className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
                      <span aria-hidden>→</span>
                      <code className="rounded-sm bg-background px-1 font-mono text-[11px] text-foreground">
                        {t.collection}
                      </code>
                      <span>{t.idempotency_field ? `upsert on ${t.idempotency_field}` : "insert"}</span>
                    </span>
                  ) : null}
                  {!t.succeeded ? (
                    <span className="text-[11px] font-medium text-amber-500">not yet delivered</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function PayloadSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Skeleton className="h-60" />
      <Skeleton className="h-60" />
    </div>
  );
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "// payload unavailable (R2 fetch failed or expired)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
