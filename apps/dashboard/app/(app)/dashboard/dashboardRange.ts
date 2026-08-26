export const RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
] as const;

export type DashboardRange = (typeof RANGES)[number]["value"];

const VALID_RANGES = new Set<string>(RANGES.map((r) => r.value));
export const DEFAULT_RANGE: DashboardRange = "14d";

export function parseDashboardRange(value: string | undefined | null): DashboardRange {
  if (value && VALID_RANGES.has(value)) return value as DashboardRange;
  return DEFAULT_RANGE;
}

export function chartDaysForRange(range: DashboardRange): number {
  switch (range) {
    case "7d":
      return 7;
    case "14d":
      return 14;
    case "30d":
      return 30;
    case "90d":
      return 90;
  }
}
