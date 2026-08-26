"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  AlertTriangle,
  ChevronsUpDown,
  Clock,
  EyeOff,
  KeyRound,
  Layers,
  Save,
  ShieldAlert,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { saveAnnotationsAction } from "../../../../lib/data-contracts/actions";
import type {
  ClusterSchema,
  EventTypeCluster,
  FieldSpec,
  IdCandidate,
  InferredDataContract,
  SensitiveField,
  StatusFieldCandidate,
  TimestampCandidate,
} from "../../../../lib/data-contracts/inference";
import { useAction } from "../../../_components/useAction";

interface FieldAnnotations {
  [path: string]: { ignored?: boolean; sensitive_override?: boolean };
}

/**
 * Cluster-aware container for the per-event-type panels. Sits below the
 * Summary card on the Data Contract detail page.
 *
 * Two modes:
 *
 *   - "All event types" (default). Shows the union schema across every
 *     cluster — this is the view drift detection and destination
 *     mapping consume.
 *
 *   - One specific cluster selected. Filters every panel down to that
 *     event type's contract. The required/optional + uniqueness + enum
 *     values become meaningful for THAT shape rather than the union,
 *     so operators reading "what does invoice.paid look like?" get a
 *     direct answer instead of a denominator over all event types.
 *
 * The selector is a searchable combobox so maps with dozens of event
 * types remain quick to scan and navigate.
 */
export function DataContractClusterView({
  dataContractId,
  schema,
  annotations,
  canMutate,
}: {
  dataContractId: string;
  schema: InferredDataContract;
  annotations: FieldAnnotations;
  canMutate: boolean;
}) {
  const clusters = schema.event_types;
  const perCluster = schema.per_cluster ?? {};
  const [selected, setSelected] = useState<string | null>(null);

  // Local annotation working-state. Starts equal to the version's
  // saved annotations; toggle buttons mutate it; the floating save
  // bar surfaces the diff against `annotations` (the baseline) so
  // operators see what they're about to commit before they hit save.
  const [working, setWorking] = useState<FieldAnnotations>(annotations);

  // Resolve the active slice. selected===null means union view.
  const active: ClusterSchema | null =
    selected && perCluster[selected]
      ? perCluster[selected]
      : null;

  const view: {
    fields: Record<string, FieldSpec>;
    ids: IdCandidate[];
    timestamps: TimestampCandidate[];
    status_fields: StatusFieldCandidate[];
    sensitive_fields: SensitiveField[];
  } = active ?? {
    fields: schema.fields,
    ids: schema.ids,
    timestamps: schema.timestamps,
    status_fields: schema.status_fields,
    sensitive_fields: schema.sensitive_fields,
  };

  const totalSamples = clusters.reduce((acc, c) => acc + c.sample_count, 0);

  return (
    // Match the outer page grid: minmax(0,1fr) so children can shrink
    // below their intrinsic content width and don't push the page wide.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <section className="rounded-md border border-border bg-card p-4">
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Layers className="size-3.5" />
            Event types ({clusters.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            One map, many event types. Click an event to see its contract.
          </p>
        </div>
        <EventTypePicker
          clusters={clusters}
          totalSamples={totalSamples}
          selected={selected}
          onSelect={setSelected}
          hasPerCluster={Object.keys(perCluster).length > 0}
        />
      </section>

      <IdsTimestampsStatusPanel
        ids={view.ids}
        timestamps={view.timestamps}
        statusFields={view.status_fields}
        clusterLabel={clusterLabel(selected, clusters)}
      />
      <SensitivePanel
        sensitive={view.sensitive_fields}
        annotations={working}
      />
      <FieldsPanel
        fields={view.fields}
        annotations={working}
        clusterLabel={clusterLabel(selected, clusters)}
        canMutate={canMutate}
        onToggle={(path, key) => {
          setWorking((prev) => toggleAnnotation(prev, path, key));
        }}
      />
      {canMutate ? (
        <AnnotationSaveBar
          dataContractId={dataContractId}
          baseline={annotations}
          working={working}
          onReset={() => setWorking(annotations)}
        />
      ) : null}
    </div>
  );
}

function toggleAnnotation(
  prev: FieldAnnotations,
  path: string,
  key: "ignored" | "sensitive_override",
): FieldAnnotations {
  const existing = prev[path] ?? {};
  const next = { ...existing, [key]: !existing[key] };
  const cleaned: { ignored?: boolean; sensitive_override?: boolean } = {};
  if (next.ignored) cleaned.ignored = true;
  if (next.sensitive_override) cleaned.sensitive_override = true;
  const out: FieldAnnotations = { ...prev };
  if (!cleaned.ignored && !cleaned.sensitive_override) {
    delete out[path];
  } else {
    out[path] = cleaned;
  }
  return out;
}

function diffAnnotations(
  baseline: FieldAnnotations,
  working: FieldAnnotations,
): {
  changed_paths: string[];
  diff: FieldAnnotations;
} {
  const changed = new Set<string>();
  for (const path of Object.keys(working)) {
    if (!sameAnnotation(baseline[path], working[path])) changed.add(path);
  }
  for (const path of Object.keys(baseline)) {
    if (!sameAnnotation(baseline[path], working[path])) changed.add(path);
  }
  // Server merges by path — for paths the operator cleared, pass an
  // empty object so the merger strips them from the next version.
  const diff: FieldAnnotations = {};
  for (const path of changed) {
    diff[path] = working[path] ?? {};
  }
  return { changed_paths: Array.from(changed).sort(), diff };
}

function sameAnnotation(
  a: { ignored?: boolean; sensitive_override?: boolean } | undefined,
  b: { ignored?: boolean; sensitive_override?: boolean } | undefined,
): boolean {
  const aIgnored = !!a?.ignored;
  const aSensitive = !!a?.sensitive_override;
  const bIgnored = !!b?.ignored;
  const bSensitive = !!b?.sensitive_override;
  return aIgnored === bIgnored && aSensitive === bSensitive;
}

function AnnotationSaveBar({
  dataContractId,
  baseline,
  working,
  onReset,
}: {
  dataContractId: string;
  baseline: FieldAnnotations;
  working: FieldAnnotations;
  onReset: () => void;
}) {
  const router = useRouter();
  const { run, pending, error, reset } = useAction(saveAnnotationsAction, {
    onSuccess: () => router.refresh(),
  });
  const { changed_paths, diff } = useMemo(
    () => diffAnnotations(baseline, working),
    [baseline, working],
  );
  if (changed_paths.length === 0) return null;
  return (
    <div className="sticky bottom-4 z-10 mx-auto flex w-full max-w-2xl items-center justify-between gap-3 rounded-md border border-foreground/30 bg-card px-4 py-2 shadow-lg">
      <span className="text-xs text-foreground">
        {changed_paths.length} field annotation
        {changed_paths.length === 1 ? "" : "s"} pending
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            reset();
            onReset();
          }}
        >
          <Undo2 className="mr-1 size-3.5" />
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => run(dataContractId, { field_annotations: diff })}
        >
          <Save className="mr-1 size-3.5" />
          {pending ? "Saving…" : `Save as new version`}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" className="absolute bottom-full left-0 right-0 mb-2 text-xs">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function clusterLabel(
  selected: string | null,
  clusters: EventTypeCluster[],
): string {
  if (!selected) return "all event types";
  return clusters.find((c) => c.cluster_id === selected)?.name ?? selected;
}

