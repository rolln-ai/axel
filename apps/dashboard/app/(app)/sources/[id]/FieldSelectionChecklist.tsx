"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search, Shield } from "lucide-react";
import { updateSourceFieldSelection } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import {
  formatFieldSelectionText,
  parseFieldSelectionText,
  projectPayload,
} from "../../../../lib/field-selection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ContractField {
  path: string;
  /** Semantic category (id, email, url, numeric, etc.) — drives the badge. */
  category: string;
  /** Presence rate 0..1 — shown only when < 1.0 ("optional"). */
  presence: number;
  /** True if this path is in the inferred sensitive_fields list. */
  sensitive: boolean;
}

interface FieldSelectionChecklistProps {
  sourceId: string;
  /** Currently-saved allow-list (null = pass through). */
  initialPaths: string[] | null;
  /** All paths from the Data Contract's current inferred schema. */
  contractFields: ContractField[];
  /** Most recent event payload (or generic sample) used to render the preview. */
  samplePayload: unknown;
}

/**
 * Contract-driven field selection editor — replaces the free-text
 * textarea. Renders one checkbox per inferred path so an operator can
 * toggle fields by clicking instead of guessing dot-paths.
 *
 * An "Advanced" disclosure still exposes the underlying text form for
 * power users who need to project fields the contract hasn't observed
 * yet (newly-added fields between samplings, computed paths, etc.).
 */
export function FieldSelectionChecklist({
  sourceId,
  initialPaths,
  contractFields,
  samplePayload,
}: FieldSelectionChecklistProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateSourceFieldSelection,
    {},
  );

  const initialSet = useMemo(
    () => new Set(initialPaths ?? []),
    [initialPaths],
  );

  const [selected, setSelected] = useState<Set<string>>(initialSet);
  const [filter, setFilter] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Path additions the contract doesn't know about — kept separate so
  // toggling contract fields doesn't trample them.
  const [extraText, setExtraText] = useState<string>(() => {
    const contractSet = new Set(contractFields.map((f) => f.path));
    const extras = (initialPaths ?? []).filter((p) => !contractSet.has(p));
    return formatFieldSelectionText(extras);
  });

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  const visibleFields = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return contractFields;
    return contractFields.filter(
      (f) => f.path.toLowerCase().includes(q) || f.category.toLowerCase().includes(q),
    );
  }, [filter, contractFields]);

  const allPaths = useMemo(() => {
    const fromChecklist = Array.from(selected);
    const { paths: extraPaths } = parseFieldSelectionText(extraText);
    // De-dupe while preserving order: contract picks first, then extras.
    const seen = new Set(fromChecklist);
    for (const p of extraPaths) {
      if (!seen.has(p)) {
        fromChecklist.push(p);
        seen.add(p);
      }
    }
    return fromChecklist;
  }, [selected, extraText]);

  const preview = useMemo(() => {
    if (allPaths.length === 0) return { kind: "passthrough" } as const;
    if (samplePayload === null || samplePayload === undefined) {
      return { kind: "no-sample", paths: allPaths } as const;
    }
    const projected = projectPayload(samplePayload, allPaths);
    return { kind: "projected", paths: allPaths, projected } as const;
  }, [allPaths, samplePayload]);

  function togglePath(path: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(contractFields.map((f) => f.path)));
  }

  function clearAll() {
    setSelected(new Set());
    setExtraText("");
  }

  const passThrough = allPaths.length === 0;
  const selectionText = formatFieldSelectionText(allPaths);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="source_id" value={sourceId} />
      {/* The action still reads selection_text — we just compute it
          from the checklist + extras instead of asking the user to
          type dot-paths. */}
      <input type="hidden" name="selection_text" value={selectionText} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
        {/* Left: checklist + filter + advanced */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium text-muted-foreground">
              Fields from the Data Contract contract ({contractFields.length})
            </Label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {passThrough ? (
                <span>pass-through (all fields)</span>
              ) : (
                <span>{allPaths.length} selected</span>
              )}
              <button
                type="button"
                onClick={selectAll}
                disabled={pending}
                className="text-foreground underline-offset-2 hover:underline disabled:opacity-50"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={pending}
                className="text-foreground underline-offset-2 hover:underline disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter fields"
              className="pl-8 text-xs"
            />
          </div>

          <ul className="max-h-80 overflow-y-auto rounded-md border border-border">
            {visibleFields.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                No fields match "{filter}".
              </li>
            ) : (
              visibleFields.map((field) => {
                const checked = selected.has(field.path);
                const optional = field.presence < 1;
                return (
                  <li
                    key={field.path}
                    className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-0 hover:bg-muted/40"
                  >
                    <label className="flex flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => togglePath(field.path, e.target.checked)}
                        className="size-3.5 rounded border-border bg-background text-primary"
                      />
                      <code className="font-mono text-xs text-foreground">{field.path}</code>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {field.category}
                      </Badge>
                      {field.sensitive ? (
                        <Badge
                          variant="destructive"
                          className="text-[10px] font-normal"
                          title="Flagged as sensitive — likely contains PII"
                        >
                          <Shield className="mr-0.5 size-2.5" />
                          sensitive
                        </Badge>
                      ) : null}
                      {optional ? (
                        <span className="text-[10px] text-muted-foreground">
                          {(field.presence * 100).toFixed(0)}% of events
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })
            )}
          </ul>

          <details
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            className="rounded-md border border-border"
          >
            <summary className="flex cursor-pointer select-none items-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown
                className={`size-3 transition-transform ${advancedOpen ? "rotate-0" : "-rotate-90"}`}
              />
              Advanced: add paths the contract doesn't know yet
            </summary>
            <div className="border-t border-border p-3">
              <Textarea
                value={extraText}
                onChange={(e) => setExtraText(e.target.value)}
                placeholder={"# one dot-path per line\ndata.new_field"}
                spellCheck={false}
                rows={4}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Useful for fields added between contract refreshes. They'll be merged with the
                checklist selection above.
              </p>
            </div>
          </details>
        </div>

        {/* Right: preview */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Preview (most recent event projected)
          </Label>
          {preview.kind === "passthrough" ? (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
              {"// pass-through — destinations get the full payload"}
            </pre>
          ) : preview.kind === "no-sample" ? (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
              {"// will project to: "}
              {preview.paths.join(", ")}
              {"\n// no recent events to preview against — send a webhook to see the projection."}
            </pre>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(preview.projected, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save field selection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={clearAll}
          disabled={pending}
        >
          Clear (pass-through)
        </Button>
      </div>
    </form>
  );
}
