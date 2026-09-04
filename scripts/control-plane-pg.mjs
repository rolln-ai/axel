const NO_VERIFY_MODES = new Set(["no-verify", "no_verify"]);

function sslMode(connectionString) {
  try {
    return new URL(connectionString).searchParams.get("sslmode")?.toLowerCase() ?? null;
  } catch {
    const captured = connectionString.match(/[?&]sslmode=([^&\s]+)/i)?.[1];
    return captured ? decodeURIComponent(captured).toLowerCase() : null;
  }
}

function loopback(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname);
  } catch {
    return /(@|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(connectionString);
  }
}

/**
 * Mirror packages/shared's control-plane TLS policy for standalone Node CLIs.
 * Remote connections are always encrypted. Certificate verification remains an
 * explicit rollout flag until the managed provider's CA chain is validated.
 */
export function controlPlanePgSslOption(connectionString, verifyFlag) {
  const mode = sslMode(connectionString);
  if (mode === "disable" || loopback(connectionString)) return false;
  if (mode && NO_VERIFY_MODES.has(mode)) return { rejectUnauthorized: false };
  if (mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: verifyFlag === "true" };
}
