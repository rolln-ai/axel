/** Minimal header accessor satisfied by both next/headers' Headers and NextRequest.headers. */
interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Client IP for rate limiting. x-forwarded-for is a comma-separated chain;
 * the LEFT-most entry is the original client (Vercel/Render both prepend the
 * real client IP ahead of their own hops). Falls back to x-real-ip.
 *
 * Shared by server actions (via next/headers) and the /api/v1 router (via
 * NextRequest.headers) so the two paths can't drift.
 */
export function requestIpFromHeaders(h: HeaderReader): string | null {
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return h.get("x-real-ip");
}
