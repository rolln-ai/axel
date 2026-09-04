import Link from "next/link";
import { EmptyState } from "../../../EmptyState";
import { LocalTime } from "../../../_components/LocalTime";
import { Section } from "../../../_components/Section";
import { StatCard } from "../../../_components/StatCard";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  formatBytes, formatCount, densifyDailySeries, getSourceEventStats,
  getSourceDailyUsage, listSourceEvents, usageEnabled,
  type DailyUsageRow, type SourceEventRow, type SourceEventStats,
} from "../../../../lib/usage";

/** Source analytics loading and rendering belong together, separate from configuration tabs. */
export async function SourceOverview({
  source,
  workspaceId,
  timezone,
}: {
  source: { id: string; status: "active" | "disabled"; routes_attached: number };
  workspaceId: string;
  timezone: string;
}) {
  let events: SourceEventRow[] = [];
  let stats: SourceEventStats | null = null;
  let dailyEvents: DailyUsageRow[] = [];
  const configured = usageEnabled();
  let unavailable = configured ? null : "Event search and volume charts are unavailable for this deployment.";
  if (configured) {
    try {
      [events, stats, dailyEvents] = await Promise.all([
        listSourceEvents(workspaceId, source.id, 50),
        getSourceEventStats(workspaceId, source.id),
        getSourceDailyUsage(workspaceId, source.id, 14, { timezone }),
      ]);
    } catch {
      unavailable = "Source analytics are temporarily unavailable. Try again shortly.";
    }
  }

  return (
    <>
      {unavailable ? (
        <section className="mb-6 rounded-lg border border-border bg-card p-5" aria-label="Source analytics unavailable">
          <h2 className="text-sm font-medium text-foreground">Source analytics unavailable</h2>
          <p className="mt-1 text-sm text-muted-foreground">{unavailable}</p>
        </section>
      ) : <EventStreamChart
        rows={densifyDailySeries(
          dailyEvents,
          14,
          (day) => ({ day, events: 0, bytes: 0 }),
          timezone,
        )}
      />}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Source events stats">
        <StatCard
          label="Events received (all time)"
          value={stats ? formatCount(stats.total_events) : "—"}
          sub={stats?.first_seen ? `since ${stats.first_seen.slice(0, 10)}` : unavailable ? "analytics unavailable" : "no events yet"}
        />
        <StatCard
          label="Last 24h"
          value={stats ? formatCount(stats.events_24h) : "—"}
          sub="rolling window"
        />
        <StatCard
          label="Total bytes ingested"
          value={stats ? formatBytes(stats.bytes_total) : "—"}
          sub="raw payloads in R2"
        />
        <StatCard
          label="Routes attached"
          value={String(source.routes_attached)}
          sub="active"
        />
      </section>

      {!unavailable ? <Section
        id="recent-events"
        title="Recent events"
        pill={`last ${events.length} of ${stats ? formatCount(stats.total_events) : "0"}`}
        className="first:mt-0"
      >
        {events.length === 0 ? (
          <EmptyState
            title="No events yet"
            body={
              source.status === "disabled"
                ? "This source is disabled. Enable it to start collecting."
                : "Events will appear here within seconds of the first webhook hitting the ingest endpoint."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event id</TableHead>
                <TableHead>Received at</TableHead>
                <TableHead>Content type</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Shard</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.event_id}>
                  <TableCell>
                    <Link
                      href={`/sources/${source.id}/events/${event.event_id}`}
                      prefetch={false}
                      className="font-mono text-xs text-foreground hover:underline"
                    >
                      {event.event_id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <LocalTime value={clickhouseToIso(event.received_at)} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{event.content_type}</TableCell>
                  <TableCell className="text-sm">{formatBytes(event.size_bytes)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    shard {event.shard.toString().padStart(2, "0")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section> : null}
    </>
  );
}

function EventStreamChart({ rows }: { rows: DailyUsageRow[] }) {
  const max = rows.reduce((acc, row) => Math.max(acc, row.events), 0);
  const totalEvents = rows.reduce((acc, row) => acc + row.events, 0);
  const totalBytes = rows.reduce((acc, row) => acc + row.bytes, 0);

  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5" aria-labelledby="event-stream-title">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Event stream
          </p>
          <h2 id="event-stream-title" className="font-mono text-2xl font-semibold text-foreground">
            {formatCount(totalEvents)} events
          </h2>
          <small className="text-xs text-muted-foreground">
            Last {rows.length} days · {formatBytes(totalBytes)}
          </small>
        </div>
        <Badge variant="outline">daily volume</Badge>
      </div>
      <div
        className="flex h-48 items-end gap-1"
        role="img"
        aria-label={`Daily event stream for the last ${rows.length} days`}
      >
        {rows.map((row) => {
          const heightPct = max > 0 ? Math.max(3, (row.events / max) * 100) : 3;
          return (
            <span
              key={row.day}
              className="group relative flex-1 rounded-sm bg-primary/70 transition-colors hover:bg-primary"
              style={{ height: `${heightPct}%` }}
              title={`${row.day}: ${formatCount(row.events)} events · ${formatBytes(row.bytes)}`}
            >
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-popover px-1.5 py-0.5 font-mono text-[10px] font-semibold text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                {formatCount(row.events)}
              </span>
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{rows[0]?.day ?? ""}</span>
        <span>{rows[rows.length - 1]?.day ?? ""}</span>
      </div>
    </section>
  );
}

function clickhouseToIso(raw: string): string {
  return raw.replace(" ", "T") + "Z";
}
