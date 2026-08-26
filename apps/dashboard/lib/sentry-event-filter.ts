import { isTransientPostgresError } from "@axel/observability";

interface SentryEventHint {
  originalException?: unknown;
}

interface SentryEventWithMechanism {
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
        frames?: Array<{
          filename?: string;
          function?: string;
        }>;
      };
    }>;
  };
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
  // ByteDance Android apps inject this anonymous performance script. Sentry
  // identifies the full TikTok client directly but identifies TikTok Lite as
  // a generic Chrome Mobile WebView, so accept both exact browser families.
  // Keep the exception, anonymous source, and injected function checks narrow
  // so a similarly worded exception from dashboard code remains actionable.
  if (isAndroidWebViewPerfInjectionError(sentryEvent)) {
    console.warn("[sentry] dropping Android WebView performance injection error");
    return null;
  }

  // Facebook's Android in-app browser owns navigation_performance_logger_android.
  // It can dispatch one final timer after its native Java bridge has been torn
  // down, causing postMessage to throw during navigation. The exact browser,
  // error, script URL, and injected function pair distinguish this from app code.
  if (isFacebookNavigationPerfInjectionError(sentryEvent)) {
    console.warn("[sentry] dropping Facebook navigation performance injection error");
    return null;
  }

  // A browser that remains open across a deployment can submit an old,
  // build-specific Server Action id once. Vercel Skew Protection handles the
  // rollout and a refresh self-heals the client, so this handled SDK event is
  // deployment noise rather than an application exception.
  if (isHandledDeploymentSkewError(sentryEvent)) {
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

  const error = hint.originalException;
  console.warn(
    "[sentry] dropping transient pg SDK event:",
    error instanceof Error ? error.message : error,
  );
  return null;
}
