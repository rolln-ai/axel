import posthog from "posthog-js";

/**
 * Cookie-consent plumbing for the dashboard.
 *
 * PostHog is a NON-essential analytics cookie. Under the EU ePrivacy Directive
 * / GDPR and the UK PECR it may only be set after prior consent. Outside those
 * regions we rely on legitimate interest (see the Cookie Policy, Section 5).
 *
 * `proxy.ts` (the Next.js 16 middleware file) stamps `axel_consent_required`
 * from edge geo; this module reads it plus the visitor's stored decision and
 * starts/stops PostHog accordingly. Nothing here runs (no cookies, no network)
 * until the visitor has consented, or unless they are outside a
 * consent-required region.
 */

/** Edge-set: "1" = consent required (EEA/UK/CH or unknown), "0" = not required. */
const CONSENT_REQUIRED_COOKIE = "axel_consent_required";
/** The visitor's stored choice. */
const CONSENT_DECISION_COOKIE = "axel_cookie_consent";
/** Window event the "Cookie preferences" control dispatches to reopen the banner. */
export const CONSENT_PREFERENCES_EVENT = "axel:cookie-preferences";

type ConsentDecision = "granted" | "denied";

const ONE_YEAR = 60 * 60 * 24 * 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

export function writeConsent(decision: ConsentDecision): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API lacks broad browser support; plain cookie write is intentional
  document.cookie = `${CONSENT_DECISION_COOKIE}=${decision}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

let started = false;

/**
 * Initialise PostHog once and start capturing. Call only after consent, or for
 * legitimate-interest (non consent-required) regions. No-op without a key.
 */
export function enableAnalytics(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  if (!started) {
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-01-30",
      // Start opted-out so a stray re-init can never capture before opt_in.
      opt_out_capturing_by_default: true,
    });
    started = true;
  }
  posthog.opt_in_capturing();
}

/** Stop capturing and clear PostHog's cookies/storage. No-op if it never started. */
export function disableAnalytics(): void {
  if (started) posthog.opt_out_capturing();
}

/**
 * Decide initial analytics state from cookies. Runs pre-hydration via
 * `instrumentation-client.ts`, so returning consented users start analytics
 * immediately rather than waiting for React to mount.
 */
export function bootstrapAnalytics(): void {
  const decision = readCookie(CONSENT_DECISION_COOKIE);
  if (decision === "granted") {
    enableAnalytics();
    return;
  }
  if (decision === "denied") return;
  if (readCookie(CONSENT_REQUIRED_COOKIE) === "0") enableAnalytics();
}

/** True when we must ask: consent required and no decision recorded yet. */
export function consentDecisionPending(): boolean {
  if (readCookie(CONSENT_DECISION_COOKIE)) return false;
  return readCookie(CONSENT_REQUIRED_COOKIE) !== "0";
}
