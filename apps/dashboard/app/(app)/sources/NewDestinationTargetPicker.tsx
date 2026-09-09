"use client";

import { type RefObject, useState, useTransition } from "react";
import { CheckCircle2, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createTableForConnection,
  listTablesForConnection,
} from "../../../lib/destination-binding-actions";
import { usePendingSelect } from "../routes/DestinationBindingPicker/hooks";

/**
 * Target picker for a NEW destination in the New Source wizard. The destination
 * doesn't exist yet, so we drive list/create straight from the connection
 * string the user just entered (read from the form) rather than a destination
 * id. Writes the chosen name to the hidden `new_destination_target` field the
 * create action reads. Postgres/Mongo only — other types use a plain input.
 */
function readField(form: HTMLFormElement | null, name: string): string {
  // Prefer a scoped read from the wizard's own <form> (passed via formRef) so
  // we never accidentally pick up a same-named field from another form on the
  // page; fall back to a document-wide lookup only if no ref is available.
  if (form) {
    const value = new FormData(form).get(name);
    return typeof value === "string" ? value.trim() : "";
  }
  if (typeof document === "undefined") return "";
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  return el?.value?.trim() ?? "";
}

export function NewDestinationTargetPicker({
  destinationType,
  formRef,
}: {
  destinationType: string;
  formRef?: RefObject<HTMLFormElement | null>;
}) {
  const noun = destinationType === "mongodb" ? "collection" : "table";
  // Two independent inputs that must not bleed into each other:
  //   - `selected`: an existing target picked from the dropdown (after Load)
  //   - `draft`:    a new name typed into the Create box
  // Previously both shared one state, so picking an existing table dumped its
  // name into the Create box (and vice-versa), which read as a bug. A typed
  // draft takes precedence; otherwise we submit the dropdown selection.
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [targets, setTargets] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [creating, startCreate] = useTransition();
  // Auto-select a just-created target once it appears in the dropdown —
  // shared with the per-destination pickers (see usePendingSelect for the
  // Radix item-registration race this defers around).
  const setPendingSelect = usePendingSelect(targets, setSelected);

  const target = draft.trim() || selected;

  // Manual only — we never auto-load tables when the connection string is
  // entered (it would fire probes on every keystroke and surprise the user);
  // the operator clicks Load when they want to browse existing targets.
  function load() {
    setMsg(null);
    setErr(null);
    startLoad(async () => {
      const r = await listTablesForConnection(
        destinationType,
        readField(formRef?.current ?? null, "dest_field_connection_string"),
        readField(formRef?.current ?? null, "dest_field_database"),
      );
      if (r.ok) {
        setTargets(r.targets);
        if (r.targets.length === 0) setMsg(`No ${noun}s found yet — name one below and Create it.`);
      } else {
        setErr(r.error);
      }
    });
  }

  function create() {
    setMsg(null);
    setErr(null);
    startCreate(async () => {
      const r = await createTableForConnection(
        destinationType,
        readField(formRef?.current ?? null, "dest_field_connection_string"),
        draft.trim(),
        readField(formRef?.current ?? null, "dest_field_database"),
      );
      if (r.ok) {
        setMsg(`Created "${r.name}"`);
        // Promote the created table to the dropdown selection and clear the
        // draft so it shows as "picked" rather than lingering in the Create box.
        // The select itself is applied via the effect above, once the new item
        // has mounted (avoids the Radix registration race).
        setTargets((prev) => (prev && prev.includes(r.name) ? prev : [...(prev ?? []), r.name]));
        setPendingSelect(r.name);
        setDraft("");
      } else {
        setErr(r.error);
      }
    });
  }

  return (
    <div className="space-y-1.5">
      {/* The create action reads this — typed draft wins, else the dropdown pick. */}
      <input type="hidden" name="new_destination_target" value={target} />
      <Label htmlFor="pipeline-new-dest-target">Target {noun}</Label>
      <p className="text-xs text-muted-foreground">
        Where this route writes each event. Pick an existing {noun} (click Load to list them), or type a new
        name and Create it.
      </p>
      {destinationType === "postgres" ? (
        <p className="text-xs text-muted-foreground">
          New routes use dot-notation columns. A table created here starts with metadata columns.
          Add the event fields yourself, or explicitly allow new fields below before sending events.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Axel stores each event as a native MongoDB document in this collection.
        </p>
      )}
      <p className="text-xs font-medium text-muted-foreground">Pick existing</p>
      <div className="flex gap-2">
        {/* Pass only matched values to Select so Radix doesn't reset the pick
            (see DestinationBindingPicker for the rationale). Selecting only
            sets `selected`; it never touches the Create box. */}
        <Select
          value={targets?.includes(selected) ? selected : ""}
          onValueChange={(v) => {
            setSelected(v);
            setDraft("");
          }}
        >
          <SelectTrigger id="pipeline-new-dest-target" className="h-9 flex-1 text-xs">
            <SelectValue
              placeholder={targets && targets.length > 0 ? `Pick a ${noun}…` : `Load to pick an existing ${noun}`}
            />
          </SelectTrigger>
          <SelectContent>
            {(targets ?? []).map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={load}
          disabled={loading}
          aria-label={`Load existing ${noun}s from the database`}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : targets === null ? (
            <Search className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Load
        </Button>
      </div>
      <Label htmlFor="pipeline-new-dest-create" className="text-xs font-medium text-muted-foreground">
        Or create new {noun}
      </Label>
      <div className="flex gap-2">
        <Input
          id="pipeline-new-dest-create"
          className="h-9 flex-1 font-mono text-xs"
          placeholder={`new_${noun}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={create}
          disabled={!draft.trim() || creating}
        >
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Create
        </Button>
      </div>
      {err ? <p className="text-xs text-destructive">{err}</p> : null}
      {msg ? (
        <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
          <CheckCircle2 className="size-3.5 shrink-0" />
          {msg}
        </p>
      ) : null}
      {destinationType === "postgres" ? (
        <p className="text-xs text-muted-foreground">
          New tables are always created in the public schema. For a different schema (e.g. app.events), create it
          manually in Postgres, then click Load to pick it.
        </p>
      ) : destinationType === "mongodb" ? (
        <p className="text-xs text-muted-foreground">
          New collections are created in the database you specified above. To use a different database, update the
          Database field and click Load.
        </p>
      ) : null}
    </div>
  );
}
