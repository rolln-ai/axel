"use client";

/**
 * React Flow custom-node components for the route pipeline canvas.
 *
 * Each renders a self-contained card with a status dot, an eyebrow
 * label, and a small subtitle — visual continuity with the legacy
 * RouteFocusCanvas SVG. The data passed in is the engine's PipelineNode
 * + a per-node "live state" derived from the most recent sample run.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

type Health = "idle" | "ok" | "filtered" | "error" | "warning";

const HEALTH_COLORS: Record<Health, string> = {
  idle: "#9ca3af",
  ok: "#16a34a",
  filtered: "#ca8a04",
  error: "#dc2626",
  warning: "#ea580c",
};

export interface CanvasNodeRuntime {
  /** "ok" — payload reached this node; "filtered" — filter rejected here
   *  or branch was pruned upstream; "error" — engine threw; "idle" — no
   *  sample loaded. */
  health: Health;
  detail?: string;
  selected?: boolean;
}

export interface SourceData extends CanvasNodeRuntime, Record<string, unknown> {
  kind: "source";
  name: string;
  sourceId: string;
  statusOk: boolean;
}

export interface FilterData extends CanvasNodeRuntime, Record<string, unknown> {
  kind: "filter";
  summary: string;
}

export interface TransformData extends CanvasNodeRuntime, Record<string, unknown> {
  kind: "transform";
  summary: string;
}

export interface DestinationData extends CanvasNodeRuntime, Record<string, unknown> {
  kind: "destination";
  name: string;
  type: string;
  statusOk: boolean;
}

const Card = ({
  eyebrow,
  title,
  subtitle,
  health,
  detail,
  showInHandle,
  showOutHandle,
  statusDot,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  health: Health;
  detail?: string;
  showInHandle: boolean;
  showOutHandle: boolean;
  statusDot: "ok" | "off" | Health;
}) => {
  const dotColor =
    statusDot === "ok"
      ? HEALTH_COLORS.ok
      : statusDot === "off"
        ? HEALTH_COLORS.idle
        : HEALTH_COLORS[statusDot];

  return (
    <div
      className="relative w-[220px] rounded-lg border bg-card px-3 py-2.5 shadow-sm transition-all"
      style={{
        borderColor:
          health === "ok"
            ? "#16a34a55"
            : health === "filtered"
              ? "#ca8a0455"
              : health === "error"
                ? "#dc262655"
                : "#d4d4d4",
        boxShadow: health === "error" ? "0 0 0 1px #dc2626 inset" : undefined,
      }}
    >
      {showInHandle ? (
        <Handle
          type="target"
          position={Position.Left}
          style={{ width: 8, height: 8, background: "#9ca3af" }}
        />
      ) : null}
      {showOutHandle ? (
        <Handle
          type="source"
          position={Position.Right}
          style={{ width: 8, height: 8, background: "#9ca3af" }}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <span
          className="block size-2.5 rounded-full"
          style={{ background: dotColor }}
        />
        <small className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {eyebrow}
        </small>
      </div>
      <div className="mt-1 text-sm font-medium text-foreground" title={title}>
        {truncate(title, 26)}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={subtitle}>
        {truncate(subtitle, 30)}
      </div>
      {detail ? (
        <div
          className="mt-1 text-[10px]"
          style={{ color: HEALTH_COLORS[health] }}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
};

export function SourceNode({ data }: NodeProps<Node<SourceData>>) {
  const d = data;
  return (
    <Card
      eyebrow="SOURCE"
      title={d.name}
      subtitle={d.sourceId}
      health={d.health}
      detail={d.detail}
      showInHandle={false}
      showOutHandle
      statusDot={d.statusOk ? "ok" : "off"}
    />
  );
}

export function FilterNode({ data }: NodeProps<Node<FilterData>>) {
  const d = data;
  return (
    <Card
      eyebrow="FILTER ƒ"
      title={d.summary}
      subtitle="declarative"
      health={d.health}
      detail={d.detail}
      showInHandle
      showOutHandle
      statusDot={d.health}
    />
  );
}

export function TransformNode({ data }: NodeProps<Node<TransformData>>) {
  const d = data;
  return (
    <Card
      eyebrow="TRANSFORM ↻"
      title={d.summary}
      subtitle="declarative"
      health={d.health}
      detail={d.detail}
      showInHandle
      showOutHandle
      statusDot={d.health}
    />
  );
}

export function DestinationNode({ data }: NodeProps<Node<DestinationData>>) {
  const d = data;
  return (
    <Card
      eyebrow="DESTINATION"
      title={d.name}
      subtitle={d.type}
      health={d.health}
      detail={d.detail}
      showInHandle
      showOutHandle={false}
      statusDot={d.statusOk ? "ok" : "off"}
    />
  );
}

export const NODE_TYPES = {
  source: SourceNode,
  filter: FilterNode,
  transform: TransformNode,
  destination: DestinationNode,
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}
