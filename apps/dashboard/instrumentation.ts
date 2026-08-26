import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// The SDK owns framework-level errors. Explicit cron check-ins and operational
// captures continue to use @axel/observability in their existing call sites.
export const onRequestError = Sentry.captureRequestError;
