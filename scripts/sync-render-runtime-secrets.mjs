#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_BASE = "https://api.render.com/v1";
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const CANARY_RUNTIME_KEYS = Object.freeze([
  "AXEL_CANARY_ENABLED",
  "AXEL_CANARY_INTERVAL_MS",
  "AXEL_CANARY_INGEST_URL",
  "AXEL_CANARY_INGEST_AUTH_HEADER",
  "AXEL_CANARY_INGEST_AUTH_VALUE",
  "AXEL_CANARY_RECEIPT_URL",
  "AXEL_CANARY_RECEIPT_AUTH_HEADER",
  "AXEL_CANARY_RECEIPT_AUTH_VALUE",
]);

export const RENDER_RUNTIME_SECRET_PROFILES = Object.freeze({
  "axel-delivery-native": Object.freeze({
    CLOUDFLARE_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
    CLOUDFLARE_API_TOKEN: "CLOUDFLARE_QUEUE_API_TOKEN",
    DELIVERY_QUEUE_ID: "DELIVERY_QUEUE_ID",
    EDGE_DELIVERY_QUEUE_ID: "EDGE_DELIVERY_QUEUE_ID",
    CREDENTIALS_MASTER_KEY: "CREDENTIALS_MASTER_KEY",
    DELIVERY_SHARED_SECRET: "DELIVERY_SHARED_SECRET",
    SOURCE_LOOKUP_SHARED_SECRET: "SOURCE_LOOKUP_SHARED_SECRET",
    CLICKHOUSE_URL: "CLICKHOUSE_URL",
    CLICKHOUSE_USER: "CLICKHOUSE_USER",
    CLICKHOUSE_PASSWORD: "CLICKHOUSE_PASSWORD",
    SENTRY_DSN: "SENTRY_DSN",
  }),
  "axel-delivery-workers": Object.freeze({
    CLOUDFLARE_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
    CLOUDFLARE_API_TOKEN: "CLOUDFLARE_QUEUE_API_TOKEN",
    DELIVERY_QUEUE_ID: "DELIVERY_QUEUE_ID",
    EDGE_DELIVERY_QUEUE_ID: "EDGE_DELIVERY_QUEUE_ID",
    CREDENTIALS_MASTER_KEY: "CREDENTIALS_MASTER_KEY",
    DELIVERY_SHARED_SECRET: "DELIVERY_SHARED_SECRET",
    CLICKHOUSE_URL: "CLICKHOUSE_URL",
    CLICKHOUSE_USER: "CLICKHOUSE_USER",
    CLICKHOUSE_PASSWORD: "CLICKHOUSE_PASSWORD",
    SENTRY_DSN: "SENTRY_DSN",
  }),
  "axel-pull-worker": Object.freeze({
    CREDENTIALS_MASTER_KEY: "CREDENTIALS_MASTER_KEY",
    CLICKHOUSE_URL: "CLICKHOUSE_URL",
    CLICKHOUSE_USER: "CLICKHOUSE_USER",
    CLICKHOUSE_PASSWORD: "CLICKHOUSE_PASSWORD",
    SENTRY_DSN: "SENTRY_DSN",
  }),
});

const RENDER_SERVICE_EXPECTATIONS = Object.freeze({
  "axel-delivery-native": Object.freeze({ type: "web_service" }),
  "axel-delivery-workers": Object.freeze({
    type: "background_worker",
    numInstances: 1,
  }),
  "axel-pull-worker": Object.freeze({ type: "background_worker" }),
});

const OPTIONAL_PROFILE_INPUTS = Object.freeze({
  "axel-delivery-native": Object.freeze({
    DELIVERY_SHARED_SECRET_PREVIOUS: "DELIVERY_SHARED_SECRET_PREVIOUS",
    SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS: "SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS",
  }),
  "axel-delivery-workers": Object.freeze({}),
  "axel-pull-worker": Object.freeze({}),
});

const MANAGED_RUNTIME_KEYS = Object.freeze(new Set([
  "SENTRY_ENVIRONMENT",
  ...CANARY_RUNTIME_KEYS,
  ...Object.values(RENDER_RUNTIME_SECRET_PROFILES)
    .flatMap((profile) => Object.keys(profile)),
  ...Object.values(OPTIONAL_PROFILE_INPUTS)
    .flatMap((profile) => Object.keys(profile)),
]));

