import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "../../../../lib/session";
import {
  getDataContract,
  getDataContractVersion,
  listDataContractVersions,
} from "../../../../lib/data-contracts/repository";
import type { InferredDataContract } from "../../../../lib/data-contracts/inference";
import type { DestinationMapping } from "../../../../lib/data-contracts/destination-mapping";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "../../../_components/LocalTime";
import { EntityStatusBadge } from "../../../_components/StatusBadges";
import { CodegenPanel } from "./CodegenPanel";
import { DestinationMappingPanel } from "./DestinationMappingPanel";
import { DataContractClusterView } from "./DataContractClusterView";
import { RefreshDataContractButton } from "./RefreshDataContractButton";
import { DataContractAutoRefresh } from "./DataContractAutoRefresh";
import { countSourceEvents, countDistinctEventTypes } from "../../../../lib/data-contracts/sampler";
import { DataContractDeleteButton } from "./DataContractDeleteButton";
import { DataContractStatusBar } from "./DataContractStatusBar";
import { SchemaExportPanel } from "./SchemaExportPanel";

export const dynamic = "force-dynamic";

interface FieldAnnotations {
  [path: string]: { ignored?: boolean; sensitive_override?: boolean };
}

type Tab = "overview" | "mapping" | "codegen" | "schema" | "versions";

function normalizeTab(raw: string | undefined): Tab {
  if (raw === "mapping" || raw === "codegen" || raw === "schema" || raw === "versions") return raw;
  return "overview";
}

