"use client";

/**
 * Side-panel form for the currently selected canvas node. Switch-renders
 * by node kind. Edits flow back via `onUpdateNode` (replacing the whole
 * node in the parent graph state). Read-only mode disables inputs.
 */
import { useEffect, useState } from "react";
import type {
  ArrayCollapse,
  ArrayCollapseFormat,
  GeneratedFilter,
  GeneratedTransform,
  IntegerRounding,
  PipelineNode,
  ScalarCoercion,
  ScalarCoercionTarget,
} from "@axel/shared";
import { JsonView } from "./JsonView";
import { JsonDiffView } from "./JsonDiffView";
import type { CanvasNodeRuntime } from "./CanvasNodes";
import { BigQueryNodeCompat } from "../../DestinationBindingPicker";

interface Props {
  node: PipelineNode | null;
  runtime: CanvasNodeRuntime | null;
  inputSample: unknown | undefined;
  outputSample: unknown | undefined;
  canEdit: boolean;
  /** Route source id — lets a BigQuery destination node run a compat check. */
  sourceId?: string;
  attachedDestinations: {
    id: string;
    name: string;
    type: string;
    binding?: Record<string, unknown> | null;
  }[];
  /** Destination ids already backed by a node on the canvas. The
   * destination editor hides these (except the node's own) so one
   * destination can't back two nodes — that would double-deliver. */
  placedDestinationIds?: Set<string>;
  onUpdateNode: (updated: PipelineNode) => void;
  onDeleteNode: (id: string) => void;
}

export function NodeInspector({
  node,
  runtime,
  inputSample,
  outputSample,
  canEdit,
  sourceId,
  attachedDestinations,
  placedDestinationIds,
  onUpdateNode,
  onDeleteNode,
}: Props) {
  if (!node) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Click a node to inspect or edit it.
      </div>
    );
  }

  const bqDestination =
    node.kind === "destination"
      ? attachedDestinations.find((d) => d.id === node.destination_id && d.type === "bigquery")
      : undefined;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-2 border-b border-border pb-2">
        <div>
          <small className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {node.kind}
          </small>
          <div className="mt-0.5 font-mono text-[11px] text-foreground">{node.id}</div>
        </div>
        {canEdit && node.kind !== "source" ? (
          <button
            type="button"
            className="text-[11px] text-destructive hover:underline"
            onClick={() => onDeleteNode(node.id)}
          >
            remove
          </button>
        ) : null}
      </header>

      {node.kind === "filter" ? (
        <FilterEditor
          value={node.filter}
          canEdit={canEdit}
          onChange={(filter) => onUpdateNode({ ...node, filter })}
        />
      ) : null}

      {node.kind === "transform" ? (
        <TransformEditor
          value={node.transform}
          canEdit={canEdit}
          onChange={(transform) => onUpdateNode({ ...node, transform })}
        />
      ) : null}

      {node.kind === "destination" ? (
        <DestinationEditor
          value={node.destination_id}
          canEdit={canEdit}
          attachedDestinations={attachedDestinations}
          placedDestinationIds={placedDestinationIds}
          onChange={(destination_id) => onUpdateNode({ ...node, destination_id })}
        />
      ) : null}

      {bqDestination ? (
        <BigQueryNodeCompat
          sourceId={sourceId}
          destinationId={bqDestination.id}
          binding={bqDestination.binding}
        />
      ) : null}

      {node.kind === "source" ? (
        <p className="text-xs text-muted-foreground">
          The source is fixed for this route. Load a sample below to preview the pipeline.
        </p>
      ) : null}

      {/* Preview */}
      {runtime ? (
        <div className="space-y-2 border-t border-border pt-3">
          <RuntimeBadge runtime={runtime} />
          <PreviewBlock
            node={node}
            inputSample={inputSample}
            outputSample={outputSample}
          />
        </div>
      ) : null}
    </div>
  );
}

function PreviewBlock({
  node,
  inputSample,
  outputSample,
}: {
  node: PipelineNode;
  inputSample: unknown | undefined;
  outputSample: unknown | undefined;
}) {
  // Transform nodes (and filter pass-throughs) benefit from a diff view —
  // it makes "what changed" obvious without scanning two JSON blobs.
  // For source / destination nodes only the carried value is interesting
  // (input or output, not both), so we fall back to a single JSON pane.
  if (
    node.kind === "transform" &&
    inputSample !== undefined &&
    outputSample !== undefined
  ) {
    return <JsonDiffView before={inputSample} after={outputSample} />;
  }
  return (
    <>
      {inputSample !== undefined ? (
        <JsonView value={inputSample} label="input" />
      ) : null}
      {outputSample !== undefined ? (
        <JsonView value={outputSample} label="output" />
      ) : null}
    </>
  );
}

