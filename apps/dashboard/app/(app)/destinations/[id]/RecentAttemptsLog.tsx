import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatLatency, type RecentAttemptRow } from "../../../../lib/destination-metrics";

/**
 * Most recent delivery attempts with timestamp, route, status, latency, and a
 * compact response excerpt. Each row links to the source-event detail page so
 * an operator can drill into the full payload.
 */
export function RecentAttemptsLog({
  rows,
  emptyMessage,
}: {
  rows: RecentAttemptRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <small className="text-sm text-muted-foreground">
          {emptyMessage ?? "No delivery attempts logged yet."}
        </small>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[180px]">When</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Route / event</TableHead>
          <TableHead className="text-right">Attempt #</TableHead>
          <TableHead className="text-right">Latency</TableHead>
          <TableHead>Response</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.attempt_id}>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {formatTimestamp(row.created_at)}
            </TableCell>
            <TableCell>
              {/* A suppressed attempt (breaker open, pause, rate limit) is
                  not a destination failure — labelling it "failure" made a
                  paused destination look like a broken one. */}
              <Badge
                variant={
                  row.status === "success"
                    ? "default"
                    : row.status === "dead"
                      ? "destructive"
                      : "secondary"
                }
                className="capitalize"
              >
                {row.status === "success"
                  ? "success"
                  : row.skip_reason && row.status === "retry"
                    ? "skipped"
                    : "failure"}
              </Badge>
            </TableCell>
            <TableCell className="space-y-0.5">
              <Link
                href={`/routes/${row.route_id}`}
                className="block font-mono text-xs text-foreground hover:underline"
              >
                {row.route_id}
              </Link>
              <small className="block font-mono text-[10px] text-muted-foreground">
                event {row.event_id}
                {row.is_test ? (
                  <span className="ml-1 rounded bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wide">
                    test
                  </span>
                ) : null}
              </small>
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{row.attempt_no}</TableCell>
            <TableCell className="text-right font-mono text-xs">
              {formatLatency(row.latency_ms)}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {row.http_status !== null ? (
                <span className={httpStatusColor(row.http_status)}>{row.http_status}</span>
              ) : null}
              {row.error ? (
                <span
                  className="ml-1 text-rose-600 dark:text-rose-400"
                  title={row.error}
                >
                  {truncate(row.error, 48)}
                </span>
              ) : null}
              {row.skip_reason && !row.error ? (
                <span
                  className="text-amber-600 dark:text-amber-400"
                  title="The delivery path held this attempt back without contacting the destination"
                >
                  {truncate(row.skip_reason, 48)}
                </span>
              ) : null}
              {row.http_status === null && !row.error && !row.skip_reason ? (
                <span className="text-muted-foreground">—</span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatTimestamp(raw: string): string {
  const ts = Date.parse(raw.replace(" ", "T") + "Z");
  if (!Number.isFinite(ts)) return raw;
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function httpStatusColor(status: number): string {
  if (status >= 200 && status < 300) return "text-emerald-600 dark:text-emerald-400";
  if (status >= 400 && status < 500) return "text-amber-600 dark:text-amber-400";
  if (status >= 500) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
