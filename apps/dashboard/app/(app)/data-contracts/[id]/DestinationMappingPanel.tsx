"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Save, Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DestinationTargetPicker } from "@/components/destination-target-picker";
import {
  listDestinationsForPickerAction,
  proposeDestinationMappingAction,
  saveDestinationMappingAction,
  type DestinationPickerOption,
} from "../../../../lib/data-contracts/destination-actions";
import type { DestinationMapping } from "../../../../lib/data-contracts/destination-mapping";
import { useAction } from "../../../_components/useAction";

/**
 * Picker UI for AXE-44 destination mapping proposals. Sits on the
 * Data Contract detail page below the cluster view. Reads destination
 * config + credentials server-side, proposes a Postgres / Mongo /
 * Webhook mapping, shows before/after on 3 sampled events, and saves
 * the chosen mapping as a new immutable version.
 */
export function DestinationMappingPanel({
  dataContractId,
  initialMapping,
}: {
  dataContractId: string;
  initialMapping: DestinationMapping | null;
}) {
  const router = useRouter();
  const [destinations, setDestinations] = useState<DestinationPickerOption[]>([]);
  const [selected, setSelected] = useState<string | null>(initialMapping?.destination_id ?? null);
  // Target table/collection — required for postgres/mongodb (they store the
  // target as a per-route binding, not on the destination).
  const [target, setTarget] = useState("");
  const propose = useAction(proposeDestinationMappingAction);
  const save = useAction(saveDestinationMappingAction, {
    onSuccess: () => router.refresh(),
  });
  const proposal = propose.result;
  const savedVersionId = save.result?.version_id ?? null;

  useEffect(() => {
    listDestinationsForPickerAction()
      .then(setDestinations)
      .catch(() => setDestinations([]));
  }, []);

  const selectedDestType = destinations.find((d) => d.id === selected)?.type;
  const needsTarget =
    selectedDestType === "postgres" ||
    selectedDestType === "mongodb" ||
    selectedDestType === "bigquery";

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Sparkles className="size-3.5" /> Destination mapping
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Pick a destination and Axel proposes a mapping that fits the schema you
        just inferred. Postgres → columns or JSONB. BigQuery → typed nested
        records. Mongo → doc shape + _id. Webhook → envelope or passthrough. You see a before/after
        preview before anything saves.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected ?? ""}
          onChange={(e) => {
            setSelected(e.target.value || null);
            setTarget("");
            propose.reset();
            save.reset();
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          aria-label="Pick a destination"
        >
          <option value="">Pick a destination…</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name ?? d.id} ({d.type})
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!selected || propose.pending || (needsTarget && !target.trim())}
          onClick={() => {
            if (!selected) return;
            save.reset();
            propose.run({
              dataContractId,
              destinationId: selected,
              ...(needsTarget ? { target: target.trim() } : {}),
            });
          }}
        >
          {propose.pending ? "Proposing…" : "Propose mapping"}
        </Button>
      </div>

      {needsTarget && selected ? (
        <div className="mt-3">
          <DestinationTargetPicker
            key={selected}
            destinationId={selected}
            destinationType={selectedDestType!}
            value={target}
            onChange={(next) => {
              setTarget(next);
              propose.reset();
              save.reset();
            }}
          />
        </div>
      ) : null}

      {initialMapping ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Current saved mapping for{" "}
          <code className="font-mono text-foreground">
            {initialMapping.destination_id}
          </code>{" "}
          (kind <Badge variant="secondary">{initialMapping.kind}</Badge>) is in
          this version's <code className="font-mono">destination_mapping</code>.
        </p>
      ) : null}

      {proposal?.error ? (
        <Alert variant="destructive" className="mt-3 text-xs">
          <AlertDescription>{proposal.error}</AlertDescription>
        </Alert>
      ) : null}

      {proposal?.proposal ? (
        <div className="mt-4 grid gap-3">
          <ProposalDetail proposal={proposal.proposal} />
          <PreviewGrid preview={proposal.preview ?? []} />
          <div className="flex items-center justify-end gap-2">
            {savedVersionId ? (
              <span className="text-xs text-muted-foreground">
                Saved as version{" "}
                <code className="font-mono text-foreground">{savedVersionId}</code>
              </span>
            ) : null}
            {save.error ? (
              <Alert variant="destructive" className="py-1 text-xs">
                <AlertDescription>{save.error}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={save.pending}
              onClick={() =>
                save.run({ dataContractId, mapping: proposal.proposal! })
              }
            >
              <Save className="mr-1 size-3.5" />
              {save.pending ? "Saving…" : "Save mapping as new version"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProposalDetail({ proposal }: { proposal: DestinationMapping }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="default">{proposal.kind}</Badge>
        {proposal.kind === "postgres" ? (
          <span className="text-muted-foreground">
            table <code className="font-mono text-foreground">{proposal.table}</code> in{" "}
            <code className="font-mono text-foreground">{proposal.mode}</code> mode
          </span>
        ) : null}
        {proposal.kind === "mongodb" ? (
          <span className="text-muted-foreground">
            collection <code className="font-mono text-foreground">{proposal.collection}</code>
          </span>
        ) : null}
        {proposal.kind === "bigquery" ? (
          <span className="text-muted-foreground">
            table{" "}
            <code className="font-mono text-foreground">
              {proposal.dataset}.{proposal.table}
            </code>{" "}
            in <code className="font-mono text-foreground">{proposal.mode}</code> mode
          </span>
        ) : null}
        {proposal.kind === "webhook" ? (
          <span className="text-muted-foreground">
            body strategy{" "}
            <code className="font-mono text-foreground">{proposal.body_strategy}</code>
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground">{proposal.rationale}</p>
      {proposal.kind === "postgres" && proposal.idempotency_column ? (
        <p className="mt-1 text-muted-foreground">
          Idempotency key:{" "}
          <code className="font-mono text-foreground">{proposal.idempotency_column}</code>
        </p>
      ) : null}
    </div>
  );
}

function PreviewGrid({
  preview,
}: {
  preview: Array<{ event_id: string; before: unknown; after: unknown }>;
}) {
  if (preview.length === 0) return null;
  return (
    <div className="grid gap-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Preview on the first {preview.length} sampled events
      </p>
      <ul className="grid gap-2">
        {preview.map((row) => (
          <li key={row.event_id} className="grid gap-1">
            <p className="text-[10px] font-mono text-muted-foreground">
              {row.event_id}
            </p>
            <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
              <PreCol value={row.before} label="Source payload" />
              <div className="hidden items-center justify-center md:flex">
                <ArrowRight className="size-3 text-muted-foreground" />
              </div>
              <PreCol value={row.after} label="Mapped output" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreCol({ value, label }: { value: unknown; label: string }) {
  return (
    <div className="rounded-sm border border-border bg-muted/30 p-2">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-56 overflow-auto font-mono text-[10px] leading-relaxed text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
