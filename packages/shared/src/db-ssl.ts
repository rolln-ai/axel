/**
 * TLS verification policy for connections to *customer-supplied* Postgres
 * databases (delivery destinations and pull sources).
 *
 * The security default is to verify the server certificate. Encrypting without
 * verifying (`pg`'s `rejectUnauthorized: false` / postgres.js `ssl: "require"`)
 * leaves the connection open to an on-path attacker who presents a forged
 * certificate and captures the customer's database credentials plus the rows we
 * deliver.
 *
 * Two explicit opt-outs are honoured, expressed with a libpq-style `sslmode` in
 * the connection string (or a pull source's `ssl` config field):
 *   - `disable`   → no TLS at all (plaintext); also the default for loopback
 *   - `no-verify` → encrypt but skip verification, for a customer database that
 *                   can only present a self-signed / private-CA certificate
 *
 * Note: plain `sslmode=require` deliberately maps to *verify*, not no-verify.
 * libpq treats `require` as "encrypt, don't check the cert", but that is exactly
 * the MITM-open posture we are closing; a customer who genuinely needs it must
 * say `sslmode=no-verify` (node-postgres's non-libpq extension for this).
 */
export type DbSslDecision = "disable" | "verify" | "no-verify";

const NO_VERIFY_MODES = new Set(["no-verify", "no_verify"]);

function readSslMode(connectionString: string): string | null {
  // Prefer robust URL parsing; fall back to a query-string scan for connection
  // strings that URL() cannot parse (e.g. unescaped characters in the password).
  try {
    const mode = new URL(connectionString).searchParams.get("sslmode");
    if (mode) return mode.toLowerCase();
  } catch {
    // fall through to the regex scan
  }
  const captured = connectionString.match(/[?&]sslmode=([^&\s]+)/i)?.[1];
  return captured ? decodeURIComponent(captured).toLowerCase() : null;
}

/**
 * Read a URI query parameter case-insensitively (both the key and the returned
 * value are matched/normalised without regard to case), returning it lowercased
 * or null. Regex-based so it works on connection strings `new URL()` can't parse
 * — and, unlike `URLSearchParams.get`, it matches MongoDB's case-insensitive
 * option keys (`tlsInsecure`, `tlsAllowInvalidCertificates`).
 */
function readUriParamCI(connectionString: string, name: string): string | null {
  const captured = connectionString.match(new RegExp(`[?&]${name}=([^&\\s]+)`, "i"))?.[1];
  return captured ? decodeURIComponent(captured).toLowerCase() : null;
}

function isLoopbackConnection(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return /(@|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(connectionString);
  }
}

/**
 * Decide the TLS policy for a customer Postgres connection string.
 * See {@link DbSslDecision} for the semantics of each opt-out.
 */
export function customerDbSslDecision(connectionString: string): DbSslDecision {
  const mode = readSslMode(connectionString);
  if (mode === "disable") return "disable";
  if (mode && NO_VERIFY_MODES.has(mode)) return "no-verify";
  if (isLoopbackConnection(connectionString)) return "disable";
  return "verify";
}

/** `ssl` option shape accepted by node-postgres (`pg`). */
export type PgSslOption = false | { rejectUnauthorized: boolean };

/** Build the node-postgres `ssl` option for a customer connection string. */
export function pgSslOption(connectionString: string): PgSslOption {
  switch (customerDbSslDecision(connectionString)) {
    case "disable":
      return false;
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      return { rejectUnauthorized: true };
  }
}

/** `ssl` option shape accepted by postgres.js. */
export type PostgresJsSslOption = false | "require" | "verify-full";

/** Build the postgres.js `ssl` option for a customer connection string. */
export function postgresJsSslOption(connectionString: string): PostgresJsSslOption {
  switch (customerDbSslDecision(connectionString)) {
    case "disable":
      return false;
    case "no-verify":
      return "require"; // postgres.js: encrypt, do not verify the certificate
    default:
      return "verify-full"; // postgres.js: verify the certificate chain + hostname
  }
}

/**
 * Build the node-postgres `ssl` option for a pull source. Pull sources carry an
 * explicit `ssl` config field ("disable" | "no-verify" | undefined) which takes
 * priority; otherwise the connection string's `sslmode` drives the decision, and
 * host/port-only sources verify by default.
 */
export function pullPgSslOption(config: { ssl?: string; connection_string?: string }): PgSslOption {
  if (config.ssl === "disable") return false;
  if (config.ssl && NO_VERIFY_MODES.has(config.ssl.toLowerCase())) {
    return { rejectUnauthorized: false };
  }
  if (config.connection_string) return pgSslOption(config.connection_string);
  return { rejectUnauthorized: true };
}

/**
 * Whether *control-plane* connections (to our own `DATABASE_URL`, not a
 * customer DB) should verify the server certificate. Opt-in via
 * `CONTROL_PLANE_DB_SSL_VERIFY=true`; defaults to the historical no-verify
 * behaviour until Render's CA chain is validated in staging. Both ends here are
 * ours, so this is defense-in-depth rather than a MITM fix — hence the
 * conservative default that can't take the control plane offline on a cert
 * mismatch. A loopback DATABASE_URL still skips TLS entirely.
 */
