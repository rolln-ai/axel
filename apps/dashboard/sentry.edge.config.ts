import * as Sentry from "@sentry/nextjs";
import { filterDashboardSentryEvent } from "./lib/sentry-event-filter";
import { resolveDashboardSentryDsn } from "./lib/sentry-runtime-config";

const dsn = resolveDashboardSentryDsn({
  SENTRY_DSN: process.env.SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV,
  release: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0,
  sendDefaultPii: false,
  initialScope: { tags: { service: "dashboard" } },
  beforeSend: filterDashboardSentryEvent,
});
