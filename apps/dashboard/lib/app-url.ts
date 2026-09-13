/**
 * Canonical dashboard origin for email links, billing redirects, and
 * outbound API referer headers.
 *
 * Self-hosted images take AXEL_APP_URL at runtime. Cloud builds retain the
 * public build setting, with the production origin as their default.
 */
export function appBaseUrl(): string {
  return (process.env.AXEL_APP_URL ?? process.env.NEXT_PUBLIC_AXEL_APP_URL ?? "https://app.axelapp.ai").replace(/\/$/, "");
}
