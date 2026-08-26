"use client";

import type { DestinationSchema } from "../../../../../lib/destination-defaults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BINDING_REQUIRED_TYPES,
  WEBHOOK_SOURCE_TYPE,
  type DestinationMode,
  type ExistingDestination,
} from "../helpers";

/**
 * Step 3 — pipeline name + read-only review of everything about to be created.
 * Rendered inside the wizard's single <form>; hidden (not unmounted) on other
 * steps so field state survives step transitions.
 */
export function ReviewStep({
  destinationMode,
  pipelineName,
  onPipelineNameChange,
  sourceName,
  existingDestinations,
  pickedExistingDestId,
  selectedDestSchema,
  newDestinationType,
  readFormValue,
  onEditStep,
}: {
  destinationMode: DestinationMode;
  pipelineName: string;
  onPipelineNameChange: (name: string) => void;
  sourceName: string;
  existingDestinations: ExistingDestination[];
  pickedExistingDestId: string;
  selectedDestSchema: DestinationSchema | undefined;
  newDestinationType: string;
  readFormValue: (name: string) => string;
  onEditStep: (step: 1 | 2) => void;
}) {
  return (
    <>
      {/* No route is created on the skip path, so there's nothing to
          name — hiding the input also keeps pipeline_name out of the
          submitted FormData, which the server ignores for skip anyway. */}
      {destinationMode !== "skip" ? (
        <div className="space-y-1.5">
          <Label htmlFor="pipeline-name-wizard">Pipeline name</Label>
          <Input
            id="pipeline-name-wizard"
            name="pipeline_name"
            value={pipelineName}
            onChange={(e) => onPipelineNameChange(e.target.value)}
            minLength={2}
            maxLength={64}
            placeholder={sourceName ? `${sourceName}-pipeline` : "my-pipeline"}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            2–64 characters: letters, numbers, spaces, and . _ - (e.g. “Stripe events pipeline”).
          </p>
        </div>
      ) : null}
      {(() => {
        // Surface the real configured values (not category labels) so the
        // operator can confirm what they're about to create. Read-only —
        // these mirror the controlled state / hidden-not-unmounted fields.
        const sourceValue = sourceName
          ? `${WEBHOOK_SOURCE_TYPE.label} · ${sourceName}`
          : WEBHOOK_SOURCE_TYPE.label;
        const destValue =
          destinationMode === "existing"
            ? existingDestinations.find((d) => d.id === pickedExistingDestId)?.name ??
              "an existing destination in this workspace"
            : destinationMode === "new"
            ? [selectedDestSchema?.label, readFormValue("new_destination_name")]
                .filter(Boolean)
                .join(" · ")
            : "none — source created without a route";
        const bindingTypeForReview =
          destinationMode === "new"
            ? newDestinationType
            : destinationMode === "existing"
            ? existingDestinations.find((d) => d.id === pickedExistingDestId)?.type ?? ""
            : "";
        const targetValue =
          destinationMode === "new" && BINDING_REQUIRED_TYPES.has(newDestinationType)
            ? readFormValue("new_destination_target")
            : "";
        const targetWord =
          bindingTypeForReview === "mongodb"
            ? "collection"
            : bindingTypeForReview === "databricks_volume"
            ? "volume"
            : bindingTypeForReview === "databricks_sql"
            ? "Delta table"
            : bindingTypeForReview === "bigquery"
            ? "BigQuery dataset.table"
            : "table";
        // For an existing-destination pick, the binding the operator chose is
        // serialized into `binding:${id}` as JSON; pull the target out so the
        // review can show what events will land into.
        const existingBindingTarget = (() => {
          if (destinationMode !== "existing" || !pickedExistingDestId) return "";
          const raw = readFormValue(`binding:${pickedExistingDestId}`);
          if (!raw) return "";
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (
              bindingTypeForReview === "bigquery" &&
              typeof parsed.dataset === "string" &&
              typeof parsed.table === "string"
            ) {
              return `${parsed.dataset}.${parsed.table}`;
            }
            const candidate =
              parsed.table ?? parsed.collection ?? parsed.volume ?? parsed.key_prefix;
            return typeof candidate === "string" ? candidate : "";
          } catch {
            return "";
          }
        })();
        // Webhook provider summary for the review — show whether HMAC
        // verification is enabled (provider + secret) or token-only.
        const reviewProvider = readFormValue("inbound_provider");
        const reviewSecretEntered = Boolean(readFormValue("inbound_signing_secret"));
        const providerSummary = (() => {
          if (!reviewProvider || reviewProvider === "custom") {
            return "Custom / token auth only, no HMAC verification";
          }
          const headerByProvider: Record<string, string> = {
            stripe: "Stripe-Signature",
            github: "X-Hub-Signature-256",
            shopify: "X-Shopify-Hmac-Sha256",
            chargebee: "HTTP Basic Auth",
          };
          const header = headerByProvider[reviewProvider] ?? reviewProvider;
          const labels: Record<string, string> = {
            stripe: "Stripe",
            github: "GitHub",
            shopify: "Shopify",
            chargebee: "Chargebee",
          };
          const providerLabel = labels[reviewProvider] ?? reviewProvider;
          return `${providerLabel} · ${header} · ${reviewSecretEntered ? "verification enabled" : "secret not yet entered"}`;
        })();
        return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium text-foreground">Review</p>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          <li className="flex items-start justify-between gap-2">
            <span>
              <strong className="text-foreground">Source:</strong> {sourceValue}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-0.5 text-xs"
              onClick={() => onEditStep(1)}
            >
              Edit
            </Button>
          </li>
          <li className="flex items-start justify-between gap-2">
            <span>
              <strong className="text-foreground">Destination:</strong> {destValue}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-0.5 text-xs"
              onClick={() => onEditStep(2)}
            >
              Edit
            </Button>
          </li>
          {(targetValue || existingBindingTarget) ? (
            <li>
              <strong className="text-foreground">Target {targetWord}:</strong>{" "}
              {targetValue || existingBindingTarget}
              {bindingTypeForReview === "databricks_volume" && targetValue ? (
                <span className="ml-1 font-mono text-muted-foreground">
                  (path: /Volumes/{readFormValue("dest_field_catalog") || "…"}/
                  {readFormValue("dest_field_schema_name") || "…"}/{targetValue}/)
                </span>
              ) : null}
            </li>
          ) : null}
          {providerSummary ? (
            <li>
              <strong className="text-foreground">Provider:</strong> {providerSummary}
            </li>
          ) : null}
          <li>
            <strong className="text-foreground">Route:</strong>{" "}
            {destinationMode === "skip"
              ? "not created"
              : "created automatically; events flow source → destination"}
          </li>
        </ul>
      </div>
        );
      })()}

      <p className="text-xs text-muted-foreground">
        You can add a filter or transform on the Routes tab after this source is created — the
        declarative builder there compiles to the same DSL the edge router runs.
      </p>
    </>
  );
}
