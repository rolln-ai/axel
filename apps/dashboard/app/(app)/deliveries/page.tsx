import Link from "next/link";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { ReplayJobProgress } from "../../_components/ReplayJobProgress";
import { DeliveryStreamTable, type DeliveryStreamRow } from "./DeliveryStreamTable";
import {
  countUnresolvedDeadLettersCached,
  listDeadLettersFull,
  type DeadLetterFullRow,
} from "../../../lib/repositories";
import { requireSession } from "../../../lib/session";
import { db } from "../../../lib/db";
import {
  formatCount,
  listWorkspaceDeliveryAttempts,
  usageEnabled,
  type WorkspaceDeliveryAttemptRow,
} from "../../../lib/usage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const dynamic = "force-dynamic";

const ATTEMPT_LIMIT = 100;
const DELIVERIES_PAGE_TIMEOUT_MS = 2_500;

interface DeliveryFilters {
  status: "all" | "success" | "retry" | "failed";
  source: string;
  destination: string;
  q: string;
}

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canReplay = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  let attempts: WorkspaceDeliveryAttemptRow[] = [];
  let attemptsError: string | null = null;
  if (usageEnabled()) {
    const attemptsResult = await settleWithin(
      listWorkspaceDeliveryAttempts(workspaceId, null, ATTEMPT_LIMIT),
      DELIVERIES_PAGE_TIMEOUT_MS,
      "Delivery stream took too long to load.",
    );
    if (attemptsResult.ok) {
      attempts = attemptsResult.value;
    } else {
      attemptsError = attemptsResult.error;
    }
  }

  const [deadLettersResult, unresolvedTotalResult] = await Promise.all([
    settleWithin(
      listDeadLettersFull(workspaceId),
      DELIVERIES_PAGE_TIMEOUT_MS,
      "Unresolved backlog took too long to load.",
    ),
    settleWithin(
      countUnresolvedDeadLettersCached(workspaceId),
      DELIVERIES_PAGE_TIMEOUT_MS,
      "Unresolved count took too long to load.",
    ),
  ]);
  const deadLetters =
    deadLettersResult.ok ? deadLettersResult.value : [];
  const unresolvedTotal =
    unresolvedTotalResult.ok ? unresolvedTotalResult.value : 0;
  const deadLettersError =
    !deadLettersResult.ok || !unresolvedTotalResult.ok;

  // ClickHouse's delivery_attempts has no source_id and only the raw
  // destination_id, so the stream couldn't link a row to its event or name
  // the destination. Resolve both from Postgres (route → source, destination
  // → name/type) so every row links through to the event + destination detail.
  const meta = await resolveDeliveryMeta(workspaceId, attempts, deadLetters);

  const rows = buildDeliveryRows(attempts, deadLetters, meta);
  const filteredRows = filterDeliveryRows(rows, filters);
  const filterOptions = buildFilterOptions(rows);
  const activeFilterCount = countActiveFilters(filters);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Deliveries"
        description="Recent delivery activity across successes, retries, failures, and replay status."
      />

      {/* Live progress for the most-recent "Replay all N unresolved" job —
          immediate feedback right after the operator clicks the button in the
          delivery stream below. Renders nothing when no job is active. */}
      <ReplayJobProgress workspaceId={workspaceId} />

      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Delivery stream</h2>
            <small className="text-xs text-muted-foreground">
              latest {formatCount(attempts.length)} logged attempts
              {unresolvedTotal > 0 ? ` · ${formatCount(unresolvedTotal)} unresolved` : ""}
              {deadLettersError ? " · unresolved backlog temporarily unavailable" : ""}
              {activeFilterCount > 0 ? ` · ${formatCount(filteredRows.length)} matching` : ""}
            </small>
          </div>
          <DeliveryFiltersForm filters={filters} options={filterOptions} />
        </div>

        {filteredRows.length ? (
          <DeliveryStreamTable rows={filteredRows} canReplay={canReplay} unresolvedTotal={unresolvedTotal} />
        ) : (
          <div className="p-5">
            <EmptyState
              title={attemptsError ? "Couldn't load delivery stream" : activeFilterCount > 0 ? "No matching deliveries" : "No deliveries yet"}
              body={
                attemptsError
                  ? `ClickHouse query failed: ${attemptsError}`
                  : activeFilterCount > 0
                    ? "Adjust or clear filters to see more delivery activity."
                  : usageEnabled()
                    ? "Delivery attempts will appear here once events match routes and fan out to destinations."
                    : "Set CLICKHOUSE_URL on the dashboard to show delivery attempts across success and failure statuses."
              }
              action={
                activeFilterCount > 0 ? (
                  <Button asChild variant="outline">
                    <Link href="/deliveries">Clear filters</Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
      </section>
    </>
  );
}

type TimedResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<TimedResult<T>> {
  let settled = false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: timeoutMessage });
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: true, value });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : "Query failed.",
        });
      });
  });
}