export function controlPlaneDbSslVerify(flag: string | undefined): boolean {
  return flag === "true";
}

/**
 * Return `connectionString` with `sslmode=no-verify` applied, so a customer DB
 * that can only present a self-signed / private-CA certificate connects with
 * TLS encryption but no chain verification. This is the machine-applied form of
 * the documented opt-out — the dashboard's "connect without certificate
 * verification" toggle calls it so the operator never has to hand-edit the DSN.
 *
 * The toggle is an explicit operator action, so it wins over a verify-inducing
 * mode: a `require`/`prefer`/`verify-full`/… already in the string is rewritten
 * to `no-verify` (recall `require` deliberately maps to *verify* in our policy,
 * so leaving it would re-trap the operator in the same cert failure). Two modes
 * are left untouched because they're at least as permissive and represent a
 * deliberate, non-conflicting choice: `disable` (no TLS at all — never hits a
 * cert error) and an existing `no-verify`.
 */
export function withNoVerifySslMode(connectionString: string): string {
  const mode = readSslMode(connectionString);
  if (mode === null) {
    const sep = connectionString.includes("?") ? "&" : "?";
    return `${connectionString}${sep}sslmode=no-verify`;
  }
  if (mode === "disable" || NO_VERIFY_MODES.has(mode)) return connectionString;
  return connectionString.replace(/([?&]sslmode=)[^&\s]*/i, "$1no-verify");
}

/**
 * Return `connectionString` with MongoDB TLS certificate verification disabled
 * (`tlsAllowInvalidCertificates=true`) — the Mongo equivalent of
 * {@link withNoVerifySslMode}. The driver maps this option to
 * `rejectUnauthorized: false`, so the connection stays TLS-encrypted but the
 * self-signed / private-CA certificate chain (and hostname) is not verified.
 *
 * Conservative and explicit-toggle-wins, mirroring the Postgres helper:
 *   - `tlsInsecure=true` already disables all TLS validation → left untouched.
 *   - an existing `tlsAllowInvalidCertificates=<anything>` is normalised to
 *     `true` (so a stale `=false` doesn't re-trap the operator).
 *   - otherwise the param is appended.
 *
 * It deliberately does NOT force `tls=true`: a cert error only arises once TLS
 * is negotiated, so skipping verification is sufficient — and forcing TLS onto a
 * deliberately plaintext connection would be a surprising override. Option keys
 * are case-insensitive in MongoDB URIs; an existing key's casing is preserved.
 */
export function withMongoTlsNoVerify(connectionString: string): string {
  if (readUriParamCI(connectionString, "tlsInsecure") === "true") return connectionString;
  const existing = readUriParamCI(connectionString, "tlsAllowInvalidCertificates");
  if (existing === "true") return connectionString;
  if (existing !== null) {
    return connectionString.replace(/([?&]tlsAllowInvalidCertificates=)[^&\s]*/i, "$1true");
  }
  const sep = connectionString.includes("?") ? "&" : "?";
  return `${connectionString}${sep}tlsAllowInvalidCertificates=true`;
}

/**
 * OpenSSL verify codes meaning "the server's certificate chain could not be
 * validated against a trusted CA" — exactly the failures that
 * `sslmode=no-verify` resolves. Certificate *expiry* and *hostname mismatch*
 * are deliberately excluded: those usually signal a real misconfiguration the
 * operator should fix, not a self-signed / private-CA database that legitimately
 * needs no-verify.
 */
const CERT_CHAIN_VERIFY_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

/** Whether a TLS error message names a certificate-chain verification failure. */
function messageNamesCertFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    // OpenSSL 3.x hyphenates ("self-signed"), older builds don't ("self signed").
    m.includes("self-signed certificate") ||
    m.includes("self signed certificate") ||
    m.includes("unable to verify the first certificate") ||
    m.includes("unable to get local issuer certificate")
  );
}

/**
 * Whether a connection error is a TLS certificate-chain verification failure —
 * the "self-signed certificate in certificate chain" class raised when
 * verifying a customer database that can only present a self-signed /
 * private-CA certificate. Drives the dashboard's offer to retry with
 * verification disabled ({@link withNoVerifySslMode} / {@link withMongoTlsNoVerify}).
 *
 * Walks the whole `cause` chain (bounded) checking both the OpenSSL `code` and
 * the message, because the DB drivers wrap the underlying TLS error to differing
 * depths: `pg` exposes the code on a nested cause, while the Mongo driver buries
 * the reason in a wrapped `MongoServerSelectionError` message.
 */
export function isTlsCertVerificationError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && CERT_CHAIN_VERIFY_CODES.has(code)) return true;
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && messageNamesCertFailure(message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  // Non-object throws (e.g. a bare string) still get a message check.
  if (!(err && typeof err === "object")) return messageNamesCertFailure(String(err));
  return false;
}
