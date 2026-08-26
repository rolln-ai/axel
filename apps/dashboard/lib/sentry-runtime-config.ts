interface DashboardSentryEnv {
  SENTRY_DSN?: string;
  NEXT_PUBLIC_SENTRY_DSN?: string;
}

/**
 * Prefer the server-only spelling when present, but reuse the public DSN in
 * preview environments where Vercel intentionally configures only that name.
 * A Sentry DSN identifies the ingestion project; it is not a credential.
 */
export function resolveDashboardSentryDsn(env: DashboardSentryEnv): string | undefined {
  return env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}
