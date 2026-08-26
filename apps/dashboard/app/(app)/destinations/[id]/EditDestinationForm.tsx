"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateDestination } from "../../../../lib/destination-actions";
import type { ActionState } from "../../../../lib/action-data";
import {
  applyDestinationFieldValue,
  schemaFor,
  type DestinationType,
} from "../../../../lib/destination-defaults";
import { ConditionalDestField } from "../ConditionalDestField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  destinationId: string;
  type: DestinationType;
  name: string;
  config: Record<string, unknown>;
}

export function EditDestinationForm({ destinationId, type, name, config }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(updateDestination, {});
  const schema = schemaFor(type);
  const configFields = schema.fields.filter((field) => field.kind === "config");

  // Controlled like the create form — React 19 resets uncontrolled fields
  // after a form action completes (even on error), and the shared renderer
  // needs live values to re-evaluate `showWhen` visibility as the user picks
  // a different auth mode / preset. Seeded from the stored config so
  // conditional fields open on the values the destination already has.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of configFields) {
      const currentValue = config[field.key];
      initial[field.key] =
        typeof currentValue === "string" || typeof currentValue === "number"
          ? String(currentValue)
          : (field.defaultValue ?? "");
    }
    return initial;
  });
  const setFieldValue = (key: string, value: string) =>
    setFieldValues((prev) => applyDestinationFieldValue(prev, key, value));

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="destination_id" value={destinationId} />

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

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start">
        <Label htmlFor="dest-name" className="pt-2 text-sm font-medium">
          Name
        </Label>
        <div className="space-y-1.5">
          <Input
            id="dest-name"
            name="name"
            type="text"
            defaultValue={name}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            2–64 chars: letters, numbers, spaces, and . _ -.
          </p>
        </div>
      </div>

      {configFields.map((field) => (
        <ConditionalDestField
          key={field.key}
          field={field}
          type={type}
          fieldValues={fieldValues}
          setFieldValue={setFieldValue}
          disabled={pending}
          layout="row"
        />
      ))}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <small className="text-xs text-muted-foreground">
          Secret fields aren&apos;t editable here — use the rotate-credentials form below.
        </small>
      </div>
    </form>
  );
}
