/**
 * Canonical dashboard origin for email links, billing redirects, and
 * outbound API referer headers.
 *
 * ONE fallback chain everywhere: NEXT_PUBLIC_AXEL_APP_URL → the production
 * origin. Call sites used to disagree (localhost:3000 vs app.axelapp.ai vs
 * request-origin), which meant an unset env var produced localhost links in
 * production emails from some paths but not others.
 */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_AXEL_APP_URL ?? "https://app.axelapp.ai").replace(/\/$/, "");
}
