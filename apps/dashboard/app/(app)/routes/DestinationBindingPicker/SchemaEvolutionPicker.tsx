"use client";

import type { SchemaEvolution } from "@axel/shared";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Shared policy control for the three destinations that can alter table schemas. */
export function SchemaEvolutionPicker({ id, value, onChange }: {
  id: string;
  value: SchemaEvolution;
  onChange: (value: SchemaEvolution) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={id} className="self-center text-xs text-muted-foreground">Schema changes</Label>
        <Select value={value} onValueChange={(next) => onChange(next === "add_columns" ? "add_columns" : "manual")}>
          <SelectTrigger id={id} className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Keep existing schema</SelectItem>
            <SelectItem value="add_columns">Allow new fields</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {value === "add_columns"
          ? "Axel may add fields to this table. Added fields can break downstream views, unions, and dashboards. Check those dependencies before enabling this. Existing column types stay unchanged."
          : "Axel keeps existing tables unchanged. Events that need new fields or different column types go to failed deliveries for review and replay. Missing tables can be created from the first event."}
      </p>
    </div>
  );
}

export function NewDestinationSchemaPolicy() {
  const [value, setValue] = useState<SchemaEvolution>("manual");
  return <>
    <input type="hidden" name="new_destination_schema_evolution" value={value} />
    <SchemaEvolutionPicker id="new-destination-schema" value={value} onChange={setValue} />
  </>;
}
