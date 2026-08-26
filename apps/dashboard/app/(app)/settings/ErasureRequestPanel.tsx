"use client";

import { useState } from "react";
import { useActionState } from "react";
import { runWorkspaceErasureAction } from "../../../lib/erasure-actions";
import type { ActionState } from "../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Customer-facing GDPR erasure ("right to be forgotten"). The owner supplies one
 * or more subject identifiers (the same kind+value they configured as subject
 * keys on their sources); the server locates the person's events via the index
 * and erases them across every store. Owner-only; the workspace is taken from
 * the session server-side.
 */
const KINDS = ["email", "id", "phone", "username", "other"] as const;
type Row = { kind: string; value: string };

export function ErasureRequestPanel({ role }: { role: "owner" | "admin" | "member" }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(runWorkspaceErasureAction, {});
  const [rows, setRows] = useState<Row[]>([{ kind: "email", value: "" }]);
  const isOwner = role === "owner";

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  const add = () => setRows((rs) => [...rs, { kind: "email", value: "" }]);

  const selectCls =
    "h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50";

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Erase a data subject (GDPR)</h3>
        <p className="text-[11px] text-muted-foreground">
          Locate and delete everything about one person across R2, ClickHouse, and Postgres.
          Requires <span className="font-medium">subject keys</span> configured on the relevant
          source(s). Coverage is forward-only from when subject keys were enabled. This is
          irreversible.
        </p>
      </div>

      {!isOwner ? (
        <Alert>
          <AlertDescription>Only the workspace owner can run an erasure request.</AlertDescription>
        </Alert>
      ) : null}

      <form action={action} className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              aria-label="Identifier kind"
              name="kind"
              className={selectCls}
              value={row.kind}
              onChange={(e) => update(i, { kind: e.target.value })}
              disabled={!isOwner}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <Input
              aria-label="Identifier value"
              name="value"
              className="flex-1"
              placeholder={row.kind === "email" ? "person@example.com" : "the subject value"}
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              disabled={!isOwner}
            />
            {isOwner && rows.length > 1 ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" name="confirm_large_set" value="yes" disabled={!isOwner} />
          Confirm erasing even if this matches a large set (&gt;50k events) — e.g. a shared value.
        </label>

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

        {isOwner ? (
          <div className="flex justify-between">
            <Button type="button" size="sm" variant="outline" onClick={add}>
              + Add identifier
            </Button>
            <Button type="submit" size="sm" variant="destructive" disabled={pending}>
              {pending ? "Running…" : "Run erasure"}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