function EventTypePicker({
  clusters,
  totalSamples,
  selected,
  onSelect,
  hasPerCluster,
}: {
  clusters: EventTypeCluster[];
  totalSamples: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  hasPerCluster: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = selected
    ? clusters.find((cluster) => cluster.cluster_id === selected)
    : null;

  function select(id: string | null) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Filter by event type"
          aria-expanded={open}
          className="flex h-10 w-full max-w-xl items-center justify-between gap-3 rounded-md border border-input bg-background px-3 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="min-w-0 truncate font-mono">
            {active?.name ?? "All event types"}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary">
              {active ? active.sample_count : totalSamples} samples
            </Badge>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <Command
            filter={(value, search) =>
              value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder="Search event types…" />
            <CommandList>
              <CommandEmpty>No event types found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="All event types"
                  data-checked={selected === null ? "true" : undefined}
                  onSelect={() => select(null)}
                >
                  <span className="min-w-0 flex-1 truncate">All event types</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {totalSamples} samples
                  </span>
                </CommandItem>
                {clusters.map((cluster) => (
                  <CommandItem
                    key={cluster.cluster_id}
                    value={`${cluster.name} ${cluster.cluster_id}`}
                    data-checked={
                      selected === cluster.cluster_id ? "true" : undefined
                    }
                    disabled={!hasPerCluster}
                    onSelect={() => select(cluster.cluster_id)}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {cluster.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {cluster.sample_count}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
      {!hasPerCluster ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Re-run Understand source to filter this older map by event type.
        </p>
      ) : null}
    </PopoverPrimitive.Root>
  );
}

function IdsTimestampsStatusPanel({
  ids,
  timestamps,
  statusFields,
  clusterLabel,
}: {
  ids: IdCandidate[];
  timestamps: TimestampCandidate[];
  statusFields: StatusFieldCandidate[];
  clusterLabel: string;
}) {
  return (
    // Single column, full width per panel. Three-up grid previously
    // chopped long ID paths like `data.subscriber.custom_fields.address_street`
    // and pushed the `100% unique` label onto a wrapped line so it
    // rendered as `100 uni` — broken-looking. Each row keeps a
    // shrinkable code path plus a non-shrinking right-side label.
    <section className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PanelCard
        icon={<KeyRound className="size-3" />}
        title="IDs"
        subtitle={`Stable id candidates in ${clusterLabel}.`}
      >
        {ids.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No stable ID candidates detected.
          </p>
        ) : (
          <ul className="grid gap-1 text-xs">
            {ids.map((c) => (
              <li key={c.path} className="flex items-center justify-between gap-3">
                <code className="min-w-0 truncate font-mono text-foreground" title={c.path}>
                  {c.path}
                </code>
                <span className="shrink-0 text-muted-foreground">
                  {Math.round(c.uniqueness * 100)}% unique
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
      <PanelCard
        icon={<Clock className="size-3" />}
        title="Timestamps"
        subtitle={`Time-like paths in ${clusterLabel}.`}
      >
        {timestamps.length === 0 ? (
          <p className="text-xs text-muted-foreground">No timestamps detected.</p>
        ) : (
          <ul className="grid gap-1 text-xs">
            {timestamps.map((t) => (
              <li key={t.path} className="flex items-center justify-between gap-3">
                <code className="min-w-0 truncate font-mono text-foreground" title={t.path}>
                  {t.path}
                </code>
                <Badge variant="secondary" className="shrink-0">{t.format}</Badge>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
      <PanelCard
        icon={<AlertTriangle className="size-3" />}
        title="Status fields"
        subtitle={`Low-cardinality enums in ${clusterLabel}.`}
      >
        {statusFields.length === 0 ? (
          <p className="text-xs text-muted-foreground">No status fields detected.</p>
        ) : (
          <ul className="grid gap-2 text-xs">
            {statusFields.map((f) => (
              <li key={f.path}>
                <code className="block truncate font-mono text-foreground" title={f.path}>
                  {f.path}
                </code>
                <div className="mt-1 flex flex-wrap gap-1">
                  {f.values.map((v) => (
                    <Badge key={v} variant="secondary">{v}</Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </section>
  );
}

function PanelCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-foreground">
        {icon} {title}
      </h2>
      {subtitle ? (
        <p className="mb-2 text-[11px] text-muted-foreground">{subtitle}</p>
      ) : null}
      {children}
    </div>
  );
}

function SensitivePanel({
  sensitive,
  annotations,
}: {
  sensitive: SensitiveField[];
  annotations: FieldAnnotations;
}) {
  const overrides = Object.entries(annotations).filter(
    ([, ann]) => ann.sensitive_override,
  );
  const effective = new Map<string, "deterministic" | "model" | "both" | "override">();
  for (const s of sensitive) effective.set(s.path, s.reason);
  for (const [path] of overrides) {
    if (!effective.has(path)) effective.set(path, "override");
  }
  if (effective.size === 0) {
    return (
      <section className="rounded-md border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
          <ShieldAlert className="size-3" /> Sensitive fields
        </h2>
        <p className="text-xs text-muted-foreground">
          No fields detected as sensitive. Use field annotations to mark any
          you want redacted.
        </p>
      </section>
    );
  }
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
        <ShieldAlert className="size-3" /> Sensitive fields
      </h2>
      <ul className="grid gap-1 text-xs">
        {[...effective].map(([path, reason]) => (
          <li key={path} className="flex items-center justify-between">
            <code className="font-mono text-foreground">{path}</code>
            <Badge variant="secondary">{reason}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FieldsPanel({
  fields,
  annotations,
  clusterLabel,
  canMutate,
  onToggle,
}: {
  fields: Record<string, FieldSpec>;
  annotations: FieldAnnotations;
  clusterLabel: string;
  canMutate: boolean;
  onToggle: (path: string, key: "ignored" | "sensitive_override") => void;
}) {
  const entries = Object.entries(fields)
    .filter(([p]) => p !== "$")
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 text-sm font-semibold text-foreground">
        Fields ({entries.length})
      </h2>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Schema for {clusterLabel}.
        {canMutate ? (
          <>
            {" "}
            Toggle <em>ignored</em> on noisy fields (drift detection skips
            them) or <em>sensitive</em> on anything the heuristics missed
            (drift escalates, destination mapping projects them out).
          </>
        ) : null}
      </p>
      <ul className="grid gap-2 text-xs">
        {entries.map(([path, spec]) => {
          const ann = annotations[path];
          return (
            <li
              key={path}
              className="grid min-w-0 gap-1 overflow-hidden rounded-md border border-border/60 bg-background/40 px-3 py-2"
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                <code className="min-w-0 truncate font-mono text-foreground">{path}</code>
                <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1">
                  {spec.category ? (
                    <CategoryBadge category={spec.category} />
                  ) : null}
                  {spec.required ? (
                    <Badge variant="default">required</Badge>
                  ) : (
                    <Badge variant="secondary">
                      {Math.round(spec.presence * 100)}%
                    </Badge>
                  )}
                  {ann?.ignored ? <Badge variant="secondary">ignored</Badge> : null}
                  {ann?.sensitive_override ? (
                    <Badge variant="secondary">sensitive (user)</Badge>
                  ) : null}
                  {canMutate ? (
                    <AnnotationToggles
                      path={path}
                      ann={ann}
                      onToggle={onToggle}
                    />
                  ) : null}
                </div>
              </div>
              <FieldDetail spec={spec} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AnnotationToggles({
  path,
  ann,
  onToggle,
}: {
  path: string;
  ann: { ignored?: boolean; sensitive_override?: boolean } | undefined;
  onToggle: (path: string, key: "ignored" | "sensitive_override") => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(path, "ignored")}
        title={
          ann?.ignored
            ? "Field is currently marked ignored. Click to clear."
            : "Mark this field as intentionally ignored (drift skips it)."
        }
        className={
          "inline-flex size-5 items-center justify-center rounded-sm border transition-colors " +
          (ann?.ignored
            ? "border-foreground/40 bg-foreground/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground")
        }
        aria-label="Toggle ignored"
      >
        <EyeOff className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => onToggle(path, "sensitive_override")}
        title={
          ann?.sensitive_override
            ? "Field is currently marked sensitive. Click to clear."
            : "Mark this field as sensitive (PII / secret). Drift escalates, destinations project it out."
        }
        className={
          "inline-flex size-5 items-center justify-center rounded-sm border transition-colors " +
          (ann?.sensitive_override
            ? "border-destructive/60 bg-destructive/10 text-destructive"
            : "border-border text-muted-foreground hover:text-foreground")
        }
        aria-label="Toggle sensitive"
      >
        <ShieldCheck className="size-3" />
      </button>
    </>
  );
}

function CategoryBadge({ category }: { category: NonNullable<FieldSpec["category"]> }) {
  if (category === "string" || category === "null") return null;
  return <Badge variant="secondary">{category}</Badge>;
}

function FieldDetail({ spec }: { spec: FieldSpec }) {
  const segments: React.ReactNode[] = [];
  if (spec.numeric_range) {
    segments.push(
      <span key="range" className="text-muted-foreground">
        range {spec.numeric_range.min} – {spec.numeric_range.max}
      </span>,
    );
  }
  if (spec.enum_values && spec.enum_values.length > 0) {
    segments.push(
      <div key="enum" className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
        <span className="shrink-0 text-muted-foreground">values</span>
        {spec.enum_values.slice(0, 8).map((v) => (
          <Badge key={v} variant="secondary" className="max-w-full truncate">
            {v}
          </Badge>
        ))}
        {spec.enum_values.length > 8 ? (
          <span className="text-muted-foreground">
            +{spec.enum_values.length - 8} more
          </span>
        ) : null}
      </div>,
    );
  } else if (spec.examples && spec.examples.length > 0) {
    segments.push(
      <span
        key="examples"
        className="truncate font-mono text-[10px] text-muted-foreground"
      >
        e.g. {spec.examples.slice(0, 2).map(formatExample).join(", ")}
      </span>,
    );
  }
  if (spec.uniqueness !== undefined && spec.uniqueness > 0 && spec.uniqueness < 1) {
    segments.push(
      <span key="uniq" className="text-muted-foreground">
        {Math.round(spec.uniqueness * 100)}% unique
      </span>,
    );
  }
  if (segments.length === 0) {
    return (
      <span className="text-[10px] text-muted-foreground">
        type {spec.types.join(" | ")}
      </span>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 overflow-hidden text-[10px]">
      <span className="text-muted-foreground">
        type {spec.types.join(" | ")}
      </span>
      {segments}
    </div>
  );
}

function formatExample(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
  }
  return String(v);
}
