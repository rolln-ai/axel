"use client";

import { useState } from "react";
import { useActionState } from "react";
import type { SubjectKeyPath } from "@axel/shared";
import { updateSourceSubjectKeysAction } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Configure which field(s) identify a data subject on this source's events, so
 * ingest can index them (hashed) for per-subject GDPR erasure. A repeatable row
 * of {location, path, kind}. Client-side is UX only — the server action
 * re-validates against the authoritative allowlist.
 */
const LOCATIONS = ["body", "header", "query"] as const;
const KINDS = ["email", "id", "phone", "username", "other"] as const;

type Row = { loc: string; path: string; kind: string };

export function SubjectKeysEditor({
  sourceId,
  initialKeys,
  canMutate,
}: {
  sourceId: string;
  initialKeys: SubjectKeyPath[];
  canMutate: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateSourceSubjectKeysAction,
    {},
  );
  const [rows, setRows] = useState<Row[]>(
    initialKeys.map((k) => ({ loc: k.loc, path: k.path, kind: k.kind ?? "" })),
  );

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const add = () => setRows((rs) => [...rs, { loc: "body", path: "", kind: "" }]);

  const serialized = JSON.stringify(
    rows
      .filter((r) => r.path.trim().length > 0)
      .map((r) =>
        r.kind
          ? { loc: r.loc, path: r.path.trim(), kind: r.kind }
          : { loc: r.loc, path: r.path.trim() },
      ),
  );

  const selectCls =
    "h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50";

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="source_id" value={sourceId} />
      <input type="hidden" name="subject_key_paths" value={serialized} />
      <div className="space-y-1.5">
        <Label>Subject keys (for GDPR erasure)</Label>
        <p className="text-[11px] text-muted-foreground">
          Point at the field(s) that identify a data subject — e.g. body path{" "}
          <code className="font-mono">customer.email</code>. New events are indexed by these
          values (hashed, never stored raw) so you can erase everything about one person. Leave
          empty to disable indexing.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No subject keys configured.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                aria-label="Location"
                className={selectCls}
                value={row.loc}
                onChange={(e) => update(i, { loc: e.target.value })}
                disabled={!canMutate}
              >
                {LOCATIONS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <Input
                aria-label="Path"
                className="flex-1 font-mono text-xs"
                placeholder={row.loc === "body" ? "customer.email" : "X-Customer-Email"}
                value={row.path}
                onChange={(e) => update(i, { path: e.target.value })}
                disabled={!canMutate}
              />
              <select
                aria-label="Kind"
                className={selectCls}
                value={row.kind}
                onChange={(e) => update(i, { kind: e.target.value })}
                disabled={!canMutate}
              >
                <option value="">kind…</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              {canMutate ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)}>
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

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

      {canMutate ? (
        <div className="flex justify-between">
          <Button type="button" size="sm" variant="outline" onClick={add}>
            + Add subject key
          </Button>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save subject keys"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
