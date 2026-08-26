"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import {
  requestReplay,
  requestReplayAllUnresolved,
  requestReplayBulk,
} from "../../../lib/replay-actions";
import type { ActionState } from "../../../lib/action-data";
import { LocalTime } from "../../_components/LocalTime";
import { ReplayStateBadge } from "../../_components/StatusBadges";
import { useToast } from "../../_components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface DeliveryStreamRow {
  id: string;
  kind: "attempt" | "dead_letter";
  event_id: string;
  source_id: string | null;
  route_id: string;
  destination_id: string | null;
  destination_name: string | null;
  destination_type: string | null;
  status: "success" | "retry" | "dead";
  status_at: string;
  attempt_no: number | null;
  latency_ms: number | null;
  response: {
    destination_type?: string;
    http_status?: number;
    error?: string;
  } & Record<string, unknown>;
  dead_letter: {
    id: string;
    reason: string;
    message: string | null;
    replay: ReplayStatus | null;
  } | null;
}

type ReplayStatus = {
  id: string;
  state: "pending" | "in_progress" | "done" | "failed";
  requested_at: string;
  finished_at: string | null;
  error_message: string | null;
};

export function DeliveryStreamTable({
  rows,
  canReplay,
  unresolvedTotal,
}: {
  rows: DeliveryStreamRow[];
  canReplay: boolean;
  unresolvedTotal: number;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkState, bulkAction, bulkPending] = useActionState<ActionState, FormData>(
    requestReplayBulk,
    {},
  );
  const [allState, allAction, allPending] = useActionState<ActionState, FormData>(
    requestReplayAllUnresolved,
    {},
  );
  const toast = useToast();

  useEffect(() => {
    if (bulkState.notice) toast.success(bulkState.notice);
    if (bulkState.error) toast.error(bulkState.error);
  }, [bulkState.notice, bulkState.error, toast]);

  useEffect(() => {
    if (allState.notice) toast.success(allState.notice);
    if (allState.error) toast.error(allState.error);
  }, [allState.notice, allState.error, toast]);

  const replayableRows = useMemo(
    () => rows.filter((row) => row.dead_letter && !isReplayActive(row.dead_letter.replay)),
    [rows],
  );
  const replayableIds = useMemo(() => new Set(replayableRows.map((row) => row.dead_letter!.id)), [replayableRows]);
  const allSelected = replayableRows.length > 0 && selected.size === replayableRows.length;
  const someSelected = selected.size > 0 && selected.size < replayableRows.length;
  const hasBacklogBeyondPage = unresolvedTotal > replayableRows.length;

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((id) => replayableIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [replayableIds]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(replayableRows.map((row) => row.dead_letter!.id)));
    }
  }

  const selectedCsv = useMemo(() => Array.from(selected).join(","), [selected]);
  const allCsv = useMemo(() => replayableRows.map((row) => row.dead_letter!.id).join(","), [replayableRows]);

  return (
    <>
      {canReplay && replayableRows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-3">
          <span className="text-sm text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} selected`
              : `${replayableRows.length} unresolved ${replayableRows.length === 1 ? "failure" : "failures"} can be replayed.`}
          </span>
          <div className="inline-flex items-center gap-2">
            {selected.size > 0 ? (
              <form action={bulkAction} className="inline-flex items-center gap-2">
                <input type="hidden" name="dead_letter_ids" value={selectedCsv} />
                <Button
                  type="submit"
                  size="sm"
                  disabled={bulkPending}
                  onClick={() => setSelected(new Set())}
                >
                  <RotateCcw className="size-3.5" />
                  {bulkPending ? "Queueing..." : `Replay ${selected.size} selected`}
                </Button>
              </form>
            ) : (
              <>
                <form action={bulkAction} className="inline-flex items-center gap-2">
                  <input type="hidden" name="dead_letter_ids" value={allCsv} />
                  <Button type="submit" variant="outline" size="sm" disabled={bulkPending}>
                    <RotateCcw className="size-3.5" />
                    {bulkPending ? "Queueing..." : `Replay all ${replayableRows.length} on page`}
                  </Button>
                </form>
                {hasBacklogBeyondPage ? (
                  <form action={allAction} className="inline-flex items-center gap-2">
                    <Button type="submit" size="sm" disabled={allPending}>
                      <RotateCcw className="size-3.5" />
                      {allPending ? "Queueing..." : `Replay all ${unresolvedTotal} unresolved`}
                    </Button>
                  </form>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            {canReplay ? (
              <TableHead className="w-9">
                <input
                  type="checkbox"
                  aria-label="Select all replayable failed deliveries"
                  className="size-4 cursor-pointer accent-primary"
                  checked={allSelected}
                  disabled={replayableRows.length === 0}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                />
              </TableHead>
            ) : null}
            <TableHead>When</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead className="text-right">Attempt</TableHead>
            <TableHead className="text-right">Latency</TableHead>
            <TableHead>Response</TableHead>
            <TableHead>Replay</TableHead>
            {canReplay ? <TableHead className="text-right">Action</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const deadLetterId = row.dead_letter?.id ?? null;
            const replayActive = isReplayActive(row.dead_letter?.replay ?? null);
            return (
              <TableRow key={row.id}>
                {canReplay ? (
                  <TableCell>
                    {deadLetterId ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.event_id}`}
                        className="size-4 cursor-pointer accent-primary"
                        checked={selected.has(deadLetterId)}
                        disabled={replayActive}
                        onChange={() => toggleOne(deadLetterId)}
                      />
                    ) : null}
                  </TableCell>
                ) : null}
                <TableCell className="text-sm text-muted-foreground">
                  <LocalTime value={row.status_at} />
                </TableCell>
                <TableCell>
                  <DeliveryStatus row={row} />
                </TableCell>
                <TableCell>
                  {row.source_id ? (
                    <Link
                      href={`/sources/${row.source_id}/events/${originalEventId(row.event_id)}`}
                      className="font-mono text-xs text-foreground hover:underline"
                    >
                      {row.event_id}
                    </Link>
                  ) : (
                    <code className="font-mono text-xs">{row.event_id}</code>
                  )}
                </TableCell>
                <TableCell>
                  {row.route_id ? (
                    <code className="font-mono text-xs">{row.route_id}</code>
                  ) : (
                    <small className="text-xs text-muted-foreground">(routing)</small>
                  )}
                </TableCell>
                <TableCell>
                  {row.destination_id ? (
                    <Link
                      href={`/destinations/${row.destination_id}`}
                      className="group inline-flex flex-col gap-0.5"
                    >
                      <span className="text-xs font-medium text-foreground group-hover:underline">
                        {row.destination_name ?? row.destination_id}
                      </span>
                      {row.destination_type ? (
                        <span className="text-[11px] text-muted-foreground">{row.destination_type}</span>
                      ) : null}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {row.attempt_no ?? "-"}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {row.latency_ms === null ? "-" : formatLatency(row.latency_ms)}
                </TableCell>
                <TableCell className="max-w-80">
                  <ResponseSummary row={row} />
                </TableCell>
                <TableCell>
                  <ReplayStatusCell replay={row.dead_letter?.replay ?? null} />
                </TableCell>
                {canReplay ? (
                  <TableCell className="text-right">
                    {deadLetterId ? (
                      <SingleReplayButton deadLetterId={deadLetterId} replay={row.dead_letter?.replay ?? null} />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function DeliveryStatus({ row }: { row: DeliveryStreamRow }) {
  if (row.status === "success") {
    return <span className="text-sm font-medium text-foreground">Success</span>;
  }

  return (
    <Badge variant={row.status === "dead" ? "destructive" : "secondary"}>
      {row.dead_letter ? "Failed" : "Failure (retry)"}
    </Badge>
  );
}

function ResponseSummary({ row }: { row: DeliveryStreamRow }) {
  if (row.dead_letter) {
    return (
      <div className="space-y-1">
        <Badge variant="destructive">{row.dead_letter.reason}</Badge>
        {row.dead_letter.message ? (
          <small className="block truncate text-xs text-muted-foreground" title={row.dead_letter.message}>
            {row.dead_letter.message}
          </small>
        ) : null}
      </div>
    );
  }

  const httpStatus = row.response.http_status;
  const error = row.response.error;
  if (typeof httpStatus !== "number" && !error) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <>
      {typeof httpStatus === "number" ? (
        <span className={httpStatusColor(httpStatus)}>{httpStatus}</span>
      ) : null}
      {error ? (
        <span className="ml-1 text-rose-600 dark:text-rose-400" title={error}>
          {truncate(error, 52)}
        </span>
      ) : null}
    </>
  );
}

function ReplayStatusCell({ replay }: { replay: ReplayStatus | null }) {
  if (!replay) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }

  return (
    <div className="space-y-1">
      <ReplayStateBadge
        state={replay.state}
        label={replayStatusLabel(replay.state)}
        className="capitalize"
      />
      <small className="block text-xs text-muted-foreground">
        <LocalTime value={replay.requested_at} />
      </small>
      {replay.error_message ? (
        <small className="block max-w-64 truncate text-xs text-destructive" title={replay.error_message}>
          {replay.error_message}
        </small>
      ) : null}
    </div>
  );
}

function SingleReplayButton({
  deadLetterId,
  replay,
}: {
  deadLetterId: string;
  replay: ReplayStatus | null;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(requestReplay, {});
  const toast = useToast();
  const replayActive = isReplayActive(replay);

  useEffect(() => {
    if (state.notice) toast.success("Replay queued");
    if (state.error) toast.error(state.error);
  }, [state.notice, state.error, toast]);

  return (
    <form action={formAction}>
      <input type="hidden" name="dead_letter_id" value={deadLetterId} />
      <Button type="submit" variant="outline" size="xs" disabled={pending || replayActive}>
        <RotateCcw className="size-3" />
        {pending
          ? "Queueing..."
          : state.notice || replay?.state === "pending"
            ? "Queued"
            : replay?.state === "in_progress"
              ? "Running"
              : "Replay"}
      </Button>
    </form>
  );
}

function isReplayActive(replay: ReplayStatus | null): boolean {
  return replay?.state === "pending" || replay?.state === "in_progress";
}

function replayStatusLabel(state: "pending" | "in_progress" | "done" | "failed"): string {
  if (state === "done") return "Successful";
  return state.replace("_", " ");
}

function originalEventId(eventId: string): string {
  return eventId.replace(/#rpy_[A-Za-z0-9_-]+$/, "");
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function httpStatusColor(status: number): string {
  if (status >= 200 && status < 300) return "text-emerald-600 dark:text-emerald-400";
  if (status >= 400 && status < 500) return "text-amber-600 dark:text-amber-400";
  if (status >= 500) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
