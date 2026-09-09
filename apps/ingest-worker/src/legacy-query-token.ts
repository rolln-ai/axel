const MAX_WINDOW_MS = 72 * 60 * 60 * 1_000;

/** A short, per-source migration window. Unset or malformed config fails closed. */
export function allowsLegacyQueryToken(raw: string | undefined, sourceId: string, now = Date.now()): boolean {
  if (!raw || raw.length > 32_768) return false;
  try {
    const policies: unknown = JSON.parse(raw);
    if (!policies || typeof policies !== "object" || Array.isArray(policies)) return false;
    if (!Object.hasOwn(policies, sourceId)) return false;
    const policy = (policies as Record<string, unknown>)[sourceId];
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
    const { starts_at, expires_at } = policy as Record<string, unknown>;
    if (typeof starts_at !== "string" || typeof expires_at !== "string") return false;
    const start = Date.parse(starts_at);
    const end = Date.parse(expires_at);
    return Number.isFinite(start) && Number.isFinite(end)
      && end > start && end - start <= MAX_WINDOW_MS
      && start <= now && now < end;
  } catch {
    return false;
  }
}