class RenderSecretSyncError extends Error {
  constructor(code) {
    super(code);
    this.name = "RenderSecretSyncError";
  }
}

function fail(code) {
  throw new RenderSecretSyncError(code);
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`missing_required_environment:${name}`);
  }
  return value;
}

function optionalEnv(env, name) {
  const value = env[name];
  if (value === undefined) return "";
  if (typeof value !== "string") fail(`invalid_optional_environment:${name}`);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function targetServiceName(value) {
  if (!Object.hasOwn(RENDER_RUNTIME_SECRET_PROFILES, value)) {
    fail("render_target_service_invalid");
  }
  return value;
}

function renderOwnerId(value) {
  if (!/^tea-[A-Za-z0-9_-]{1,128}$/.test(value)) {
    fail("render_owner_id_invalid");
  }
  return value;
}

function buildCandidateProfile(env, serviceName) {
  const values = new Map();
  for (const [renderKey, inputName] of Object.entries(
    RENDER_RUNTIME_SECRET_PROFILES[serviceName],
  )) {
    values.set(renderKey, requiredEnv(env, inputName));
  }
  for (const [renderKey, inputName] of Object.entries(OPTIONAL_PROFILE_INPUTS[serviceName])) {
    values.set(renderKey, optionalEnv(env, inputName));
  }
  for (const [currentKey, previousKey] of [
    ["DELIVERY_SHARED_SECRET", "DELIVERY_SHARED_SECRET_PREVIOUS"],
    ["SOURCE_LOOKUP_SHARED_SECRET", "SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS"],
  ]) {
    const current = values.get(currentKey);
    const previous = values.get(previousKey);
    if (typeof previous === "string" && previous.length > 0 && previous === current) {
      fail(`rotation_credentials_must_differ:${previousKey}`);
    }
  }
  values.set("SENTRY_ENVIRONMENT", "production");
  return values;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response details must never escape through cancellation errors.
  }
}

async function readBoundedBody(response, limit) {
  if (!response.body) return "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await cancelBody(response);
    fail("render_api_response_too_large");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limit) {
        try {
          await reader.cancel();
        } catch {
          // Keep the fixed local error below.
        }
        fail("render_api_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof RenderSecretSyncError) throw error;
    fail("render_api_response_read_failed");
  } finally {
    reader.releaseLock();
  }
}

async function renderRequest(options) {
  const {
    fetchImpl,
    token,
    url,
    method = "GET",
    body,
    requestTimeoutMs,
    responseBodyLimit,
    timers,
    readJson = false,
  } = options;
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });

    if (controller.signal.aborted) {
      await cancelBody(response);
      fail("render_api_timeout");
    }
    if (response.status !== 200) {
      await cancelBody(response);
      fail("render_api_http_error");
    }
    if (!readJson) {
      await cancelBody(response);
      return undefined;
    }

    const responseText = await readBoundedBody(response, responseBodyLimit);
    try {
      return JSON.parse(responseText);
    } catch {
      fail("render_api_response_invalid");
    }
  } catch (error) {
    if (error instanceof RenderSecretSyncError) throw error;
    if (controller.signal.aborted) fail("render_api_timeout");
    fail("render_api_request_failed");
  } finally {
    timers.clearTimeout(timer);
  }
}

function validCursor(cursor) {
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 4096;
}

function validateServiceId(serviceId) {
  return typeof serviceId === "string" && /^srv-[A-Za-z0-9_-]{1,128}$/.test(serviceId);
}

function validateEnvKey(key) {
  return typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(key);
}

async function readAllPages(request, baseUrl, pageLimit, responseCode, paginationCode) {
  const results = [];
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("limit", String(pageLimit));
    if (cursor !== undefined) pageUrl.searchParams.set("cursor", cursor);
    const entries = await request(pageUrl.href, true);
    if (!Array.isArray(entries) || entries.length > pageLimit) fail(responseCode);
    results.push(...entries);

    if (entries.length < pageLimit) return results;
    const nextCursor = entries.at(-1)?.cursor;
    if (!validCursor(nextCursor) || seenCursors.has(nextCursor)) fail(paginationCode);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  fail("render_api_pagination_limit");
}

