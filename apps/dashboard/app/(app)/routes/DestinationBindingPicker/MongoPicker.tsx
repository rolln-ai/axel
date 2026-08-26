"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createMongoCollection } from "../../../../lib/destination-binding-actions";
import { str } from "./helpers";
import { useTargetPicker } from "./hooks";
import { CreateTargetRow, ExistingTargetSelect, TargetPickerShell } from "./TargetPickerShell";

export function MongoPicker({
  destinationId,
  destinationName,
  initialBinding,
}: {
  destinationId: string;
  destinationName: string;
  initialBinding?: Record<string, unknown> | null;
}) {
  const picker = useTargetPicker(destinationId, str(initialBinding?.collection));
  const collection = picker.target;
  const [idempotencyField, setIdempotencyField] = useState(str(initialBinding?.idempotency_field));
  const idempotencyId = `mongo-idempotency-${destinationId}`;
  const collectionId = `mongo-collection-${destinationId}`;

  const binding = collection
    ? idempotencyField
      ? { collection, idempotency_field: idempotencyField }
      : { collection }
    : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="collection"
      groupLabel="collection binding"
      binding={binding}
      reload={{
        loading: picker.loading,
        onReload: picker.reload,
        ariaLabel: "Reload collection list",
      }}
    >
      {picker.loadErr ? (
        <p className="text-destructive">Couldn't list collections: {picker.loadErr}</p>
      ) : null}
      <Label htmlFor={collectionId} className="text-xs font-medium text-muted-foreground">Pick existing</Label>
      <ExistingTargetSelect
        targets={picker.targets}
        loading={picker.loading}
        selected={picker.selected}
        onPick={picker.pick}
        triggerId={collectionId}
        triggerAriaLabel={`${destinationName} — collection`}
        placeholders={{
          loading: "Loading collections…",
          pick: "Pick existing collection…",
          empty: "(no collections yet)",
        }}
        savedMissingNote="Showing the saved collection even though it was not returned by the latest collection scan."
      />
      <CreateTargetRow
        draft={picker.draft}
        onDraftChange={picker.setDraft}
        inputAriaLabel="New collection name"
        placeholder="new_collection"
        pending={picker.pending}
        onCreate={() => picker.runCreate((name) => createMongoCollection(destinationId, name))}
        createError={picker.createError}
        createSuccess={picker.createSuccess}
      />
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={idempotencyId} className="self-center text-xs text-muted-foreground">Idempotency field</Label>
        <Input
          id={idempotencyId}
          value={idempotencyField}
          onChange={(e) => setIdempotencyField(e.target.value)}
          placeholder="event_id (optional)"
          className="h-8 font-mono text-xs"
        />
      </div>
      <p className="text-muted-foreground">A top-level field name in the event document (e.g. <code>id</code> or <code>event_id</code>) used to skip duplicate deliveries — Axel will upsert using this field as the match key. Nested paths are not supported; extract the field you need in the route transform first. Leave blank to insert every event.</p>
      <p className="text-muted-foreground">
        Each event is inserted as a single document into this collection.
      </p>
    </TargetPickerShell>
  );
}
