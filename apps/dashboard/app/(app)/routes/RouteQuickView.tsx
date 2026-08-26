"use client";

import Link from "next/link";
import { LocalTime } from "../../_components/LocalTime";
import {
  QuickViewMeta,
  QuickViewMetaItem,
  QuickViewTrigger,
} from "../../_components/QuickView";
import { EntityStatusBadge } from "../../_components/StatusBadges";

export interface RouteQuickViewRow {
  id: string;
  name: string | null;
  source_id: string;
  source_name: string;
  status: "active" | "disabled" | "errored";
  has_filter: boolean;
  has_transform: boolean;
  destination_summary: string;
  created_at: string;
}

export function RouteQuickView({ route }: { route: RouteQuickViewRow }) {
  return (
    <QuickViewTrigger
      idPrefix="rt"
      entityId={route.id}
      eyebrow="Pipeline"
      title={route.name ?? route.id}
      href={`/routes/${route.id}`}
    >
      <RoutePanelBody route={route} />
    </QuickViewTrigger>
  );
}

function RoutePanelBody({ route }: { route: RouteQuickViewRow }) {
  return (
    <div className="flex flex-col gap-5">
      <QuickViewMeta>
        <QuickViewMetaItem label="Status">
          <EntityStatusBadge status={route.status} className="capitalize" />
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Source" className="flex items-center gap-1.5">
          <Link
            href={`/sources/${route.source_id}`}
            className="text-sm text-foreground hover:underline"
          >
            {route.source_name}
          </Link>
          <small className="font-mono text-[11px] text-muted-foreground">{route.source_id}</small>
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Destinations">
          <small className="text-xs text-muted-foreground">{route.destination_summary}</small>
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Pipeline ops" className="flex items-center gap-1.5">
          {route.has_filter ? (
            <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">ƒ filter</code>
          ) : null}
          {route.has_transform ? (
            <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">↻ transform</code>
          ) : null}
          {!route.has_filter && !route.has_transform ? (
            <small className="text-xs text-muted-foreground">passthrough</small>
          ) : null}
        </QuickViewMetaItem>
        <QuickViewMetaItem label="Created" className="text-sm text-muted-foreground">
          <LocalTime value={route.created_at} />
        </QuickViewMetaItem>
      </QuickViewMeta>

      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">What this does.</strong> When events arrive at the
        source above, they flow through the optional filter (skipped if false) and transform
        (event payload re-shaped) before fanning out to every destination listed. Each destination
        delivery is tracked independently in the deliveries view.
      </div>
    </div>
  );
}