async function resolveTargetServiceId(
  request,
  targetName,
  expectedOwnerId,
  expectation,
  pageLimit,
) {
  const servicesUrl = new URL(`${API_BASE}/services`);
  servicesUrl.searchParams.set("ownerId", expectedOwnerId);
  servicesUrl.searchParams.set("includePreviews", "false");
  const entries = await readAllPages(
    request,
    servicesUrl.href,
    pageLimit,
    "render_services_response_invalid",
    "render_services_pagination_invalid",
  );
  const matches = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !validCursor(entry.cursor)) {
      fail("render_services_response_invalid");
    }
    const service = entry.service;
    if (
      !service
      || typeof service !== "object"
      || typeof service.name !== "string"
      || typeof service.ownerId !== "string"
      || typeof service.type !== "string"
      || service.ownerId !== expectedOwnerId
    ) {
      fail("render_services_response_invalid");
    }
    if (service.name !== targetName) continue;
    if (
      service.type !== expectation.type
      || (
        expectation.numInstances !== undefined
        && service.numInstances !== expectation.numInstances
      )
    ) {
      fail("render_service_metadata_mismatch");
    }
    matches.push(service.id);
  }
  if (matches.length !== 1 || !validateServiceId(matches[0])) {
    fail("render_service_resolution_failed");
  }
  return matches[0];
}

async function readDirectEnvVars(request, serviceId, pageLimit) {
  const entries = await readAllPages(
    request,
    `${API_BASE}/services/${serviceId}/env-vars`,
    pageLimit,
    "render_environment_response_invalid",
    "render_environment_pagination_invalid",
  );
  const values = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !validCursor(entry.cursor)) {
      fail("render_environment_response_invalid");
    }
    const envVar = entry.envVar;
    if (
      !envVar ||
      typeof envVar !== "object" ||
      !validateEnvKey(envVar.key) ||
      typeof envVar.value !== "string"
    ) {
      fail("render_environment_response_invalid");
    }
    if (values.has(envVar.key)) fail("render_environment_duplicate_key");
    values.set(envVar.key, envVar.value);
  }
  return values;
}

function sortedPayload(values) {
  return [...values]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export async function syncRenderRuntimeSecrets(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    "invalid_request_timeout",
  );
  const responseBodyLimit = positiveInteger(
    options.responseBodyLimit ?? RESPONSE_BODY_LIMIT_BYTES,
    "invalid_response_body_limit",
  );
  const pageLimit = positiveInteger(options.pageLimit ?? PAGE_LIMIT, "invalid_page_limit");
  if (pageLimit > 100) fail("invalid_page_limit");
  const timers = options.timers ?? {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  if (typeof fetchImpl !== "function" || typeof log !== "function") fail("invalid_dependencies");
  if (typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    fail("invalid_dependencies");
  }

  const serviceName = targetServiceName(requiredEnv(env, "RENDER_SERVICE_NAME"));
  const ownerId = renderOwnerId(requiredEnv(env, "RENDER_OWNER_ID"));
  const candidateProfile = buildCandidateProfile(env, serviceName);
  const token = requiredEnv(env, "RENDER_API_KEY");
  const request = (url, readJson, init = {}) =>
    renderRequest({
      fetchImpl,
      token,
      url,
      requestTimeoutMs,
      responseBodyLimit,
      timers,
      readJson,
      ...init,
    });

  const serviceId = await resolveTargetServiceId(
    request,
    serviceName,
    ownerId,
    RENDER_SERVICE_EXPECTATIONS[serviceName],
    pageLimit,
  );
  const current = await readDirectEnvVars(request, serviceId, pageLimit);
  const desired = new Map(current);
  for (const key of MANAGED_RUNTIME_KEYS) {
    const ownedByDedicatedCanarySync =
      serviceName === "axel-delivery-workers" && CANARY_RUNTIME_KEYS.includes(key);
    if (!candidateProfile.has(key) && !ownedByDedicatedCanarySync) desired.delete(key);
  }
  for (const [key, value] of candidateProfile) desired.set(key, value);

  await request(`${API_BASE}/services/${serviceId}/env-vars`, false, {
    method: "PUT",
    body: JSON.stringify(sortedPayload(desired)),
  });

  const confirmed = await readDirectEnvVars(request, serviceId, pageLimit);
  if (!mapsEqual(desired, confirmed)) fail("render_environment_verification_failed");
  log(`Saved reviewed runtime secrets on ${serviceName} without deploying.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  syncRenderRuntimeSecrets().catch(() => {
    console.error("Render runtime secret sync failed.");
    process.exitCode = 1;
  });
}
