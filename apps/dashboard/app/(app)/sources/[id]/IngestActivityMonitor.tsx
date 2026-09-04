"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Radio } from "lucide-react";
import { getRecentIngestEvents, type RecentIngestEvent } from "../../../../lib/test-event-actions";
import { LocalTime } from "../../../_components/LocalTime";

/**
 * Live ingest monitor for the New Source wizard's activation step. Instead of
 * firing a synthetic test event, this watches the source's ingest endpoint and
 * surfaces real provider traffic the moment it lands — the operator points
 * their provider at the webhook URL above and sees the first events show up
 * here. Polls {@link getRecentIngestEvents} on a short cadence while mounted.
 */
const POLL_INTERVAL_MS = 2_500;

function clickhouseToIso(raw: string): string {
  // ClickHouse returns "YYYY-MM-DD HH:MM:SS" in UTC; LocalTime wants an ISO
  // string it can parse. Mirrors the helper used across the source pages.
  return raw.replace(" ", "T") + "Z";
}

export function IngestActivityMonitor({
  sourceId,
  onEvents,
}: {
  sourceId: string;
  /** Called after each poll with the current event count — lets a host flow
   *  (e.g. first-run setup) mark its "first event" step complete. */
  onEvents?: (count: number) => void;
}) {
  const [events, setEvents] = useState<RecentIngestEvent[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  // Ref so a new callback identity doesn't restart the poll loop.
  const onEventsRef = useRef(onEvents);
  useEffect(() => {
    onEventsRef.current = onEvents;
  });

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const res = await getRecentIngestEvents(sourceId).catch(
        (): { error: string } => ({
          error: "Couldn't reach the ingest monitor.",
        }),
      );
      if (cancelledRef.current) return;
      if ("error" in res) {
        setNote(res.error);
      } else {
        setNote(null);
        setEvents(res.events);
        onEventsRef.current?.(res.events.length);
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [sourceId]);

  const waiting = events.length === 0;

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {waiting ? (
            <Radio className="size-4 text-primary" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden="true" />
          )}
          {waiting ? "Listening for events" : `Received ${events.length} event${events.length === 1 ? "" : "s"}`}
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" /> live
        </span>
      </div>

      {waiting ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {note
            ? note
            : "Send an event from your provider (or curl the webhook URL above). The moment one arrives at the ingest endpoint it shows up here."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li
              key={e.eventId}
              className="flex items-center justify-between gap-3 rounded-sm border border-border bg-card px-2.5 py-1.5"
            >
              <a
                href={`/sources/${sourceId}/events/${e.eventId}`}
                className="truncate font-mono text-[11px] underline"
                target="_blank"
                rel="noreferrer"
              >
                {e.eventId}
              </a>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                <LocalTime value={clickhouseToIso(e.receivedAt)} mode="relative" />
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[10px] text-muted-foreground">
        Live tail of the ingest endpoint — newest first. Full history is on the source&apos;s Events tab.
      </p>
    </div>
  );
}
