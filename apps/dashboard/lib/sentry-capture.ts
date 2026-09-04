import "server-only";
import * as Sentry from "@sentry/nextjs";
import { sanitizeTelemetryValue } from "./telemetry-sanitization";

const FLUSH_TIMEOUT_MS = 2_000;
const REDACTED = "[REDACTED]";
const BUSINESS_IDENTIFIER_KEYS = new Set([
  "attemptid",
  "credentialid",
  "customerid",
  "destinationid",
  "eventid",
  "replayid",
  "routeid",
  "sourceid",
  "userid",
  "workspaceid",
]);

export interface DashboardExceptionContext {
  level?: "error" | "fatal" | "warning" | "info";
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
  user?: {
    id?: string;
    username?: string;
    email?: string;
    ip_address?: string;
  };
}

function sanitizeSentryScopeRecord<T extends Record<string, unknown>>(value: T): T {
  const sanitized = sanitizeTelemetryValue(value);

  function redactIdentifiers(current: unknown, depth = 0): void {
    if (!current || typeof current !== "object" || depth > 12) return;
    if (Array.isArray(current)) {
      for (const item of current) redactIdentifiers(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (BUSINESS_IDENTIFIER_KEYS.has(normalized)) {
        (current as Record<string, unknown>)[key] = REDACTED;
      } else {
        redactIdentifiers(child, depth + 1);
      }
    }
  }

  redactIdentifiers(sanitized);
  return sanitized;
}

/**
 * Strict local variant used by the authenticated production smoke probe.
 * Resolves with the SDK event ID only after the local SDK queue flushes. The
 * deployment verifier must read that event back from Sentry before treating
 * ingestion and source-map symbolication as successful.
 */
export async function captureDashboardExceptionAndFlush(
  error: unknown,
  context: DashboardExceptionContext = {},
): Promise<string> {
  if (!Sentry.isEnabled()) {
    throw new Error("Sentry dashboard SDK is not enabled");
  }

  let eventId = "";
  Sentry.withScope((scope) => {
    if (context.level) scope.setLevel(context.level);
    if (context.tags) scope.setTags(sanitizeSentryScopeRecord(context.tags));
    if (context.extra) scope.setExtras(sanitizeSentryScopeRecord(context.extra));
    // User context is identity-only and is not needed for operational triage.
    // Omit it at capture time in addition to the SDK beforeSend boundary.
    eventId = Sentry.captureException(error);
  });

  const flushed = await Sentry.flush(FLUSH_TIMEOUT_MS);
  if (!flushed) {
    throw new Error(`Sentry dashboard event ${eventId || "unknown"} did not flush`);
  }
  return eventId;
}

/**
 * Capture a handled dashboard exception through the official Next.js SDK.
 *
 * These errors are converted into HTTP responses by their callers, so
 * `onRequestError` never sees them. Using the SDK here preserves its release
 * and debug-ID metadata, allowing uploaded server source maps to symbolicate
 * the event. Capture and flush failures remain best-effort and must never turn
 * an otherwise handled application error into a second failure.
 */
export async function captureDashboardException(
  error: unknown,
  context: DashboardExceptionContext = {},
): Promise<void> {
  if (!Sentry.isEnabled()) return;

  try {
    await captureDashboardExceptionAndFlush(error, context);
  } catch {
    console.error("[sentry] dashboard capture failed");
  }
}
