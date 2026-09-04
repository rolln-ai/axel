import { isTransientPostgresError } from "@axel/observability";

interface SentryEventHint {
  originalException?: unknown;
}

interface SentryEventWithMechanism {
  breadcrumbs?: Array<{
    data?: Record<string, unknown>;
    message?: string;
    [key: string]: unknown;
  }>;
  contexts?: {
    browser?: {
      browser?: string;
      name?: string;
    };
  };
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { handled?: boolean };
      stacktrace?: {
        frames?: Array<Record<string, unknown> & {
          filename?: string;
          function?: string;
        }>;
      };
    }>;
  };
  request?: {
    headers?: Record<string, unknown>;
    query_string?: unknown;
    url?: string;
    [key: string]: unknown;
  };
  tags?: Record<string, unknown>;
  transaction?: string;
  user?: unknown;
  [key: string]: unknown;
}

const SAFE_EXCEPTION_TYPES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const SAFE_TAG_KEYS = new Set([
  "category",
  "component",
  "error_code",
  "http_status",
  "kind",
  "phase",
  "service",
  "status",
  "unhandled",
]);

/** Enforce a value-free boundary immediately before an event can leave. */
export function scrubDashboardSentryEvent(event: SentryEventWithMechanism): void {
  delete event.user;
  delete event.request;
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.transaction;
  delete event.extra;
  delete event.fingerprint;

  if ("message" in event) event.message = "dashboard_message";

  const safeTags: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (!SAFE_TAG_KEYS.has(key)) continue;
    if (typeof value === "string") {
      safeTags[key] = safeSlug(value);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) safeTags[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      safeTags[key] = value;
    }
  }
  if (Object.keys(safeTags).length > 0) event.tags = safeTags;
  else delete event.tags;

  for (const value of event.exception?.values ?? []) {
    value.type = SAFE_EXCEPTION_TYPES.has(value.type ?? "") ? value.type : "Error";
    value.value = "dashboard_error";
    const handled = value.mechanism?.handled;
    value.mechanism = typeof handled === "boolean" ? { handled } : undefined;
    const frames = value.stacktrace?.frames;
    if (!frames) continue;
    value.stacktrace = {
      frames: frames.slice(0, 100).map(safeStackFrame),
    };
  }
}

function safeSlug(value: string): string {
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9_.:-]{0,95}$/iu.test(trimmed) ? trimmed : "redacted";
}

function safeStackFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    filename: safeStackFilename(typeof frame.filename === "string" ? frame.filename : ""),
    function: "<anonymous>",
  };
  if (typeof frame.lineno === "number" && Number.isFinite(frame.lineno)) {
    safe.lineno = frame.lineno;
  }
  if (typeof frame.colno === "number" && Number.isFinite(frame.colno)) {
    safe.colno = frame.colno;
  }
  if (typeof frame.in_app === "boolean") safe.in_app = frame.in_app;
  return safe;
}

function safeStackFilename(value: string): string {
  let candidate = value;
  try {
    candidate = new URL(value).pathname;
  } catch {
    // Relative and runtime-owned paths are handled below.
  }
  candidate = candidate.split("?")[0]?.split("#")[0] ?? "";
  for (const root of ["/_next/", "/apps/", "/packages/"] as const) {
    const index = candidate.lastIndexOf(root);
    if (index >= 0) return candidate.slice(index, index + 240);
  }
  if (/^node:[a-z0-9_./-]{1,160}$/iu.test(candidate)) return candidate;
  return "[external]";
}

function isAndroidWebViewPerfInjectionError(event: SentryEventWithMechanism): boolean {
  const browser = event.contexts?.browser;
  const browserName = browser?.name ?? browser?.browser ?? "";
  if (browserName !== "TikTok" && browserName !== "Chrome Mobile WebView") {
    return false;
  }

  return Boolean(
    event.exception?.values?.some(
      (value) =>
        value.type === "TypeError" &&
        value.value ===
          "Cannot read properties of undefined (reading 'domInteractive')" &&
        value.stacktrace?.frames?.some(
          (frame) =>
            frame.filename === "<anonymous>" &&
            /(^|\.)checkPerfReady$/.test(frame.function ?? ""),
        ),
    ),
  );
}

