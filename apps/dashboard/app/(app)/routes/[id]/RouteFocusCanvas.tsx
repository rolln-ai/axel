/**
 * Legacy module. The old static SVG `RouteFocusCanvas` has been replaced
 * by the interactive `RoutePipelineCanvas`. This file is kept only for
 * the legend (still rendered under the canvas) and the public-facing
 * `FocusSource` / `FocusDestination` types that the route detail page
 * passes into the canvas component.
 *
 * Once those types find a more natural home, this file can go away.
 */

export interface FocusSource {
  id: string;
  name: string;
  status: "active" | "disabled";
}

export interface FocusDestination {
  id: string;
  name: string;
  type: string;
  status: "active" | "disabled";
  /** 24h delivery counts for this (route, destination). */
  success: number;
  retry: number;
  dead: number;
}

const EDGE_COLOR = {
  delivered: "#16a34a",
  retrying: "#ca8a04",
  dead: "#dc2626",
  idle: "#9ca3af",
} as const;

export function FocusLegend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <LegendItem color={EDGE_COLOR.delivered} label="success" />
      <LegendItem color={EDGE_COLOR.retrying} label="failure (retry)" />
      <LegendItem color={EDGE_COLOR.dead} label="failure" />
      <LegendItem color={EDGE_COLOR.idle} label="idle (24h) / no sample loaded" />
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className="block size-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
