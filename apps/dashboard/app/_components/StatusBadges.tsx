import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { NotificationSeverity } from "../../lib/notifications";

/**
 * Shared status → <Badge> variant tables. Single source of truth for the
 * status pills rendered across the dashboard — these mappings were previously
 * duplicated in eight files plus a dozen inline ternaries.
 */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/**
 * Lifecycle status pill for workspace entities (sources, destinations,
 * routes, data-contract maps): active → default, errored/dead/failed →
 * destructive, everything else (disabled, draft, archived, …) → secondary.
 */
export function EntityStatusBadge({
  status,
  className,
  children,
}: {
  status: string;
  className?: string;
  /** Override the rendered text (defaults to the raw status string). */
  children?: ReactNode;
}) {
  const variant: BadgeVariant =
    status === "active" ? "default" :
    status === "dead" || status === "failed" || status === "errored" ? "destructive" :
    "secondary";
  return (
    <Badge variant={variant} className={className}>
      {children ?? status}
    </Badge>
  );
}

/** Replay request lifecycle pill. */
export function ReplayStateBadge({
  state,
  label,
  className,
}: {
  state: "pending" | "in_progress" | "done" | "failed";
  /** Override the rendered text (defaults to the raw state string). */
  label?: string;
  className?: string;
}) {
  const variant: BadgeVariant =
    state === "done" ? "default" :
    state === "failed" ? "destructive" :
    state === "in_progress" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className={className}>
      {label ?? state}
    </Badge>
  );
}

/** Delivery-attempt outcome pill: success / failure (retry) / failure. */
export function DeliveryStatusBadge({
  status,
  className,
}: {
  status: "success" | "retry" | "dead";
  className?: string;
}) {
  const variant: BadgeVariant =
    status === "success" ? "default" :
    status === "retry" ? "secondary" : "destructive";
  const label =
    status === "success" ? "success" :
    status === "retry" ? "failure (retry)" :
    "failure";
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}

/** Notification severity pill (inbox + notifications page). */
export function SeverityBadge({ severity }: { severity: NotificationSeverity }) {
  if (severity === "high") return <Badge variant="destructive">high</Badge>;
  if (severity === "warning") return <Badge variant="default">warning</Badge>;
  return <Badge variant="secondary">info</Badge>;
}