function RuntimeBadge({ runtime }: { runtime: CanvasNodeRuntime }) {
  const labels: Record<CanvasNodeRuntime["health"], string> = {
    idle: "no sample loaded",
    ok: "payload reached this node",
    filtered: "branch pruned here",
    error: "engine error",
    warning: "see details",
  };
  return (
    <div className="text-[11px] text-muted-foreground">
      {labels[runtime.health]}
      {runtime.detail ? <> — {runtime.detail}</> : null}
    </div>
  );
}

function FilterEditor({
  value,
  canEdit,
  onChange,
}: {
  value: GeneratedFilter;
  canEdit: boolean;
  onChange: (next: GeneratedFilter) => void;
}) {
  const [kind, setKind] = useState<GeneratedFilter["kind"]>(value.kind);

  useEffect(() => setKind(value.kind), [value.kind]);

  function setKindAndDefault(next: GeneratedFilter["kind"]) {
    setKind(next);
    if (next === "always") onChange({ kind: "always" });
    else if (next === "event_type_in")
      onChange({ kind: "event_type_in", path: "type", values: ["event"] });
    else if (next === "and") onChange({ kind: "and", parts: [{ kind: "always" }] });
    else if (next === "or") onChange({ kind: "or", parts: [{ kind: "always" }] });
  }

  return (
    <div className="space-y-2">
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
        Kind
      </label>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        disabled={!canEdit}
        value={kind}
        onChange={(e) => setKindAndDefault(e.target.value as GeneratedFilter["kind"])}
      >
        <option value="always">Pass anything</option>
        <option value="event_type_in">Match event types</option>
        <option value="and">All of (and)</option>
        <option value="or">Any of (or)</option>
      </select>

      {value.kind === "event_type_in" ? (
        <div className="space-y-2">
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
            Path (e.g. <code>type</code> or <code>data.event_type</code>)
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            disabled={!canEdit}
            value={value.path}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
            Values (comma separated)
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            disabled={!canEdit}
            value={value.values.join(", ")}
            onChange={(e) =>
              onChange({
                ...value,
                values: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter((v) => v.length > 0),
              })
            }
          />
        </div>
      ) : null}

      {(value.kind === "and" || value.kind === "or") ? (
        <CompositePartsEditor
          composite={value}
          canEdit={canEdit}
          onChange={(next) => onChange(next)}
        />
      ) : null}
    </div>
  );
}

type CompositeFilter = Extract<GeneratedFilter, { kind: "and" | "or" }>;
type SimpleLeafFilter = Extract<GeneratedFilter, { kind: "always" | "event_type_in" }>;

function isSimpleLeaf(f: GeneratedFilter): f is SimpleLeafFilter {
  return f.kind === "always" || f.kind === "event_type_in";
}

function CompositePartsEditor({
  composite,
  canEdit,
  onChange,
}: {
  composite: CompositeFilter;
  canEdit: boolean;
  onChange: (next: CompositeFilter) => void;
}) {
  // Visual model is flat: leaves are `always` or `event_type_in` only.
  // Nested `and`/`or` parts coming from older saved data are rendered
  // read-only with a hint so we don't lose them — operator can still
  // edit via the Raw DSL section.
  const hasNested = composite.parts.some((p) => !isSimpleLeaf(p));

  function updatePart(idx: number, next: SimpleLeafFilter) {
    const parts = composite.parts.map((p, i) => (i === idx ? next : p));
    onChange({ ...composite, parts });
  }
  function removePart(idx: number) {
    if (composite.parts.length <= 1) return;
    onChange({
      ...composite,
      parts: composite.parts.filter((_, i) => i !== idx),
    });
  }
  function addPart() {
    onChange({
      ...composite,
      parts: [
        ...composite.parts,
        { kind: "event_type_in", path: "type", values: ["event"] },
      ],
    });
  }

  return (
    <div className="space-y-2">
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
        {composite.kind === "and" ? "All must match" : "Any must match"}{" "}
        <span className="ml-1 text-muted-foreground/70">
          ({composite.parts.length})
        </span>
      </label>
      <div className="space-y-2">
        {composite.parts.map((part, i) => (
          <CompositePartRow
            key={i}
            part={part}
            canEdit={canEdit && isSimpleLeaf(part)}
            canRemove={canEdit && composite.parts.length > 1}
            onChange={(next) => updatePart(i, next)}
            onRemove={() => removePart(i)}
            index={i}
          />
        ))}
      </div>
      {canEdit ? (
        <button
          type="button"
          className="text-[11px] text-foreground underline-offset-2 hover:underline"
          onClick={addPart}
        >
          + add part
        </button>
      ) : null}
      {hasNested ? (
        <p className="text-[11px] text-muted-foreground">
          One or more parts contain nested combinators — editing those is
          available in the Raw DSL section.
        </p>
      ) : null}
    </div>
  );
}

