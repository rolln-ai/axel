"use client";

import { useRouter } from "next/navigation";
import { Workflow, CheckCircle2, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  attachToRouteAction,
  proposeRouteArtifactsAction,
} from "../../../../lib/data-contracts/codegen-actions";
import { useAction } from "../../../_components/useAction";

/**
 * Codegen + attach-to-route UI (AXE-45 wrap-up). Renders next to the
 * destination mapping panel. Two buttons:
 *
 *   - Preview artifacts: shows the proposed filter + transform + fixture
 *     pass/fail count. Doesn't persist anything.
 *   - Attach to new route: persists a new Data Contract version with the
 *     artifacts + fixtures, runs the activation gate, and creates a
 *     route (engine='declarative') that the edge router executes
 *     inline. Atomic transaction.
 */
export function CodegenPanel({ dataContractId }: { dataContractId: string }) {
  const router = useRouter();
  const previewAction = useAction(proposeRouteArtifactsAction);
  const attachAction = useAction(attachToRouteAction, {
    onSuccess: () => router.refresh(),
  });
  const preview = previewAction.result;
  const attach = attachAction.result;

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Workflow className="size-3.5" /> Route codegen
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Generate filter + transform from the saved destination mapping. The edge
        router executes these declaratively (no sandbox eval). Attaching creates
        a route that delivers events through the patched shape; the activation
        gate refuses if any fixture would fail.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={previewAction.pending || attachAction.pending}
          onClick={() => previewAction.run(dataContractId)}
        >
          {previewAction.pending ? "Generating…" : "Preview artifacts"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={previewAction.pending || attachAction.pending}
          onClick={() => attachAction.run(dataContractId)}
        >
          {attachAction.pending ? "Attaching…" : "Attach to new route"}
        </Button>
      </div>

      {preview?.error ? (
        <Alert variant="destructive" className="mt-3 text-xs">
          <AlertDescription>{preview.error}</AlertDescription>
        </Alert>
      ) : null}

      {preview?.artifacts ? (
        <div className="mt-4 grid gap-3">
          <FixtureSummary
            passed={preview.artifacts.fixture_result.passed}
            total={preview.artifacts.fixture_result.total}
            canActivate={preview.artifacts.can_activate}
          />
          <DslPair
            label="Filter"
            value={preview.artifacts.filter}
          />
          <DslPair
            label="Transform"
            value={preview.artifacts.transform}
          />
        </div>
      ) : null}

      {attach?.error ? (
        <Alert variant="destructive" className="mt-3 text-xs">
          <AlertDescription>{attach.error}</AlertDescription>
        </Alert>
      ) : null}
      {attach?.notice ? (
        <Alert className="mt-3 text-xs">
          <CheckCircle2 className="size-4" />
          <AlertDescription>
            {attach.notice}{" "}
            {attach.route_id ? (
              <span className="text-muted-foreground">
                Route id{" "}
                <code className="font-mono text-foreground">
                  {attach.route_id}
                </code>
                .
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function FixtureSummary({
  passed,
  total,
  canActivate,
}: {
  passed: number;
  total: number;
  canActivate: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {canActivate ? (
        <Badge variant="default">
          <CheckCircle2 className="mr-1 inline size-3 align-text-bottom" />
          Activation gate: {passed}/{total}
        </Badge>
      ) : (
        <Badge variant="destructive">
          <AlertTriangle className="mr-1 inline size-3 align-text-bottom" />
          Gate refused: {passed}/{total}
        </Badge>
      )}
      <span className="text-muted-foreground">
        Fixtures synthesized from real samples; same runner used in the edge
        router.
      </span>
    </div>
  );
}

function DslPair({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-3">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-56 overflow-auto font-mono text-[11px] leading-relaxed text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