function DeliveryFiltersForm({
  filters,
  options,
}: {
  filters: DeliveryFilters;
  options: {
    sources: string[];
    destinations: string[];
  };
}) {
  return (
    <form action="/deliveries" className="flex flex-wrap items-end gap-2 md:flex-nowrap">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</span>
        <Select name="status" defaultValue={filters.status}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="retry">Retrying</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Source</span>
        <Select name="source" defaultValue={filters.source || "all"}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {options.sources.map((source) => (
              <SelectItem key={source} value={source}>{source}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Destination</span>
        <Select name="destination" defaultValue={filters.destination || "all"}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All destinations</SelectItem>
            {options.destinations.map((destination) => (
              <SelectItem key={destination} value={destination}>{destination}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Search</span>
        <Input name="q" defaultValue={filters.q} placeholder="Event, route, response..." />
      </label>

      <Button type="submit" variant="outline">Filter</Button>
      {countActiveFilters(filters) > 0 ? (
        <Button asChild variant="ghost">
          <Link href="/deliveries">Clear</Link>
        </Button>
      ) : null}
    </form>
  );
}

interface DeliveryMeta {
  sourceByRoute: Map<string, string>;
  destById: Map<string, { name: string; type: string }>;
}

async function resolveDeliveryMeta(
  workspaceId: string,
  attempts: WorkspaceDeliveryAttemptRow[],
  deadLetters: DeadLetterFullRow[],
): Promise<DeliveryMeta> {
  const routeIds = new Set<string>();
  const destIds = new Set<string>();
  for (const a of attempts) {
    if (a.route_id) routeIds.add(a.route_id);
    if (a.destination_id) destIds.add(a.destination_id);
  }
  for (const dl of deadLetters) {
    if (dl.route_id) routeIds.add(dl.route_id);
  }

  const [routeRows, destRows] = await Promise.all([
    routeIds.size
      ? db().query<{ id: string; source_id: string }>(
          `SELECT id, source_id FROM routes WHERE workspace_id = $1 AND id = ANY($2)`,
          [workspaceId, Array.from(routeIds)],
        )
      : Promise.resolve({ rows: [] as { id: string; source_id: string }[] }),
    destIds.size
      ? db().query<{ id: string; name: string; type: string }>(
          `SELECT id, COALESCE(name, id) AS name, type
             FROM destinations
            WHERE workspace_id = $1 AND id = ANY($2)`,
          [workspaceId, Array.from(destIds)],
        )
      : Promise.resolve({ rows: [] as { id: string; name: string; type: string }[] }),
  ]);

  return {
    sourceByRoute: new Map(routeRows.rows.map((r) => [r.id, r.source_id])),
    destById: new Map(destRows.rows.map((d) => [d.id, { name: d.name, type: d.type }])),
  };
}

function buildDeliveryRows(
  attempts: WorkspaceDeliveryAttemptRow[],
  deadLetters: DeadLetterFullRow[],
  meta: DeliveryMeta,
): DeliveryStreamRow[] {
  const deadLettersByRoute = new Map(deadLetters.map((row) => [deadLetterKey(row.event_id, row.route_id ?? ""), row]));
  const seenDeadLetterKeys = new Set<string>();
  const rows: DeliveryStreamRow[] = attempts.map((attempt) => {
    const key = deadLetterKey(originalEventId(attempt.event_id), attempt.route_id);
    const deadLetter = deadLettersByRoute.get(key) ?? null;
    if (deadLetter) seenDeadLetterKeys.add(key);

    const dest = attempt.destination_id ? meta.destById.get(attempt.destination_id) : undefined;
    return {
      id: `attempt:${attempt.attempt_id}`,
      kind: "attempt",
      event_id: attempt.event_id,
      source_id: attempt.source_id ?? meta.sourceByRoute.get(attempt.route_id) ?? null,
      route_id: attempt.route_id,
      destination_id: attempt.destination_id,
      destination_name: dest?.name ?? null,
      destination_type: dest?.type ?? null,
      status: attempt.status,
      status_at: clickhouseToIso(attempt.created_at),
      attempt_no: attempt.attempt_no,
      latency_ms: attempt.latency_ms,
      response: attempt.response,
      dead_letter: deadLetter ? deadLetterToStreamFailure(deadLetter) : null,
    };
  });

  for (const deadLetter of deadLetters) {
    const key = deadLetterKey(deadLetter.event_id, deadLetter.route_id ?? "");
    if (seenDeadLetterKeys.has(key)) continue;
    rows.push({
      id: `dead_letter:${deadLetter.id}`,
      kind: "dead_letter",
      event_id: deadLetter.event_id,
      source_id: deadLetter.source_id ?? (deadLetter.route_id ? meta.sourceByRoute.get(deadLetter.route_id) ?? null : null),
      route_id: deadLetter.route_id ?? "",
      destination_id: null,
      destination_name: null,
      destination_type: null,
      status: "dead",
      status_at: deadLetter.errored_at,
      attempt_no: null,
      latency_ms: null,
      response: {},
      dead_letter: deadLetterToStreamFailure(deadLetter),
    });
  }

  return rows.sort((a, b) => Date.parse(b.status_at) - Date.parse(a.status_at));
}

function deadLetterToStreamFailure(row: DeadLetterFullRow): DeliveryStreamRow["dead_letter"] {
  return {
    id: String(row.id),
    reason: row.reason,
    message: row.message ?? null,
    replay: row.replay_id && row.replay_state && row.replay_requested_at
      ? {
          id: row.replay_id,
          state: row.replay_state,
          requested_at: row.replay_requested_at,
          finished_at: row.replay_finished_at,
          error_message: row.replay_error_message,
        }
      : null,
  };
}

function deadLetterKey(eventId: string, routeId: string): string {
  return `${eventId}:${routeId}`;
}

function originalEventId(eventId: string): string {
  return eventId.replace(/#rpy_[A-Za-z0-9_-]+$/, "");
}

function clickhouseToIso(raw: string): string {
  return raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
}

function parseFilters(searchParams: Record<string, string | string[] | undefined>): DeliveryFilters {
  const status = firstValue(searchParams.status);
  return {
    status: status === "success" || status === "retry" || status === "failed" ? status : "all",
    source: normalizeSelectFilter(firstValue(searchParams.source)),
    destination: normalizeSelectFilter(firstValue(searchParams.destination)),
    q: (firstValue(searchParams.q) ?? "").trim(),
  };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeSelectFilter(value: string | undefined): string {
  if (!value || value === "all") return "";
  return value.trim();
}

function filterDeliveryRows(rows: DeliveryStreamRow[], filters: DeliveryFilters): DeliveryStreamRow[] {
  const q = filters.q.toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== "all") {
      if (filters.status === "failed" && row.status !== "dead") return false;
      if (filters.status !== "failed" && row.status !== filters.status) return false;
    }
    if (filters.source && row.source_id !== filters.source) return false;
    if (filters.destination && row.destination_id !== filters.destination) return false;
    if (q && !rowSearchText(row).includes(q)) return false;
    return true;
  });
}

function rowSearchText(row: DeliveryStreamRow): string {
  return [
    row.event_id,
    row.source_id,
    row.route_id,
    row.destination_id,
    row.status,
    row.dead_letter?.reason,
    row.dead_letter?.message,
    row.dead_letter?.replay?.state,
    row.response.http_status,
    row.response.error,
    row.response.destination_type,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function buildFilterOptions(rows: DeliveryStreamRow[]): { sources: string[]; destinations: string[] } {
  return {
    sources: uniqueSorted(rows.map((row) => row.source_id)),
    destinations: uniqueSorted(rows.map((row) => row.destination_id)),
  };
}

function uniqueSorted(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b));
}

function countActiveFilters(filters: DeliveryFilters): number {
  return [
    filters.status !== "all",
    Boolean(filters.source),
    Boolean(filters.destination),
    Boolean(filters.q),
  ].filter(Boolean).length;
}
