"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Eye, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setDataContractStatusAction } from "../../../../lib/data-contracts/actions";
import type { DataContractStatus } from "../../../../lib/data-contracts/repository";
import { useAction } from "../../../_components/useAction";

/**
 * Status bar with explicit, user-readable copy about what each transition
 * does. The earlier minimal version had a bare "Activate" button with no
 * context — operators couldn't tell whether activation enabled routing,
 * started drift watching, or just renamed something.
 *
 * Current behaviour of each transition (kept in sync with the runtime):
 *
 *   draft → active
 *     - This version becomes the workspace's contract for the source.
 *     - Drift detection starts watching incoming events against this
 *       schema. Drift goes to the notifications bell.
 *     - Doesn't yet auto-attach a route — that still happens via the
 *       routes UI. But generated transforms (when they exist) become
 *       valid candidates for the edge router engine.
 *
 *   active → archived
 *     - Stop drift watching; stop using this version for failure
 *       explanation. Existing routes still reference the version id, so
 *       past replay attempts stay reproducible.
 *
 *   archived → draft
 *     - Bring it back into editing without re-activating. Drift stays
 *       off until you re-activate.
 */
const NEXT_STATUS: Record<DataContractStatus, DataContractStatus | null> = {
  draft: "active",
  active: "archived",
  archived: "draft",
};

interface CopyBlock {
  current_summary: string;
  cta_label: string;
  next_status: DataContractStatus;
  what_happens_next: string[];
  what_doesnt_happen: string[];
  icon: React.ReactNode;
  Variant: typeof Button extends never ? never : "default" | "outline" | "secondary";
}

const COPY: Record<DataContractStatus, CopyBlock | null> = {
  draft: {
    current_summary:
      "This Data Contract is a draft. It's a saved schema you can edit, but Axel isn't watching live events against it yet.",
    cta_label: "Activate",
    next_status: "active",
    what_happens_next: [
      "This version becomes the workspace's contract for this source.",
      "Drift detection starts watching incoming events; alerts land in the notifications bell.",
      "Failure explanations on Event-Map-backed routes will use this version's schema.",
    ],
    what_doesnt_happen: [
      "No route is created or modified — attaching to a route still happens from the Routes UI.",
      "Raw events keep being archived to R2 verbatim — nothing about ingest changes.",
      "You can still edit annotations later; edits create a new version, leaving this one intact.",
    ],
    icon: <ShieldCheck className="size-4 text-emerald-500/80" aria-hidden />,
    Variant: "default",
  },
  active: {
    current_summary:
      "This Data Contract is active. Axel is watching incoming events against this schema and will surface drift in notifications.",
    cta_label: "Archive",
    next_status: "archived",
    what_happens_next: [
      "Drift detection stops watching this map.",
      "Failure-explanation flows stop using this version's schema.",
      "Existing routes that reference this version stay reproducible for past replays.",
    ],
    what_doesnt_happen: [
      "Routes are NOT detached or paused. Routing keeps running.",
      "The version itself isn't deleted — archive is reversible.",
    ],
    icon: <Lock className="size-4 text-muted-foreground" aria-hidden />,
    Variant: "outline",
  },
  archived: {
    current_summary:
      "This Data Contract is archived. It's read-only — useful as audit history but not driving any live behaviour.",
    cta_label: "Restore to draft",
    next_status: "draft",
    what_happens_next: [
      "Becomes editable again as a draft.",
      "Drift watching stays OFF until you activate the new draft.",
    ],
    what_doesnt_happen: [
      "Restoring doesn't automatically re-enable drift — that needs a second click.",
      "Past drift / failure history tied to this Data Contract stays visible.",
    ],
    icon: <AlertTriangle className="size-4 text-amber-500/80" aria-hidden />,
    Variant: "outline",
  },
};

export function DataContractStatusBar({
  dataContractId,
  currentStatus,
}: {
  dataContractId: string;
  currentStatus: DataContractStatus;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { run, pending, error, reset } = useAction(setDataContractStatusAction, {
    onSuccess: () => {
      setConfirmOpen(false);
      router.refresh();
    },
  });

  const copy = COPY[currentStatus];
  const next = NEXT_STATUS[currentStatus];
  if (!copy || !next) return null;

  return (
    <div className="mb-6 rounded-md border border-border bg-card">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="flex items-start gap-3 min-w-0">
          {copy.icon}
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Status: {currentStatus}
            </span>
            <p className="text-sm text-foreground">{copy.current_summary}</p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={copy.Variant}
          disabled={pending}
          onClick={() => setConfirmOpen((v) => !v)}
        >
          {pending ? "Working…" : copy.cta_label}
        </Button>
      </div>
      {confirmOpen ? (
        <div className="grid gap-3 border-t border-border bg-muted/30 px-4 py-3">
          <div className="grid gap-2 md:grid-cols-2 md:gap-6">
            <div>
              <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                <Check className="size-3" /> What this does
              </h3>
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {copy.what_happens_next.map((line) => (
                  <li key={line} className="flex items-start gap-1">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground/40" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                <Eye className="size-3" /> What stays the same
              </h3>
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {copy.what_doesnt_happen.map((line) => (
                  <li key={line} className="flex items-start gap-1">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground/40" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                reset();
                setConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => run(dataContractId, next)}
            >
              {pending ? "Working…" : `Confirm ${copy.cta_label.toLowerCase()}`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
