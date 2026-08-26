import { ArrowRight, Diff } from "lucide-react";
import type {
  GeneratedFilter,
  GeneratedTransform,
} from "../../../../../lib/data-contracts/codegen";

/**
 * Renders the side-by-side diff of the current transform/filter vs the
 * model-proposed patched version. Kept simple: the declarative DSL is
 * already JSON, so pretty-printed JSON IS the diff. Operators can read
 * the structural change without a real diff library.
 *
 * Server component on purpose — no client interactivity, server-renders
 * during the investigation page's stream.
 */
export function PatchDiff({
  patchKind,
  currentTransform,
  currentFilter,
  patchedTransform,
  patchedFilter,
}: {
  patchKind: "transform" | "filter" | "none";
  currentTransform: GeneratedTransform;
  currentFilter: GeneratedFilter | null;
  patchedTransform?: GeneratedTransform;
  patchedFilter?: GeneratedFilter;
}) {
  if (patchKind === "none") return null;

  const target = patchKind === "transform" ? "transform" : "filter";
  const before =
    patchKind === "transform" ? currentTransform : currentFilter ?? { kind: "always" };
  const after =
    patchKind === "transform" ? patchedTransform : patchedFilter;

  if (!after) return null;

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
        <Diff className="size-3.5" /> Proposed {target} change
      </h2>
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
        <DiffCol label="Current" value={before} tone="muted" />
        <div className="hidden items-center justify-center md:flex">
          <ArrowRight className="size-4 text-muted-foreground" />
        </div>
        <DiffCol label="Proposed" value={after} tone="accent" />
      </div>
    </section>
  );
}

function DiffCol({
  label,
  value,
  tone,
}: {
  label: string;
  value: unknown;
  tone: "muted" | "accent";
}) {
  return (
    <div
      className={
        "rounded-md border p-3 " +
        (tone === "accent"
          ? "border-foreground/30 bg-background"
          : "border-border bg-muted/40")
      }
    >
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-relaxed text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function BeforeAfter({
  rows,
}: {
  rows: Array<{ event_id: string; before: unknown; after: unknown }>;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
        <Diff className="size-3.5" /> Output diff on the failed event(s)
      </h2>
      <p className="mb-3 text-[11px] text-muted-foreground">
        What the current transform produced vs what the patched one would produce.
        The replay (after approval) sends the right column, not the left.
      </p>
      <ul className="grid gap-3">
        {rows.map((row) => (
          <li key={row.event_id} className="grid gap-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              event{" "}
              <code className="font-mono normal-case text-foreground">
                {row.event_id}
              </code>
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <DiffCol label="Current output" value={row.before} tone="muted" />
              <DiffCol label="Patched output" value={row.after} tone="accent" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
