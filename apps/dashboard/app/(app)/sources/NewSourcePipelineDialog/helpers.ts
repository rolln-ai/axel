import { Cable } from "lucide-react";

export type DestinationMode = "skip" | "existing" | "new";

export interface ExistingDestination {
  id: string;
  name: string;
  type: string;
}

// The wizard is intentionally webhook-only: pull-source creation is retired.
// (Existing pull sources keep syncing and are listed on the Sources page.)
export const WEBHOOK_SOURCE_TYPE = {
  type: "webhook",
  label: "Webhook",
  description: "Accept pushed events from any HTTP provider (Stripe, GitHub, Shopify, Chargebee, or custom HMAC).",
  icon: Cable,
} as const;

// Destination types whose first event will fail at delivery time
// without a binding (table / collection / volume). Mirrors the
// DestinationBindingPicker dispatch — keep them in sync.
export const BINDING_REQUIRED_TYPES = new Set<string>([
  "postgres",
  "mongodb",
  "databricks_sql",
  "databricks_volume",
  "bigquery",
]);

export function bindingMissingMessage(destinationType: string): string {
  switch (destinationType) {
    case "postgres":
      return "Pick or name the Postgres table this route should write to.";
    case "mongodb":
      return "Pick or name the MongoDB collection this route should write to.";
    case "databricks_sql":
      return "Pick the Databricks table this route should write to.";
    case "databricks_volume":
      return "Name the Databricks volume this route should write to.";
    case "bigquery":
      return "Pick or name the BigQuery dataset.table this route should write to.";
    default:
      return "Fill in the destination binding before continuing.";
  }
}

// Labels for the new-destination target input (the route binding). A brand-new
// destination has no id yet, so we can't list live tables like
// DestinationBindingPicker does — we just capture the name and shape it
// server-side (see pipelineBindingForNewDestination in actions.ts).
export function bindingTargetLabel(destinationType: string): string {
  switch (destinationType) {
    case "mongodb":
      return "Target collection";
    case "databricks_volume":
      return "Target volume";
    case "databricks_sql":
      return "Target Delta table";
    case "bigquery":
      return "Target BigQuery dataset.table";
    default:
      return "Target table";
  }
}

export function bindingTargetHint(destinationType: string): string {
  switch (destinationType) {
    case "mongodb":
      return "The collection this route writes each event into. Refine write options later on the route's Destinations tab.";
    case "databricks_sql":
      return "The Delta table this route writes each event into. Create a STRING or VARIANT column (e.g. payload STRING) to receive the JSON body — one INSERT per event.";
    case "databricks_volume":
      return "Volume name only — not the full path. Must be lowercase letters, numbers, and underscores (e.g. webhooks_landing). Axel writes to /Volumes/{catalog}/{schema}/{volume}/.";
    case "bigquery":
      return "Where this route writes events (for example analytics.events). Axel creates the table on the first delivery if it does not exist.";
    default:
      return "The table this route writes each event into — one JSONB row per event by default. Refine the write mode later on the route's Destinations tab.";
  }
}

/** True when the string is a complete JSON object — distinguishes a fully
 * pasted service-account key from one still being typed, so we don't call the
 * BigQuery API with a half-entered token. */
export function isCompleteJsonObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return !!parsed && typeof parsed === "object";
  } catch {
    return false;
  }
}
