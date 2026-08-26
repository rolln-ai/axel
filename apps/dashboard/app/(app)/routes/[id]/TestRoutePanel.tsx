"use client";

import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { testRouteAgainstRecentEvents, type TestRouteResult } from "../../../../lib/route-test-actions";
import { useAction } from "../../../_components/useAction";

export function TestRoutePanel({ routeId, sourceId }: { routeId: string; sourceId: string }) {
  const test = useAction(testRouteAgainstRecentEvents);
  const { pending, error } = test;
  const results =
    test.result && !("error" in test.result) ? test.result.results : null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Pulls the last 10 events received by this source, runs the route&apos;s filter and
        transform locally, and shows what the edge router would have done. Read-only — never
        enqueues a delivery.
      </p>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => test.run(routeId, sourceId)}
      >
        {pending ? "Running…" : results ? "Re-run" : "Run against last 10 events"}
      </Button>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {results && results.length === 0 ? (
        <Alert>
          <AlertDescription>
            No recent events for this source. Send one through the test sender on the source page
            to populate the inbox.
          </AlertDescription>
        </Alert>
      ) : null}

      {results && results.length > 0 ? (
        <div className="space-y-2">
          {results.map((r) => (
            <div key={r.event_id} className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <code className="font-mono text-[11px] text-muted-foreground">{r.event_id}</code>
                <Verdict result={r} />
              </div>
              {r.error ? (
                <pre className="overflow-x-auto rounded bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
                  {r.error.reason}: {r.error.message}
                </pre>
              ) : r.deliveries.length > 0 ? (
                // DAG mode — one card per leaf delivery.
                <div className="space-y-2">
                  <div>
                    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Input
                    </h4>
                    <pre className="max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                      {pretty(r.payload_before)}
                    </pre>
                  </div>
                  <div className="grid gap-2">
                    {r.deliveries.map((d, i) => (
                      <div
                        key={`${d.leaf_node_id}-${i}`}
                        className="rounded border border-border p-2"
                      >
                        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                          <span>destination</span>
                          <code className="font-mono text-foreground">{d.destination_id}</code>
                          <span className="ml-auto text-muted-foreground/70">
                            leaf {d.leaf_node_id}
                          </span>
                        </div>
                        <pre className="max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                          {pretty(d.payload)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                // Legacy mode — single before/after pair.
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Before
                    </h4>
                    <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                      {pretty(r.payload_before)}
                    </pre>
                  </div>
                  <div>
                    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      After {r.skipped ? "(skipped — would not deliver)" : ""}
                    </h4>
                    <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                      {r.skipped ? "—" : pretty(r.payload_after)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Verdict({ result }: { result: TestRouteResult }) {
  if (result.error) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="size-3" /> dead-letter
      </Badge>
    );
  }
  if (result.skipped) {
    return (
      <Badge variant="secondary" className="gap-1">
        <XCircle className="size-3" /> filtered
      </Badge>
    );
  }
  if (result.deliveries.length > 0) {
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="size-3" />{" "}
        {result.deliveries.length} {result.deliveries.length === 1 ? "delivery" : "deliveries"}
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="gap-1">
      <CheckCircle2 className="size-3" /> would deliver
    </Badge>
  );
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
