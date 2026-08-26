export const DEFAULT_WORKSPACE_TIMEZONE = "UTC";

const PRIMARY_TIMEZONES = [
  DEFAULT_WORKSPACE_TIMEZONE,
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

function supportedTimeZones(): string[] {
  const intlWithValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  return intlWithValues.supportedValuesOf?.("timeZone") ?? [];
}

function timezoneLabel(value: string): string {
  if (value === DEFAULT_WORKSPACE_TIMEZONE) return "UTC";
  const city = value.split("/").at(-1)?.replace(/_/g, " ") ?? value;
  const region = value.split("/")[0];
  return region ? `${city} (${region})` : city;
}

const allTimezones = Array.from(new Set([...PRIMARY_TIMEZONES, ...supportedTimeZones()]));

export const WORKSPACE_TIMEZONE_OPTIONS = allTimezones.map((value) => ({
  value,
  label: timezoneLabel(value),
}));

const WORKSPACE_TIMEZONE_VALUES = new Set<string>(
  WORKSPACE_TIMEZONE_OPTIONS.map((option) => option.value),
);

export function isSupportedWorkspaceTimezone(value: string): boolean {
  return WORKSPACE_TIMEZONE_VALUES.has(value);
}

/**
 * Map an arbitrary IANA zone onto one of the picker's options, or null if it
 * isn't a zone this runtime knows.
 *
 * Browsers and IANA renames disagree with our option list: Chrome reports
 * `Asia/Kolkata` and `Europe/Kyiv`, while `Intl.supportedValuesOf` here lists
 * the backward-compatible `Asia/Calcutta` / `Europe/Kiev`. A plain set lookup
 * would reject those and silently fall back to UTC, so run the value through
 * `resolvedOptions()` first — that collapses every alias (including `US/Pacific`
 * → `America/Los_Angeles`) onto the runtime's canonical name.
 */
export function resolveWorkspaceTimezone(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isSupportedWorkspaceTimezone(value)) return value;
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    return isSupportedWorkspaceTimezone(canonical) ? canonical : null;
  } catch {
    // Not a valid IANA zone name.
    return null;
  }
}

export function normalizeWorkspaceTimezone(value: string | null | undefined): string {
  return resolveWorkspaceTimezone(value) ?? DEFAULT_WORKSPACE_TIMEZONE;
}

export function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeWorkspaceTimezone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
}

export function addDaysToDateKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return dayKey;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
