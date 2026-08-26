import * as Sentry from "@sentry/nextjs";
import { bootstrapAnalytics } from "./lib/consent";
import { filterDashboardSentryEvent } from "./lib/sentry-event-filter";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  // ROL-307 is an error/source-map integration. Keep performance sampling off
  // until a separate budget and retention decision enables it intentionally.
  tracesSampleRate: 0,
  sendDefaultPii: false,
  initialScope: { tags: { service: "dashboard" } },
  beforeSend: filterDashboardSentryEvent,
});

// Required by the Next.js SDK even when tracing is sampled at zero; exporting
// the hook keeps navigation context available on any captured browser error.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

/**
 * Client bootstrap. Next.js runs `instrumentation-client.ts` once on the client
 * before hydration.
 *
 * PostHog is NO LONGER initialised unconditionally here. To comply with EU/UK
 * ePrivacy cookie-consent rules, analytics only starts after the user consents
 * (EEA/UK/CH) or, outside those regions, under legitimate interest.
 * `bootstrapAnalytics()` starts it immediately for returning consented users;
 * the `CookieConsent` banner handles everyone still undecided.
 *
 * See https://posthog.com/docs/privacy/gdpr-compliance and `lib/consent.ts`.
 */
bootstrapAnalytics();
