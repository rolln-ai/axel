"use client";

import { LocalTime } from "../../_components/LocalTime";
import {
  QuickViewMeta,
  QuickViewMetaItem,
  QuickViewTrigger,
} from "../../_components/QuickView";
import { EntityStatusBadge } from "../../_components/StatusBadges";
import { schemaFor, type DestinationType } from "../../../lib/destination-defaults";

/**
 * Per-row "Quick view" trigger. Clicking this pushes a side panel with the
 * destination's config summary and links into the full detail page for
 * deeper inspection. The full /destinations/[id] route stays the canonical
 * source — this is the fast-glance shortcut so a workspace operator can
 * eyeball a destination from the list without losing their place.
 *
 * Why a client component (and not a `<details>` accordion):
 *   - Gives us the full multi-panel modal pattern (focus trap, ESC handling,
 *     keyboard shortcuts) for free via PanelStack.
 *   - The data we render is already on the page (the parent server
 *     component fetched it), so this is purely a UI affordance — no extra
 *     network round-trip.
 */
export interface DestinationQuickViewRow {
  id: string;
  name: string | null;
  type: DestinationType;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  fingerprint_last4: string | null;
  fingerprint_sha256_prefix: string | null;
  routes_attached: number;
  created_at: string;
}

export function DestinationQuickView({
  destination,
}: {
  destination: DestinationQuickViewRow;
}) {
  return (
    <QuickViewTrigger
      idPrefix="dest"
      entityId={destination.id}
      eyebrow="Destination"
      title={destination.name ?? destination.id}
      href={`/destinations/${destination.id}`}
    >
      <DestinationPanelBody destination={destination} />
    </QuickViewTrigger>
  );
}

function DestinationPanelBody({ destination }: { destination: DestinationQuickViewRow }) {
  const schema = schemaFor(destination.type);
  const configFields = schema.fields.filter((f) => f.kind === "config");

  return (
    <div className="flex flex-col gap-5">
      <QuickViewMeta>
        <QuickViewMetaItem label="Status">
          <EntityStatusBadge status={destination.status} className="capitalize" />
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Type" className="flex items-center gap-2">
          <code className="rounded-sm bg-muted px-1 font-mono text-xs">{destination.type}</code>
          <small className="text-muted-foreground">{schema.label}</small>
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Destination ID">
          <code className="font-mono text-xs">{destination.id}</code>
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Routes attached" className="text-sm">
          {destination.routes_attached}
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Created" className="text-sm text-muted-foreground">
          <LocalTime value={destination.created_at} />
        </QuickViewMetaItem>
      </QuickViewMeta>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">Configuration</h3>
        <QuickViewMeta>
          {configFields.map((field) => {
            const value = destination.config[field.key];
            if (value === undefined || value === null || value === "") return null;
            return (
              <div key={field.key} className="contents">
                <QuickViewMetaItem label={field.label}>
                  <code className="break-all font-mono text-xs">{String(value)}</code>
                </QuickViewMetaItem>
              </div>
            );
          })}
          {destination.fingerprint_last4 ? (
            <div className="contents">
              <QuickViewMetaItem label="Credential">
                <code className="font-mono text-xs">
                  •••{destination.fingerprint_last4}{" "}
                  <small className="text-muted-foreground">
                    {destination.fingerprint_sha256_prefix}
                  </small>
                </code>
              </QuickViewMetaItem>
            </div>
          ) : null}
        </QuickViewMeta>
      </div>

      {destination.type === "webhook" ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Signed webhook.</strong>{" "}
          Receivers verify{" "}
          <code className="font-mono">HMAC-SHA256(secret, &quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)</code>{" "}
          against the <code className="font-mono">X-Axel-Signature</code> header. Reject any request
          where <code className="font-mono">|now − timestamp|</code> exceeds 5 minutes.
        </div>
      ) : null}
    </div>
  );
}
