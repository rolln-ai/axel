import Link from "@/app/_components/NavigationLink";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { EventStreamTable, type EventStreamRow } from "./EventStreamTable";
import { listSourcesCached } from "../../../lib/repositories";
import { requireSession } from "../../../lib/session";
import {
  formatCount,
  listWorkspaceEventFacets,
  listWorkspaceEvents,
  usageEnabled,
  type WorkspaceEventFacets,
  type WorkspaceEventRow,
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

const EVENT_LIMIT = 100;
const EVENTS_PAGE_TIMEOUT_MS = 2_500;

interface EventFilters {
  source: string;
  contentType: string;
  q: string;
}

/** Keyset cursor parsed from `?before=<iso>&before_id=<event_id>`. */
interface EventCursor {
  before: string;
  beforeId: string;
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const cursor = parseCursor(params);
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  // Events page, filter facets, and source names are independent reads — run
  // them concurrently, each with its own timeout, so a slow store degrades
  // just its own slice of the page.
  const [eventsResult, facetsResult, sourcesResult] = await Promise.all([
    usageEnabled()
      ? settleWithin(
          // Fetch one row past the page size purely to learn whether an older
          // page exists; the extra row is never rendered.
          listWorkspaceEvents(workspaceId, {
            limit: EVENT_LIMIT + 1,
            sourceId: filters.source || undefined,
            contentType: filters.contentType || undefined,
            search: filters.q || undefined,
            before: cursor
              ? { receivedAt: cursor.before, eventId: cursor.beforeId || undefined }
              : undefined,
          }),
          EVENTS_PAGE_TIMEOUT_MS,
          "Event stream took too long to load.",
        )
      : Promise.resolve<TimedResult<WorkspaceEventRow[]>>({ ok: true, value: [] }),
    usageEnabled()
      ? settleWithin(
          listWorkspaceEventFacets(workspaceId),
          EVENTS_PAGE_TIMEOUT_MS,
          "Filter options took too long to load.",
        )
      : Promise.resolve<TimedResult<WorkspaceEventFacets>>({
          ok: true,
          value: { sourceIds: [], contentTypes: [] },
        }),
    // Source names for display + filter options. Best-effort: if Postgres is
    // slow we still render the table against raw source ids.
    settleWithin(
      listSourcesCached(workspaceId),
      EVENTS_PAGE_TIMEOUT_MS,
      "Sources took too long to load.",
    ),
  ]);

  let events: WorkspaceEventRow[] = [];
  let eventsError: string | null = null;
  if (eventsResult.ok) {
    events = eventsResult.value;
  } else {
    eventsError = eventsResult.error;
  }
  const hasOlder = events.length > EVENT_LIMIT;
  if (hasOlder) events = events.slice(0, EVENT_LIMIT);

  const sourceNameById = new Map(
    (sourcesResult.ok ? sourcesResult.value : []).map((source) => [source.id, source.name]),
  );

  const rows = buildEventRows(events, sourceNameById);
  const filterOptions = facetsResult.ok
    ? buildFacetOptions(facetsResult.value, sourceNameById)
    : buildFilterOptions(rows);
  const activeFilterCount = countActiveFilters(filters);
  const oldestRow = rows.at(-1);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Events"
        description="Every inbound event received across your sources, newest first."
      />

      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Event stream</h2>
            <small className="text-xs text-muted-foreground">
              {formatCount(rows.length)} {cursor ? "older" : "latest"} events
              {activeFilterCount > 0 ? " matching filters" : ""}
            </small>
          </div>
          <EventFiltersForm filters={filters} options={filterOptions} />
        </div>

        {rows.length ? (
          <>
            <EventStreamTable rows={rows} />
            {cursor || hasOlder ? (
              <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
                {cursor ? (
                  <Button asChild variant="ghost">
                    <Link href={buildEventsHref(filters)}>Newest</Link>
                  </Button>
                ) : null}
                {hasOlder && oldestRow ? (
                  <Button asChild variant="outline">
                    <Link href={buildEventsHref(filters, oldestRow)}>Older →</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="p-5">
            <EmptyState
              title={
                eventsError
                  ? "Couldn't load event stream"
                  : cursor
                    ? "No older events"
                    : activeFilterCount > 0
                      ? "No matching events"
                      : "No events yet"
              }
              body={
                eventsError
                  ? eventsError
                  : cursor
                    ? "You've reached the end of the retained event stream."
                    : activeFilterCount > 0
                      ? "Adjust or clear filters to see more inbound events."
                      : usageEnabled()
                        ? "Events will appear here within seconds of the first webhook hitting an ingest endpoint."
                        : "Event analytics are unavailable for this deployment."
              }
              action={
                cursor ? (
                  <Button asChild variant="outline">
                    <Link href={buildEventsHref(filters)}>Back to newest</Link>
                  </Button>
                ) : activeFilterCount > 0 ? (
                  <Button asChild variant="outline">
                    <Link href="/events">Clear filters</Link>
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
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: "Event data is temporarily unavailable.",
        });
      });
  });
}

function EventFiltersForm({
  filters,
  options,
}: {
  filters: EventFilters;
  options: {
    sources: { id: string; name: string }[];
    contentTypes: string[];
  };
}) {
  // Plain GET form: submitting naturally drops any `before` cursor params, so
  // changing a filter always restarts from the newest page.
  return (
    <form action="/events" className="flex flex-wrap items-end gap-2 md:flex-nowrap">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Source</span>
        <Select name="source" defaultValue={filters.source || "all"}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {options.sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Content type</span>
        <Select name="content_type" defaultValue={filters.contentType || "all"}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {options.contentTypes.map((contentType) => (
              <SelectItem key={contentType} value={contentType}>{contentType}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Search</span>
        <Input name="q" defaultValue={filters.q} placeholder="Event id, source id, type..." />
      </label>

      <Button type="submit" variant="outline">Filter</Button>
      {countActiveFilters(filters) > 0 ? (
        <Button asChild variant="ghost">
          <Link href="/events">Clear</Link>
        </Button>
      ) : null}
    </form>
  );
}

function buildEventRows(
  events: WorkspaceEventRow[],
  sourceNameById: Map<string, string>,
): EventStreamRow[] {
  // Already newest-first from ClickHouse (ORDER BY received_at DESC).
  return events.map((event) => ({
    event_id: event.event_id,
    source_id: event.source_id,
    source_name: sourceNameById.get(event.source_id) ?? null,
    received_at: clickhouseToIso(event.received_at),
    content_type: event.content_type,
    size_bytes: event.size_bytes,
    shard: event.shard,
  }));
}

function clickhouseToIso(raw: string): string {
  return raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
}

function parseFilters(searchParams: Record<string, string | string[] | undefined>): EventFilters {
  return {
    source: normalizeSelectFilter(firstValue(searchParams.source)),
    contentType: normalizeSelectFilter(firstValue(searchParams.content_type)),
    q: (firstValue(searchParams.q) ?? "").trim(),
  };
}

function parseCursor(
  searchParams: Record<string, string | string[] | undefined>,
): EventCursor | null {
  const before = (firstValue(searchParams.before) ?? "").trim();
  // Reject anything Date can't parse before it reaches ClickHouse — a garbage
  // cursor should degrade to the newest page, not a query error.
  if (!before || Number.isNaN(Date.parse(before))) return null;
  return { before, beforeId: (firstValue(searchParams.before_id) ?? "").trim() };
}

function buildEventsHref(filters: EventFilters, cursorRow?: EventStreamRow): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.contentType) params.set("content_type", filters.contentType);
  if (filters.q) params.set("q", filters.q);
  if (cursorRow) {
    params.set("before", cursorRow.received_at);
    params.set("before_id", cursorRow.event_id);
  }
  const query = params.toString();
  return query ? `/events?${query}` : "/events";
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeSelectFilter(value: string | undefined): string {
  if (!value || value === "all") return "";
  return value.trim();
}

function buildFacetOptions(
  facets: WorkspaceEventFacets,
  sourceNameById: Map<string, string>,
): {
  sources: { id: string; name: string }[];
  contentTypes: string[];
} {
  const sources = facets.sourceIds
    .map((id) => ({ id, name: sourceNameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { sources, contentTypes: facets.contentTypes };
}

/** Fallback when the facet query fails: derive options from the loaded page. */
function buildFilterOptions(rows: EventStreamRow[]): {
  sources: { id: string; name: string }[];
  contentTypes: string[];
} {
  const sourceMap = new Map<string, string>();
  for (const row of rows) {
    if (!sourceMap.has(row.source_id)) {
      sourceMap.set(row.source_id, row.source_name ?? row.source_id);
    }
  }
  const sources = Array.from(sourceMap, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    sources,
    contentTypes: uniqueSorted(rows.map((row) => row.content_type)),
  };
}

function uniqueSorted(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function countActiveFilters(filters: EventFilters): number {
  return [Boolean(filters.source), Boolean(filters.contentType), Boolean(filters.q)].filter(
    Boolean,
  ).length;
}
