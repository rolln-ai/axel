"use client";

import type { SourceProvider } from "@axel/shared";
import { LocalTime } from "../../_components/LocalTime";
import {
  QuickViewMeta,
  QuickViewMetaItem,
  QuickViewTrigger,
} from "../../_components/QuickView";
import { EntityStatusBadge } from "../../_components/StatusBadges";
import {
  sourceAuthenticationCopy,
  sourceAuthHeaderExample,
  sourceUsesAxelToken,
} from "../../../lib/source-ingest-auth";

export interface SourceQuickViewRow {
  id: string;
  name: string;
  status: string;
  max_events_per_minute: number | null;
  created_at: string;
  provider: SourceProvider;
}

export function SourceQuickView({
  source,
  ingestUrl,
}: {
  source: SourceQuickViewRow;
  /** Full ingest endpoint for this source, derived server-side from
   * NEXT_PUBLIC_AXEL_INGEST_URL (same as the source detail page) so
   * staging/self-hosted deployments show a copyable URL that works. */
  ingestUrl: string;
}) {
  return (
    <QuickViewTrigger
      idPrefix="src"
      entityId={source.id}
      eyebrow="Source"
      title={source.name}
      href={`/sources/${source.id}`}
    >
      <SourcePanelBody source={source} ingestUrl={ingestUrl} />
    </QuickViewTrigger>
  );
}

function SourcePanelBody({
  source,
  ingestUrl,
}: {
  source: SourceQuickViewRow;
  ingestUrl: string;
}) {
  const authHeader = sourceAuthHeaderExample(source.provider);

  return (
    <div className="flex flex-col gap-5">
      <QuickViewMeta>
        <QuickViewMetaItem label="Status">
          <EntityStatusBadge status={source.status} className="capitalize" />
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Source ID">
          <code className="font-mono text-xs">{source.id}</code>
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Rate cap">
          {source.max_events_per_minute ? (
            <span>{source.max_events_per_minute}/min</span>
          ) : (
            <span className="text-muted-foreground">workspace default</span>
          )}
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Created" className="text-sm text-muted-foreground">
          <LocalTime value={source.created_at} />
        </QuickViewMetaItem>
      </QuickViewMeta>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Ingest endpoint</h3>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">
{`POST ${ingestUrl}
  ${authHeader}
  content-type: application/json

  { "type": "...", ... }`}
        </pre>
      </div>

      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">How authentication works.</strong>{" "}
        {sourceAuthenticationCopy(source.provider)}
        {sourceUsesAxelToken(source.provider)
          ? " Rotate the token from the source detail page if you suspect exposure. Axel stores its hash, not the plaintext value."
          : " Axel does not use a source token for this named-provider request."}
      </div>
    </div>
  );
}