function CompositePartRow({
  part,
  canEdit,
  canRemove,
  onChange,
  onRemove,
  index,
}: {
  part: GeneratedFilter;
  canEdit: boolean;
  canRemove: boolean;
  onChange: (next: SimpleLeafFilter) => void;
  onRemove: () => void;
  index: number;
}) {
  if (!isSimpleLeaf(part)) {
    // Read-only nested composite — preserve but don't render an editor.
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
        Nested {part.kind} ({part.parts.length} parts) — edit in Raw DSL.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="mb-1 flex items-center justify-between">
        <small className="text-[10px] uppercase tracking-wider text-muted-foreground">
          part {index + 1}
        </small>
        {canRemove ? (
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove this part"
          >
            ✕
          </button>
        ) : null}
      </div>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        disabled={!canEdit}
        value={part.kind}
        onChange={(e) => {
          const next = e.target.value as SimpleLeafFilter["kind"];
          if (next === "always") onChange({ kind: "always" });
          else
            onChange({
              kind: "event_type_in",
              path: "type",
              values: ["event"],
            });
        }}
      >
        <option value="always">Pass anything</option>
        <option value="event_type_in">Match event types</option>
      </select>
      {part.kind === "event_type_in" ? (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            placeholder="path (e.g. data.type)"
            disabled={!canEdit}
            value={part.path}
            onChange={(e) => onChange({ ...part, path: e.target.value })}
          />
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            placeholder="values (comma separated)"
            disabled={!canEdit}
            value={part.values.join(", ")}
            onChange={(e) =>
              onChange({
                ...part,
                values: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter((v) => v.length > 0),
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function TransformEditor({
  value,
  canEdit,
  onChange,
}: {
  value: GeneratedTransform;
  canEdit: boolean;
  onChange: (next: GeneratedTransform) => void;
}) {
  const [kind, setKind] = useState<GeneratedTransform["kind"]>(value.kind);

  useEffect(() => setKind(value.kind), [value.kind]);

  function setKindAndDefault(next: GeneratedTransform["kind"]) {
    setKind(next);
    if (next === "passthrough") onChange({ kind: "passthrough" });
    else if (next === "select") onChange({ kind: "select", assignments: { id: "event_id" } });
    else if (next === "coerce")
      onChange({ kind: "coerce", fields: [{ path: "amount", to: "integer", rounding: "round" }] });
    else if (next === "collapse_arrays")
      onChange({ kind: "collapse_arrays", fields: [{ path: "tags", format: "join", separator: ", " }] });
    else if (next === "envelope")
      onChange({ kind: "envelope", event_type_path: "type", occurred_at_path: null });
    else if (next === "jsonb_blob") onChange({ kind: "jsonb_blob", column: "payload" });
  }

  return (
    <div className="space-y-2">
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
        Kind
      </label>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        disabled={!canEdit}
        value={kind}
        onChange={(e) => setKindAndDefault(e.target.value as GeneratedTransform["kind"])}
      >
        <option value="passthrough">Pass through unchanged</option>
        <option value="select">Project / rename fields</option>
        <option value="coerce">Convert field types</option>
        <option value="collapse_arrays">Collapse arrays to text</option>
        <option value="envelope">Wrap in envelope</option>
        <option value="jsonb_blob">Single JSONB column</option>
      </select>

      {value.kind === "select" ? (
        <SelectFieldEditor
          assignments={value.assignments}
          canEdit={canEdit}
          onChange={(assignments) => onChange({ kind: "select", assignments })}
        />
      ) : null}

      {value.kind === "coerce" ? (
        <CoerceFieldEditor
          fields={value.fields}
          canEdit={canEdit}
          onChange={(fields) => onChange({ kind: "coerce", fields })}
        />
      ) : null}

      {value.kind === "collapse_arrays" ? (
        <CollapseArrayEditor
          fields={value.fields}
          canEdit={canEdit}
          onChange={(fields) => onChange({ kind: "collapse_arrays", fields })}
        />
      ) : null}

      {value.kind === "envelope" ? (
        <div className="space-y-2">
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
            Event type path
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            disabled={!canEdit}
            value={value.event_type_path ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                event_type_path: e.target.value.trim() === "" ? null : e.target.value,
              })
            }
          />
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
            Occurred-at path
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            disabled={!canEdit}
            value={value.occurred_at_path ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                occurred_at_path: e.target.value.trim() === "" ? null : e.target.value,
              })
            }
          />
        </div>
      ) : null}

      {value.kind === "jsonb_blob" ? (
        <div className="space-y-2">
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
            Column name
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            disabled={!canEdit}
            value={value.column}
            onChange={(e) => onChange({ ...value, column: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

const COERCION_TARGETS: Array<{ value: ScalarCoercionTarget; label: string }> = [
  { value: "string", label: "Text (STRING)" },
  { value: "integer", label: "Integer (INT64)" },
  { value: "number", label: "Decimal number (FLOAT64)" },
  { value: "boolean", label: "Boolean (BOOL)" },
];

const ROUNDING_OPTIONS: Array<{ value: IntegerRounding; label: string }> = [
  { value: "round", label: "Round to nearest" },
  { value: "floor", label: "Round down (floor)" },
  { value: "ceil", label: "Round up (ceiling)" },
  { value: "truncate", label: "Drop decimal (truncate)" },
];

function CoerceFieldEditor({
  fields,
  canEdit,
  onChange,
}: {
  fields: ScalarCoercion[];
  canEdit: boolean;
  onChange: (next: ScalarCoercion[]) => void;
}) {
  function update(index: number, patch: Partial<ScalarCoercion>) {
    onChange(
      fields.map((field, i) => {
        if (i !== index) return field;
        const next = { ...field, ...patch };
        if (next.to === "integer") {
          return { ...next, rounding: next.rounding ?? "round" } as ScalarCoercion;
        }
        const { rounding: _rounding, ...withoutRounding } = next;
        return withoutRounding as ScalarCoercion;
      }),
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
          Field conversions
        </label>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Converts values before delivery. Missing and null fields are left unchanged; invalid values fail with the field name.
        </p>
      </div>
      {fields.map((field, index) => (
        <div key={index} className="space-y-1.5 rounded-md border border-border p-2">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
              placeholder="amount or items[].amount"
              disabled={!canEdit}
              value={field.path}
              onChange={(e) => update(index, { path: e.target.value })}
              aria-label={`Field path ${index + 1}`}
            />
            {canEdit && fields.length > 1 ? (
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
                title="Remove conversion"
              >
                ✕
              </button>
            ) : null}
          </div>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            disabled={!canEdit}
            value={field.to}
            onChange={(e) => update(index, { to: e.target.value as ScalarCoercionTarget })}
            aria-label={`Target type ${index + 1}`}
          >
            {COERCION_TARGETS.map((target) => (
              <option key={target.value} value={target.value}>{target.label}</option>
            ))}
          </select>
          {field.to === "integer" ? (
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              disabled={!canEdit}
              value={field.rounding ?? "round"}
              onChange={(e) => update(index, { rounding: e.target.value as IntegerRounding })}
              aria-label={`Decimal handling ${index + 1}`}
            >
              {ROUNDING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : null}
        </div>
      ))}
      {canEdit && fields.length < 32 ? (
        <button
          type="button"
          className="text-[11px] text-foreground underline-offset-2 hover:underline"
          onClick={() => onChange([...fields, { path: "", to: "string" }])}
        >
          + add conversion
        </button>
      ) : null}
    </div>
  );
}

function CollapseArrayEditor({
  fields,
  canEdit,
  onChange,
}: {
  fields: ArrayCollapse[];
  canEdit: boolean;
  onChange: (next: ArrayCollapse[]) => void;
}) {
  function update(index: number, patch: Partial<ArrayCollapse>) {
    onChange(
      fields.map((field, i) => {
        if (i !== index) return field;
        const next = { ...field, ...patch };
        if (next.format === "join") return { ...next, separator: next.separator ?? ", " };
        const { separator: _separator, ...withoutSeparator } = next;
        return withoutSeparator as ArrayCollapse;
      }),
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
          Array conversions
        </label>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Converts an array into one text value before delivery. Use JSON text to preserve the complete array.
        </p>
      </div>
      {fields.map((field, index) => (
        <div key={index} className="space-y-1.5 rounded-md border border-border p-2">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
              placeholder="tags or items[].tags"
              disabled={!canEdit}
              value={field.path}
              onChange={(e) => update(index, { path: e.target.value })}
              aria-label={`Array field path ${index + 1}`}
            />
            {canEdit && fields.length > 1 ? (
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
                title="Remove array conversion"
              >
                ✕
              </button>
            ) : null}
          </div>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            disabled={!canEdit}
            value={field.format}
            onChange={(e) => update(index, { format: e.target.value as ArrayCollapseFormat })}
            aria-label={`Array conversion ${index + 1}`}
          >
            <option value="join">Join scalar values</option>
            <option value="json">JSON text (lossless)</option>
          </select>
          {field.format === "join" ? (
            <input
              type="text"
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
              placeholder="Separator"
              disabled={!canEdit}
              value={field.separator ?? ", "}
              maxLength={32}
              onChange={(e) => update(index, { separator: e.target.value })}
              aria-label={`Join separator ${index + 1}`}
            />
          ) : null}
        </div>
      ))}
      {canEdit && fields.length < 32 ? (
        <button
          type="button"
          className="text-[11px] text-foreground underline-offset-2 hover:underline"
          onClick={() => onChange([...fields, { path: "", format: "join", separator: ", " }])}
        >
          + add array conversion
        </button>
      ) : null}
    </div>
  );
}

function SelectFieldEditor({
  assignments,
  canEdit,
  onChange,
}: {
  assignments: Record<string, string>;
  canEdit: boolean;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(assignments);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Auto-dismiss the duplicate-key banner after 4s, matching the
  // canvas's inline validation banner behavior.
  useEffect(() => {
    if (!keyError) return;
    const id = window.setTimeout(() => setKeyError(null), 4000);
    return () => window.clearTimeout(id);
  }, [keyError]);

  function updateRow(idx: number, key: string, value: string) {
    const trimmedKey = key.trim();
    // Object.fromEntries silently collapses duplicate keys, so an edit that
    // renames a row onto an existing output key would clobber that row's
    // value with no feedback. Reject the dup before serializing rather than
    // letting the collision swallow data.
    const collidesWith = entries.findIndex(
      (entry, i) => i !== idx && trimmedKey !== "" && entry[0] === trimmedKey,
    );
    if (collidesWith !== -1) {
      setKeyError(
        `Output key "${trimmedKey}" is already used by another assignment. Keys must be unique.`,
      );
      return;
    }
    setKeyError(null);
    const next = entries.map((entry, i) => (i === idx ? ([trimmedKey, value] as [string, string]) : entry));
    onChange(Object.fromEntries(next));
  }
  function addRow() {
    onChange({ ...assignments, "": "" });
  }
  function removeRow(idx: number) {
    onChange(Object.fromEntries(entries.filter((_, i) => i !== idx)));
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
        Field assignments — output ← source
      </label>
      {keyError ? (
        <div
          role="alert"
          className="rounded-md border border-amber-500 bg-amber-500/10 px-3 py-2 text-[11px]"
        >
          {keyError}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No assignments yet.</p>
      ) : null}
      {entries.map(([k, v], i) => (
        <div key={`${i}-${k}`} className="flex items-center gap-1">
          <input
            type="text"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            placeholder="output_path"
            disabled={!canEdit}
            defaultValue={k}
            onBlur={(e) => updateRow(i, e.target.value, v)}
          />
          <span className="text-[10px] text-muted-foreground">←</span>
          <input
            type="text"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            placeholder="source.path"
            disabled={!canEdit}
            defaultValue={v}
            onBlur={(e) => updateRow(i, k, e.target.value)}
          />
          {canEdit ? (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(i)}
              title="Remove row"
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <button
          type="button"
          className="text-[11px] text-foreground underline-offset-2 hover:underline"
          onClick={addRow}
        >
          + add assignment
        </button>
      ) : null}
    </div>
  );
}

function DestinationEditor({
  value,
  canEdit,
  attachedDestinations,
  placedDestinationIds,
  onChange,
}: {
  value: string;
  canEdit: boolean;
  attachedDestinations: { id: string; name: string; type: string }[];
  placedDestinationIds?: Set<string>;
  onChange: (next: string) => void;
}) {
  // Offer the node's own destination plus any attached destination that
  // isn't already backed by another node — two nodes on one destination
  // would double-deliver, and the server rejects that graph
  // (graph_duplicate_destination).
  const options = attachedDestinations.filter(
    (d) => d.id === value || !placedDestinationIds?.has(d.id),
  );
  return (
    <div className="space-y-2">
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
        Destination
      </label>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        disabled={!canEdit}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.type})
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">
        {attachedDestinations.length > 1 && options.length === 1
          ? "Every other attached destination already has a node on this canvas. "
          : null}
        Manage which destinations are attached to this route on the Destinations tab.
      </p>
    </div>
  );
}
