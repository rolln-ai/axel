export const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

/** Delivery falls back to this same template when key_template is omitted. */
export const DEFAULT_KEY_TEMPLATE = "{date}/{event_id}.json";
export const DEFAULT_PARQUET_KEY_TEMPLATE = "{date}/part-{batch_id}.parquet";

export function includeSavedTarget(targets: string[] | null, savedTarget: string): string[] {
  const liveTargets = targets ?? [];
  if (!savedTarget || liveTargets.includes(savedTarget)) return liveTargets;
  return [savedTarget, ...liveTargets];
}
