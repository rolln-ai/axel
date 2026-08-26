"use client";

/**
 * Sample-payload picker that lives next to the canvas. Lists recent
 * real events for the source via `listRecentSamplePayloads`; loads
 * one via `loadSamplePayload`. Also accepts pasted JSON for ad-hoc
 * what-if experiments.
 */
import { useState, useTransition } from "react";
import { listRecentSamplePayloads, loadSamplePayload, type RecentSampleRow } from "../../../../../lib/route-canvas-actions";

interface Props {
  sourceId: string;
  onLoaded: (payload: unknown, summary: string) => void;
}

const TWO_MB = 2 * 1024 * 1024;

export function SampleLoader({ sourceId, onLoaded }: Props) {
  const [tab, setTab] = useState<"recent" | "paste">("recent");
  const [samples, setSamples] = useState<RecentSampleRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [isLoading, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      setListError(null);
      const res = await listRecentSamplePayloads(sourceId);
      if (res.ok) {
        setSamples(res.samples);
      } else {
        setListError(reasonLabel(res.reason));
        setSamples([]);
      }
    });
  }

  function loadOne(row: RecentSampleRow) {
    if (row.size_bytes > TWO_MB) return;
    setActiveId(row.event_id);
    startTransition(async () => {
      const res = await loadSamplePayload(sourceId, row.event_id);
      if (res.ok) {
        onLoaded(res.payload, `Recent event · ${row.event_id.slice(0, 14)}…`);
      } else {
        setListError(reasonLabel(res.reason));
      }
    });
  }

  function loadPasted() {
    setPasteError(null);
    try {
      const parsed = JSON.parse(pasteText);
      onLoaded(parsed, "Pasted JSON");
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-1 border-b border-border pb-2">
        <button
          type="button"
          className={`rounded px-2 py-1 text-xs ${tab === "recent" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
          onClick={() => {
            setTab("recent");
            if (samples === null) refresh();
          }}
        >
          Recent events
        </button>
        <button
          type="button"
          className={`rounded px-2 py-1 text-xs ${tab === "paste" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
          onClick={() => setTab("paste")}
        >
          Paste JSON
        </button>
        <div className="ml-auto">
          {tab === "recent" ? (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={refresh}
              disabled={isLoading}
            >
              ↻ refresh
            </button>
          ) : null}
        </div>
      </div>

      {tab === "recent" ? (
        <div className="space-y-1">
          {samples === null ? (
            <p className="text-xs text-muted-foreground">
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={refresh}
              >
                Load recent events
              </button>
              {" "}for this source.
            </p>
          ) : null}
          {listError ? <p className="text-xs text-destructive">{listError}</p> : null}
          {samples && samples.length === 0 && !listError ? (
            <p className="text-xs text-muted-foreground">No events received yet.</p>
          ) : null}
          {samples?.map((s) => {
            const tooBig = s.size_bytes > TWO_MB;
            const isActive = s.event_id === activeId;
            return (
              <button
                key={s.event_id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] ${
                  isActive ? "bg-muted" : "hover:bg-muted/60"
                } ${tooBig ? "cursor-not-allowed opacity-50" : ""}`}
                onClick={() => loadOne(s)}
                disabled={tooBig || isLoading}
                title={tooBig ? "Payload over 2 MB — too large for browser preview" : "Load this payload into the canvas"}
              >
                <span className="font-mono text-foreground">{s.event_id.slice(0, 14)}…</span>
                <span className="text-muted-foreground">{formatBytes(s.size_bytes)}</span>
                <span className="ml-auto text-muted-foreground">{s.received_at.slice(11, 19)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {tab === "paste" ? (
        <div className="space-y-2">
          <textarea
            className="h-40 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"event_id":"evt_1","type":"order.created","amount":1234}'
          />
          {pasteError ? <p className="text-xs text-destructive">{pasteError}</p> : null}
          <button
            type="button"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
            onClick={loadPasted}
            disabled={pasteText.trim().length === 0}
          >
            Load
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "source_not_found":
      return "Source not found in this workspace.";
    case "clickhouse_not_configured":
      return "ClickHouse isn't configured — can't list recent events.";
    case "clickhouse_failed":
      return "ClickHouse query failed.";
    case "event_not_found":
      return "Event not found.";
    case "payload_too_large":
      return "Payload too large to preview in the browser.";
    case "r2_fetch_failed":
      return "Could not load the payload from R2.";
    default:
      return reason;
  }
}
