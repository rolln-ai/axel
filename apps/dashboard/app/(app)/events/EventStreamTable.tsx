import Link from "next/link";
import { LocalTime } from "../../_components/LocalTime";
import { formatBytes } from "../../../lib/usage";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface EventStreamRow {
  event_id: string;
  source_id: string;
  /** Resolved source name, or null when the source row couldn't be loaded. */
  source_name: string | null;
  /** Already normalised to an ISO timestamp for <LocalTime>. */
  received_at: string;
  content_type: string;
  size_bytes: number;
  shard: number;
}

/**
 * Workspace-wide inbound event stream — the read-only counterpart to
 * {@link import("../deliveries/DeliveryStreamTable").DeliveryStreamTable}.
 * Events have no actions (no replay/selection), so this is a plain server
 * component: each row links out to the existing per-source event detail page.
 */
export function EventStreamTable({ rows }: { rows: EventStreamRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Content type</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead>Shard</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.event_id}>
            <TableCell className="text-sm text-muted-foreground">
              <LocalTime value={row.received_at} />
            </TableCell>
            <TableCell>
              <Link
                href={`/sources/${row.source_id}/events/${row.event_id}`}
                prefetch={false}
                className="font-mono text-xs text-foreground hover:underline"
              >
                {row.event_id}
              </Link>
            </TableCell>
            <TableCell>
              <Link
                href={`/sources/${row.source_id}`}
                prefetch={false}
                className="text-sm text-foreground hover:underline"
              >
                {row.source_name ?? (
                  <code className="font-mono text-xs text-muted-foreground">{row.source_id}</code>
                )}
              </Link>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{row.content_type}</TableCell>
            <TableCell className="text-right text-sm">{formatBytes(row.size_bytes)}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              shard {row.shard.toString().padStart(2, "0")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
