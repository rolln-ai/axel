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
import { formatCount } from "../../../../lib/usage";
import {
  formatLatency,
  formatRelative,
  type DestinationRouteHealthRow,
} from "../../../../lib/destination-metrics";

interface AttachmentRow {
  route_id: string;
  source_id: string;
  source_name: string;
  status: "active" | "disabled" | "errored";
}

/**
 * Existing "Routes using this destination" table augmented with 24h delivery
 * health columns. Routes with zero traffic still appear (config-time link
 * exists but no events delivered yet).
 */
export function RouteHealthTable({
  attachments,
  health,
}: {
  attachments: AttachmentRow[];
  health: DestinationRouteHealthRow[];
}) {
  const healthByRoute = new Map(health.map((h) => [h.route_id, h]));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Route</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">24h attempts</TableHead>
          <TableHead className="text-right">Success rate</TableHead>
          <TableHead className="text-right">Avg latency</TableHead>
          <TableHead className="text-right">Last attempt</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attachments.map((a) => {
          const h = healthByRoute.get(a.route_id);
          return (
            <TableRow key={a.route_id}>
              <TableCell>
                <Link
                  href={`/routes/${a.route_id}`}
                  className="font-mono text-xs text-foreground hover:underline"
                >
                  {a.route_id}
                </Link>
              </TableCell>
              <TableCell>
                <Link
                  href={`/sources/${a.source_id}`}
                  className="text-sm text-foreground hover:underline"
                >
                  {a.source_name}
                </Link>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    a.status === "active"
                      ? "default"
                      : a.status === "errored"
                        ? "destructive"
                        : "secondary"
                  }
                  className="capitalize"
                >
                  {a.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {h ? (
                  <span className="text-foreground">
                    {formatCount(h.total)}
                    {h.dead > 0 ? (
                      <span className="ml-1 text-rose-500">({formatCount(h.dead)} failed)</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {h && h.total > 0 ? (
                  <span className={successColor(h.successRate)}>
                    {(h.successRate * 100).toFixed(h.total > 1000 ? 2 : 1)}%
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {h && h.total > 0 ? (
                  <span className="text-foreground">{formatLatency(h.avgLatencyMs)}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {h?.lastAttemptAt ? formatRelative(h.lastAttemptAt) : "never"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function successColor(rate: number): string {
  if (rate >= 0.99) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.9) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}
