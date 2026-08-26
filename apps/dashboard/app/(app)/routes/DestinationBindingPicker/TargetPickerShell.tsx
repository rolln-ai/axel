"use client";

import { RefreshCw, Plus, Loader2, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { includeSavedTarget } from "./helpers";

/**
 * Presentational chrome shared by every per-type binding picker: the
 * role="group" container, the hidden `binding:<destination_id>` input the
 * route form's server action reads on submit, and the heading row (with the
 * reload button for pickers that list live targets).
 */
export function TargetPickerShell({
  destinationId,
  destinationName,
  heading,
  groupLabel,
  binding,
  reload,
  children,
}: {
  destinationId: string;
  destinationName: string;
  /** Heading suffix after the destination name, e.g. "table", "volume". */
  heading: string;
  /** aria-label suffix, e.g. "table binding". */
  groupLabel: string;
  /** Serialized into the hidden input; null submits an empty value. */
  binding: Record<string, unknown> | null;
  /** Present only for pickers that list live targets. */
  reload?: { loading: boolean; onReload: () => void; ariaLabel: string };
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={`${destinationName} — ${groupLabel}`}
      className="space-y-2 rounded-md border border-input bg-muted/30 p-2.5 text-xs"
    >
      <input
        type="hidden"
        name={`binding:${destinationId}`}
        value={binding ? JSON.stringify(binding) : ""}
      />
      {reload ? (
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground">{destinationName} — {heading}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-1.5 text-xs"
            aria-label={reload.ariaLabel}
            onClick={reload.onReload}
            disabled={reload.loading}
          >
            <RefreshCw className={`size-3 ${reload.loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      ) : (
        <span className="font-semibold text-foreground">{destinationName} — {heading}</span>
      )}
      {children}
    </div>
  );
}

/**
 * The "Pick existing" dropdown over the live target list, including the saved
 * target that the latest scan didn't return.
 *
 * Radix Select normalises an invalid `value` (i.e. one that doesn't match any
 * SelectItem) by firing `onValueChange("")` on the next render. Previously
 * this picker bound the Select to the same state the typed Input writes to —
 * every keystroke set the value to a string not in `targets`, the Select then
 * reset it to "", and the operator could never enter a new target name. Pass
 * only matched/saved values to Select so the normalisation never fires;
 * new-target typing stays in the Create input.
 */
export function ExistingTargetSelect({
  targets,
  loading,
  selected,
  onPick,
  triggerId,
  triggerAriaLabel,
  placeholders,
  savedMissingNote,
}: {
  targets: string[] | null;
  loading: boolean;
  selected: string;
  onPick: (name: string) => void;
  triggerId?: string;
  triggerAriaLabel: string;
  /** Placeholder shown while loading / with items / with an empty list. */
  placeholders: { loading: string; pick: string; empty: string };
  /** e.g. "Showing the saved table even though it was not returned by the latest table scan." */
  savedMissingNote: string;
}) {
  const selectableTargets = includeSavedTarget(targets, selected);
  const selectedMissingFromLiveTargets =
    Boolean(selected) && targets !== null && !targets.includes(selected);
  return (
    <>
      <Select value={selected} onValueChange={onPick} disabled={loading}>
        <SelectTrigger id={triggerId} className="h-8 text-xs" aria-label={triggerAriaLabel}>
          <SelectValue
            placeholder={
              loading
                ? placeholders.loading
                : targets && targets.length > 0
                  ? placeholders.pick
                  : placeholders.empty
            }
          />
        </SelectTrigger>
        <SelectContent>
          {selectableTargets.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
              {selectedMissingFromLiveTargets && name === selected ? " (saved)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedMissingFromLiveTargets ? (
        <p className="text-xs text-muted-foreground">{savedMissingNote}</p>
      ) : null}
    </>
  );
}

/** The "Or create new" input + button row with its success/error status lines. */
export function CreateTargetRow({
  draft,
  onDraftChange,
  inputAriaLabel,
  placeholder,
  pending,
  onCreate,
  createError,
  createSuccess,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  inputAriaLabel: string;
  placeholder: string;
  pending: boolean;
  onCreate: () => void;
  createError: string | null;
  createSuccess: string | null;
}) {
  return (
    <>
      <p className="text-xs font-medium text-muted-foreground">Or create new</p>
      <div className="flex gap-2">
        <Input
          aria-label={inputAriaLabel}
          placeholder={placeholder}
          className="h-8 flex-1 font-mono text-xs"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={!draft.trim() || pending}
          onClick={onCreate}
        >
          {pending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          Create
        </Button>
      </div>
      {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
      {createSuccess ? (
        <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
          <CheckCircle2 className="size-3.5 shrink-0" />
          {createSuccess}
        </p>
      ) : null}
    </>
  );
}