export default async function DataContractDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const tab = normalizeTab((await searchParams).tab);
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canMutate =
    session.activeWorkspace.role === "owner" ||
    session.activeWorkspace.role === "admin";

  const map = await getDataContract(id, workspaceId);
  if (!map) notFound();

  const versions = await listDataContractVersions(id, workspaceId);
  const currentVersion = map.current_version_id
    ? await getDataContractVersion(map.current_version_id, workspaceId)
    : null;

  const schema =
    (currentVersion?.inferred_schema as InferredDataContract | null) ?? null;
  const annotations =
    (currentVersion?.field_annotations as FieldAnnotations | null) ?? {};

  // Staleness check for draft maps: a draft inferred from a near-empty
  // source (the classic "created the contract 5 min after the source went
  // live" case — a handful of events, a couple of event types) freezes at
  // that snapshot until something re-samples it. When the schema was built
  // from very few samples AND a lot of traffic has arrived since, auto-
  // trigger a re-inference on view so the draft reflects current reality.
  //
  // Tightly gated to avoid re-sampling on every view:
  //   - drafts only (active maps are deliberately pinned),
  //   - owners/admins only (refresh action is gated to them),
  //   - overview tab only (keeps the CH counts off unrelated renders),
  //   - only when the snapshot is genuinely TINY (< 50 samples). A full
  //     re-inference lands ~200 samples, which clears this gate, so a
  //     healthy contract never re-fires. The cron covers the rest.
  const sampledCount = schema
    ? schema.event_types.reduce((acc, c) => acc + (c.sample_count ?? 0), 0)
    : 0;
  const tinySnapshot = sampledCount > 0 && sampledCount < 50;
  const shouldCheckStaleness =
    Boolean(schema) &&
    canMutate &&
    map.status === "draft" &&
    tab === "overview" &&
    tinySnapshot &&
    Boolean(currentVersion?.created_at);
  const eventsSinceVersion = shouldCheckStaleness
    ? await countSourceEvents(workspaceId, map.source_id, {
        sinceIso: currentVersion!.created_at,
      })
    : 0;
  const staleSample = shouldCheckStaleness && eventsSinceVersion >= 100;

  // Type-coverage staleness: a schema can be a healthy size (past the tiny-
  // snapshot gate) yet still under-count event TYPES. For a long-tail
  // newsletter source, a pre-index proportional snapshot may capture only
  // the high-volume types and miss the long tail. Compare the distinct event
  // types the source actually emitted (the exhaustive index count) against
  // the named clusters this contract captured. "Event N" clusters are
  // shape-based, not real types,
  // so they don't count toward coverage.
  const storedNamedTypeCount = schema
    ? schema.event_types.filter((c) => !/^Event \d+$/.test(c.name)).length
    : 0;
  const streamTypeCount =
    Boolean(schema) && canMutate && tab === "overview"
      ? await countDistinctEventTypes(workspaceId, map.source_id)
      : 0;
  const missingTypeCount = Math.max(0, streamTypeCount - storedNamedTypeCount);
  const typeCoverageStale = missingTypeCount > 0;

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex flex-col gap-1 min-w-0">
          <Link
            href="/data-contracts"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            All Data Contracts
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {map.name}
          </h1>
          <small className="font-mono text-xs text-muted-foreground">{map.id}</small>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <EntityStatusBadge status={map.status} />
            {canMutate ? (
              <DataContractDeleteButton dataContractId={map.id} dataContractName={map.name} />
            ) : null}
          </div>
          <Link
            href={`/sources/${map.source_id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Source: {map.source_id}
          </Link>
        </div>
      </div>

      {canMutate ? (
        <DataContractStatusBar dataContractId={map.id} currentStatus={map.status} />
      ) : null}

      {!schema ? (
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          This Data Contract has no version yet.
        </div>
      ) : (
        // grid-cols-[minmax(0,1fr)] (not bare `grid`) so the single
        // column is allowed to shrink below its widest child's
        // intrinsic content width. Without this, panels with long
        // unwrappable content — the SchemaExportPanel's <pre>, long
        // example values in field rows, serialized destination
        // mapping — blow the column wider than the viewport.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {tab === "overview" ? (
            <>
              <section className="rounded-md border border-border bg-card p-4">
                <h2 className="mb-2 text-sm font-semibold text-foreground">Summary</h2>
                <p className="text-sm text-muted-foreground">{schema.summary}</p>
                {schema.model_metadata?.llm_enriched ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Enriched by{" "}
                    <span className="font-mono">{schema.model_metadata.model}</span>{" "}
                    in {schema.model_metadata.ms ?? "?"}ms. Prompt{" "}
                    <span className="font-mono">{schema.model_metadata.prompt_version}</span>.
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Deterministic inference only (no model enrichment).
                  </p>
                )}
              </section>

              {canMutate ? (
                <section
                  className={`space-y-3 rounded-md border border-dashed px-4 py-3 ${
                    typeCoverageStale
                      ? "border-amber-500/50 bg-amber-500/10"
                      : "border-border bg-muted/20"
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      {typeCoverageStale ? (
                        <>
                          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                            This contract is missing {missingTypeCount} event type
                            {missingTypeCount === 1 ? "" : "s"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            This source has emitted{" "}
                            <span className="font-semibold text-foreground">{streamTypeCount}</span>{" "}
                            distinct event types in the last 30 days, but this contract captured{" "}
                            <span className="font-semibold text-foreground">{storedNamedTypeCount}</span>.
                            It was likely inferred before the event-type index — refresh to pick up the
                            long tail.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-foreground">Just sent new event types?</p>
                          <p className="text-xs text-muted-foreground">
                            The drift cron auto-extends active and draft maps every 5 minutes. Click to
                            re-sample + re-infer right now.
                          </p>
                        </>
                      )}
                    </div>
                    <RefreshDataContractButton dataContractId={map.id} />
                  </div>
                  {staleSample ? (
                    <DataContractAutoRefresh
                      dataContractId={map.id}
                      sampledCount={sampledCount}
                      eventsSinceVersion={eventsSinceVersion}
                    />
                  ) : null}
                </section>
              ) : null}

              <DataContractClusterView
                dataContractId={map.id}
                schema={schema}
                annotations={annotations}
                canMutate={canMutate}
              />
            </>
          ) : null}

          {tab === "mapping" && canMutate ? (
            <DestinationMappingPanel
              dataContractId={map.id}
              initialMapping={
                (currentVersion?.destination_mapping as DestinationMapping | null) ??
                null
              }
            />
          ) : tab === "mapping" ? (
            <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
              Destination mapping is only available to workspace owners and admins.
            </div>
          ) : null}

          {tab === "codegen" && canMutate ? (
            <CodegenPanel dataContractId={map.id} />
          ) : tab === "codegen" ? (
            <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
              Codegen is only available to workspace owners and admins.
            </div>
          ) : null}

          {tab === "schema" ? (
            <SchemaExportPanel schema={schema} dataContractName={map.name} />
          ) : null}

          {tab === "versions" ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Version history</h2>
              <ul className="divide-y divide-border rounded-md border border-border">
                {versions.map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between gap-4 px-4 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground">v{v.version_number}</span>
                      {map.current_version_id === v.id ? (
                        <Badge variant="default">current</Badge>
                      ) : null}
                    </div>
                    <span className="text-muted-foreground">
                      <LocalTime value={v.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}
