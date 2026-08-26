"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveDriftAction } from "../../../../lib/data-contracts/actions";
import type { DriftCategory } from "../../../../lib/data-contracts/repository";
import { LocalTime } from "../../../_components/LocalTime";
import { useAction } from "../../../_components/useAction";
import { useActionStateToast } from "../../../_components/Toast";

interface DriftRow {
  id: string;
  data_contract_id: string;
  data_contract_name: string;
  category: DriftCategory;
  field_path: string | null;
  observed_at: string;
}

/**
 * Unresolved drift events for the source's Data Contracts. The detector
 * fires from the 15-min cron (AXE-47 + cron PR) and dedups against
 * existing unresolved rows, so the same drift won't appear twice.
 *
 * Resolution semantics: marking a drift resolved doesn't change the
 * Data Contract schema. It just acknowledges "I saw this, no action needed,
 * stop nagging me." When the schema actually drifts in a way that
 * requires accommodation, the operator re-runs Understand source → new
 * version → old unresolved drifts can be batch-resolved.
 *
 * Eventually a "Resolve all + create new version" composite action is
 * the right move; for now individual rows + manual re-Understand keeps
 * the surface predictable.
 */
const CATEGORY_LABEL: Record<DriftCategory, string> = {
  new_event_type: "New event type",
  missing_field: "Required field missing",
  type_change: "Field type changed",
  new_sensitive_field: "New sensitive field",
  unknown_shape: "Unknown shape",
};

const CATEGORY_SEVERITY: Record<DriftCategory, "high" | "warning" | "info"> = {
  new_sensitive_field: "high",
  missing_field: "warning",
  type_change: "warning",
  unknown_shape: "warning",
  new_event_type: "info",
};

export function DriftPanel({
  sourceId,
  drifts,
  canResolve,
}: {
  sourceId: string;
  drifts: DriftRow[];
  canResolve: boolean;
}) {
  if (drifts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <ShieldAlert className="mr-1 inline size-3.5 align-text-bottom" /> No
        unresolved drift on this source's Data Contracts. New event types, missing
        fields, type changes, and newly-observed sensitive fields will show up
        here as Axel detects them.
      </div>
    );
  }
  return (
    <ul className="grid gap-2">
      {drifts.map((d) => (
        <DriftRowItem
          key={d.id}
          row={d}
          sourceId={sourceId}
          canResolve={canResolve}
        />
      ))}
    </ul>
  );
}

function DriftRowItem({
  row,
  sourceId,
  canResolve,
}: {
  row: DriftRow;
  sourceId: string;
  canResolve: boolean;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const resolve = useAction(resolveDriftAction, {
    onSuccess: () => {
      setHidden(true);
      router.refresh();
    },
  });
  const { pending } = resolve;
  // A failed resolve used to vanish silently; surface the server's error.
  useActionStateToast({ error: resolve.error });
  if (hidden) return null;

  const severity = CATEGORY_SEVERITY[row.category];
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-start gap-2 min-w-0">
        {severity === "high" ? (
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        ) : severity === "warning" ? (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500/80" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {CATEGORY_LABEL[row.category]}
            </span>
            {row.field_path ? (
              <code className="font-mono text-[11px] text-muted-foreground">
                {row.field_path}
              </code>
            ) : null}
            <SeverityBadge severity={severity} />
          </div>
          <span className="text-[10px] text-muted-foreground">
            on{" "}
            <Link
              href={`/data-contracts/${row.data_contract_id}`}
              className="text-foreground hover:underline"
            >
              {row.data_contract_name}
            </Link>{" "}
            • <LocalTime value={row.observed_at} />
          </span>
        </div>
      </div>
      {canResolve ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => resolve.run(row.id, sourceId)}
        >
          {pending ? "Resolving…" : "Resolve"}
        </Button>
      ) : null}
    </li>
  );
}

function SeverityBadge({ severity }: { severity: "high" | "warning" | "info" }) {
  if (severity === "high") return <Badge variant="destructive">high</Badge>;
  if (severity === "warning") return <Badge variant="default">warning</Badge>;
  return <Badge variant="secondary">info</Badge>;
}
