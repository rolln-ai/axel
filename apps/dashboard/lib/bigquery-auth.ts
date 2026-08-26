import "server-only";
import { createSign } from "node:crypto";

/**
 * Google service-account auth for the dashboard's BigQuery read paths
 * (test-connection probe + data viewer). The delivery-service connector has
 * its own copy tuned for the hot delivery path (token caching, insertdata
 * scope); these dashboard actions are low-frequency, so we mint a fresh
 * token per call and skip the cache.
 *
 * Fixed Google hosts, so there's no user-supplied host to SSRF-guard (unlike
 * the Postgres / Databricks inspect paths).
 */

export const BIGQUERY_API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Read + run-query scope, enough for tables.list and jobs.query. */
export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const TOKEN_TIMEOUT_MS = 8_000;

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

export function parseServiceAccountJson(raw: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("service_account_json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("service_account_json is not an object");
  }
  const sa = parsed as Partial<GoogleServiceAccount>;
  if (typeof sa.client_email !== "string" || !sa.client_email) {
    throw new Error("service_account_json missing client_email");
  }
  if (typeof sa.private_key !== "string" || !sa.private_key.includes("PRIVATE KEY")) {
    throw new Error("service_account_json missing a usable private_key");
  }
  return {
    client_email: sa.client_email,
    private_key: sa.private_key,
    // Google service-account token exchange always uses this fixed endpoint.
    // Never trust the credential's token_uri as a fetch target.
    token_uri: DEFAULT_TOKEN_URI,
    ...(typeof sa.project_id === "string" ? { project_id: sa.project_id } : {}),
  };
}

const base64url = (input: string): string => Buffer.from(input).toString("base64url");

export async function mintGoogleAccessToken(
  sa: GoogleServiceAccount,
  scope: string,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: DEFAULT_TOKEN_URI,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key, "base64url");
  } catch (err) {
    throw new Error(`Could not sign with the service-account key: ${err instanceof Error ? err.message : String(err)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await fetch(DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Google rejected the service-account key (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const body = JSON.parse(text) as { access_token?: string };
    if (!body.access_token) throw new Error("Token endpoint returned no access_token.");
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}
