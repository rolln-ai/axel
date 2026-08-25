import type { DeliveryStreamRow } from "../app/(app)/deliveries/DeliveryStreamTable";

export interface DeliveryFilters {
  status: "all" | "success" | "retry" | "failed";
  source: string;
  destination: string;
  q: string;
}

export type DeliveryAttemptQueryStatus = "success" | "retry" | "dead";

/**
 * Map the deliveries page's public status filter onto the ClickHouse
 * `delivery_attempts.status` column. The UI says "failed"; the log stores
 * terminal failures as `dead`. `all` means no predicate (mixed latest N).
 */
export function clickhouseStatusForFilter(
  status: DeliveryFilters["status"],
): DeliveryAttemptQueryStatus | null {
  if (status === "all") return null;
  if (status === "failed") return "dead";
  return status;
}

/**
 * Stamp `status=failed` onto a deliveries path so email / inbox CTAs land on
 * the failed stream rather than the mixed log. Preserves a workspace-handoff
 * prefix (`/workspaces/:id/deliveries`) and any other query params.
 */
export function failedDeliveriesPath(linkPath: string | null | undefined): string {
  const raw = linkPath && linkPath.length > 0 ? linkPath : "/deliveries";
  try {
    const url = new URL(raw, "https://app.axelapp.ai");
    if (url.pathname === "/deliveries" || url.pathname.endsWith("/deliveries")) {
      url.searchParams.set("status", "failed");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/deliveries?status=failed";
  }
}

/** Resolve a stored notification CTA, rewriting legacy unfiltered replay links. */
export function notificationLinkPath(
  kind: string,
  title: string,
  linkPath: string | null,
): string | null {
  if (kind === "replay_job_complete" && /\bstill failing\b/i.test(title)) {
    return failedDeliveriesPath(linkPath);
  }
  return linkPath;
}

export function parseDeliveryFilters(
  searchParams: Record<string, string | string[] | undefined>,
): DeliveryFilters {
  const status = firstValue(searchParams.status);
  return {
    status:
      status === "success" || status === "retry" || status === "failed" || status === "dead"
        ? status === "dead"
          ? "failed"
          : status
        : "all",
    source: normalizeSelectFilter(firstValue(searchParams.source)),
    destination: normalizeSelectFilter(firstValue(searchParams.destination)),
    q: (firstValue(searchParams.q) ?? "").trim(),
  };
}

export function filterDeliveryRows(
  rows: DeliveryStreamRow[],
  filters: DeliveryFilters,
): DeliveryStreamRow[] {
  const q = filters.q.toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== "all") {
      if (filters.status === "failed" && row.status !== "dead") return false;
      if (filters.status !== "failed" && row.status !== filters.status) return false;
    }
    if (filters.source && row.source_id !== filters.source) return false;
    if (filters.destination && row.destination_id !== filters.destination) return false;
    if (q && !rowSearchText(row).includes(q)) return false;
    return true;
  });
}

export function countActiveDeliveryFilters(filters: DeliveryFilters): number {
  return [
    filters.status !== "all",
    Boolean(filters.source),
    Boolean(filters.destination),
    Boolean(filters.q),
  ].filter(Boolean).length;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeSelectFilter(value: string | undefined): string {
  if (!value || value === "all") return "";
  return value.trim();
}

function rowSearchText(row: DeliveryStreamRow): string {
  return [
    row.event_id,
    row.source_id,
    row.route_id,
    row.destination_id,
    row.status,
    row.dead_letter?.reason,
    row.dead_letter?.message,
    row.dead_letter?.replay?.state,
    row.response.http_status,
    row.response.error,
    row.response.destination_type,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}
