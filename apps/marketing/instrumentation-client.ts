import { bootstrapAnalytics } from "./lib/consent";

/**
 * Client bootstrap. Next.js runs `instrumentation-client.ts` once on the client
 * before hydration.
 *
 * PostHog is NO LONGER initialised unconditionally here. To comply with EU/UK
 * ePrivacy cookie-consent rules, analytics only starts after the visitor
 * consents (EEA/UK/CH) or, outside those regions, under legitimate interest.
 * `bootstrapAnalytics()` starts it immediately for returning consented visitors;
 * the `CookieConsent` banner handles everyone still undecided.
 *
 * See https://posthog.com/docs/privacy/gdpr-compliance and `lib/consent.ts`.
 */
bootstrapAnalytics();
