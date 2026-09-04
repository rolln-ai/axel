import * as Sentry from "@sentry/nextjs";
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