function isFacebookNavigationPerfInjectionError(
  event: SentryEventWithMechanism,
): boolean {
  const browser = event.contexts?.browser;
  const isFacebook =
    browser?.name === "Facebook" ||
    browser?.browser === "Facebook" ||
    browser?.browser?.startsWith("Facebook ") === true;
  if (!isFacebook) return false;

  return Boolean(
    event.exception?.values?.some((value) => {
      if (
        value.type !== "Error" ||
        value.value !== "Error invoking postMessage: Java object is gone" ||
        value.mechanism?.handled !== false
      ) {
        return false;
      }

      const injectedFunctions = new Set(
        value.stacktrace?.frames
          ?.filter(
            (frame) =>
              frame.filename === "app://navigation_performance_logger_android",
          )
          .map((frame) => frame.function),
      );
      return (
        injectedFunctions.has("sendDataToNative") &&
        injectedFunctions.has("sendJsBlockingTimeMessage")
      );
    }),
  );
}

function isHandledDeploymentSkewError(event: SentryEventWithMechanism): boolean {
  return Boolean(
    event.exception?.values?.some(
      (value) =>
        value.mechanism?.handled === true &&
        (value.type === "UnrecognizedActionError" ||
          /Server Action ["'][^"']+["'] was not found on the server/i.test(value.value ?? "")),
    ),
  );
}

/**
 * Preserve the old dashboard process-handler suppression when the official
 * SDK captures an uncaught exception or unhandled rejection. The SDK now owns
 * those handlers, so this filter prevents both alert noise and duplicate
 * process listeners while leaving explicit operational captures unchanged.
 */
export function filterDashboardSentryEvent<T>(
  event: T,
  hint: SentryEventHint = {},
): T | null {
  const sentryEvent = event as SentryEventWithMechanism;
  // Classify known SDK noise before text sanitization changes quoted values
  // inside the exception message. Every event is still scrubbed before either
  // returning it or dropping it.
  const androidWebViewInjection = isAndroidWebViewPerfInjectionError(sentryEvent);
  const facebookInjection = isFacebookNavigationPerfInjectionError(sentryEvent);
  const handledDeploymentSkew = isHandledDeploymentSkewError(sentryEvent);
  // Browser SDK request contexts and fetch/navigation breadcrumbs can contain
  // the full current URL. Sanitize before every non-dropped return path while
  // retaining the top-level object identity expected by Sentry.
  scrubDashboardSentryEvent(sentryEvent);
  // ByteDance Android apps inject this anonymous performance script. Sentry
  // identifies the full TikTok client directly but identifies TikTok Lite as
  // a generic Chrome Mobile WebView, so accept both exact browser families.
  // Keep the exception, anonymous source, and injected function checks narrow
  // so a similarly worded exception from dashboard code remains actionable.
  if (androidWebViewInjection) {
    console.warn("[sentry] dropping Android WebView performance injection error");
    return null;
  }

  // Facebook's Android in-app browser owns navigation_performance_logger_android.
  // It can dispatch one final timer after its native Java bridge has been torn
  // down, causing postMessage to throw during navigation. The exact browser,
  // error, script URL, and injected function pair distinguish this from app code.
  if (facebookInjection) {
    console.warn("[sentry] dropping Facebook navigation performance injection error");
    return null;
  }

  // A browser that remains open across a deployment can submit an old,
  // build-specific Server Action id once. Vercel Skew Protection handles the
  // rollout and a refresh self-heals the client, so this handled SDK event is
  // deployment noise rather than an application exception.
  if (handledDeploymentSkew) {
    console.warn("[sentry] dropping handled stale Server Action event");
    return null;
  }

  const hasUnhandledMechanism = Boolean(
    sentryEvent.exception?.values?.some(
      (value) => value.mechanism?.handled === false,
    ),
  );
  if (!hasUnhandledMechanism || !isTransientPostgresError(hint.originalException)) {
    return event;
  }

  console.warn("[sentry] dropping transient pg SDK event");
  return null;
}
