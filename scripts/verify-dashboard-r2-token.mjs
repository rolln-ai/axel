#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_BODY = "axel-dashboard-r2-token-probe-v1";
const PUBLIC_ERROR_CODE_PATTERNS = [
  /^missing_dashboard_environment_file$/,
  /^missing_required_environment:(?:CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_R2_API_TOKEN|RAW_PAYLOAD_BUCKET)$/,
  /^invalid_(?:cloudflare_account_id|raw_payload_bucket)$/,
  /^invalid_vercel_environment_for_dashboard_r2_verification$/,
  /^legacy_cloudflare_api_token_present_in_dashboard_runtime$/,
  /^cloudflare_dashboard_r2_(?:probe_(?:request_failed|read_failed|mismatch)|http_[1-5][0-9]{2}|token_(?:queue|workers_scripts)_permission_present|(?:queue|workers_scripts)_denial_probe_http_[1-5][0-9]{2})$/,
];

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing_required_environment:${name}`);
  return value;
}

function accountId(value) {
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error("invalid_cloudflare_account_id");
  return value;
}

function bucketName(value) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) throw new Error("invalid_raw_payload_bucket");
  return value;
}

async function fetchBounded(fetchImpl, input, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, redirect: "error", signal: controller.signal });
  } catch {
    throw new Error("cloudflare_dashboard_r2_probe_request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function consumeBodyBounded(readBody, timeoutMs, errorCode) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(readBody),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } catch {
    // Never let provider response bodies or reader exceptions cross the
    // verifier boundary. The caller gets one stable, allowlisted code.
    throw new Error(errorCode);
  } finally {
    clearTimeout(timeout);
  }
}

async function objectRequest(fetchImpl, url, token, init, timeoutMs) {
  const response = await fetchBounded(fetchImpl, url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  }, timeoutMs);
  if (!response.ok) throw new Error(`cloudflare_dashboard_r2_http_${response.status}`);
  return response;
}

async function requireDenied(fetchImpl, url, token, capability, timeoutMs) {
  const response = await fetchBounded(fetchImpl, url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  }, timeoutMs);
  if (response.status === 401 || response.status === 403) return;
  if (response.ok) throw new Error(`cloudflare_dashboard_r2_token_${capability}_permission_present`);
  throw new Error(`cloudflare_dashboard_r2_${capability}_denial_probe_http_${response.status}`);
}

/**
 * Prove that Vercel's dashboard credential can read, write, and delete one
 * isolated R2 object but cannot list Queues or Worker scripts. The legacy
 * CLOUDFLARE_API_TOKEN variable is rejected so the provisioning credential
 * cannot silently remain in the dashboard runtime.
 */
export async function verifyDashboardR2Token(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const { account, bucket, token } = verifyDashboardR2Configuration(env);

  const objectKey = `_axel/dashboard-r2-token-probes/${randomUUID()}`;
  const objectUrl = `${apiBase}/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${objectKey}`;
  let objectCleanupRequired = false;
  let primaryError = null;
  let cleanupError = null;

  try {
    // A timed-out PUT may still have committed provider-side. Always attempt
    // deletion after the request begins so an ambiguous response cannot leave
    // a probe object behind.
    objectCleanupRequired = true;
    await objectRequest(fetchImpl, objectUrl, token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: PROBE_BODY,
    }, requestTimeoutMs);
    const read = await objectRequest(
      fetchImpl,
      objectUrl,
      token,
      { method: "GET" },
      requestTimeoutMs,
    );
    const probeBody = await consumeBodyBounded(
      () => read.text(),
      requestTimeoutMs,
      "cloudflare_dashboard_r2_probe_read_failed",
    );
    if (probeBody !== PROBE_BODY) {
      throw new Error("cloudflare_dashboard_r2_probe_mismatch");
    }

    await requireDenied(
      fetchImpl,
      `${apiBase}/accounts/${account}/queues?per_page=1`,
      token,
      "queue",
      requestTimeoutMs,
    );
    await requireDenied(
      fetchImpl,
      `${apiBase}/accounts/${account}/workers/scripts`,
      token,
      "workers_scripts",
      requestTimeoutMs,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (objectCleanupRequired) {
      try {
        await objectRequest(
          fetchImpl,
          objectUrl,
          token,
          { method: "DELETE" },
          requestTimeoutMs,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  log("dashboard Cloudflare token verified for R2 runtime access only");
}

/**
 * Validate the Vercel configuration without trying to use the token value.
 * Sensitive Vercel variables intentionally materialize as an opaque marker
 * when pulled into CI; the real value is available only inside Vercel's build
 * and runtime boundary.
 */
export function verifyDashboardR2Configuration(env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) {
    throw new Error("legacy_cloudflare_api_token_present_in_dashboard_runtime");
  }

  const account = accountId(requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID"));
  const bucket = bucketName(requiredEnv(env, "RAW_PAYLOAD_BUCKET"));
  const token = requiredEnv(env, "CLOUDFLARE_R2_API_TOKEN");
  return { account, bucket, token };
}

export function dashboardR2PublicErrorCode(error) {
  const candidate = error instanceof Error ? error.message : "";
  return PUBLIC_ERROR_CODE_PATTERNS.some((pattern) => pattern.test(candidate))
    ? candidate
    : "cloudflare_dashboard_r2_token_probe_failed";
}

export async function runDashboardR2TokenCli(options = {}) {
  const envFile = Object.hasOwn(options, "envFile") ? options.envFile : process.argv[2];
  const errorLog = options.errorLog ?? console.error;
  const log = options.log ?? console.log;
  try {
    if (envFile) {
      const loadEnvFile = options.loadEnvFile ?? process.loadEnvFile;
      loadEnvFile(envFile);
    } else if (!options.useProcessEnv) {
      throw new Error("missing_dashboard_environment_file");
    }

    if (options.configurationOnly) {
      verifyDashboardR2Configuration(options.env ?? process.env);
      log("dashboard Cloudflare token configuration verified");
      return 0;
    }

    await verifyDashboardR2Token({
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl,
      log,
      apiBase: options.apiBase,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    return 0;
  } catch (error) {
    // Emit only an allowlisted code. Provider bodies, exception strings, and
    // credential values can never cross this CLI boundary.
    errorLog(`dashboard Cloudflare token verification failed: ${dashboardR2PublicErrorCode(error)}`);
    return 1;
  }
}

export async function runDashboardR2TokenForVercelBuild(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") {
    log("dashboard Cloudflare token verification skipped outside Vercel production");
    return 0;
  }
  if (env.VERCEL_ENV !== "production") {
    const errorLog = options.errorLog ?? console.error;
    errorLog(
      "dashboard Cloudflare token verification failed: "
      + "invalid_vercel_environment_for_dashboard_r2_verification",
    );
    return 1;
  }
  return runDashboardR2TokenCli({ ...options, env, log, useProcessEnv: true, envFile: undefined });
}

export async function runDashboardR2TokenCommand(options = {}) {
  const [mode, envFile] = options.argv ?? process.argv.slice(2);
  if (mode === "--configuration-only") {
    return runDashboardR2TokenCli({ ...options, envFile, configurationOnly: true });
  }
  if (mode === "--runtime-if-production") {
    return runDashboardR2TokenForVercelBuild(options);
  }
  return runDashboardR2TokenCli({ ...options, envFile: mode });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await runDashboardR2TokenCommand();
}
