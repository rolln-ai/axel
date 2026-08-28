#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_BASE = "https://api.render.com/v1";
const EXPECTED_SERVICE_NAME = "axel-delivery-workers";
const EXPECTED_SERVICE_REPOSITORY = "rolln-ai/axel";
const EXPECTED_BRANCH = "main";
const EXPECTED_SERVICE_TYPE = "background_worker";
const EXPECTED_ENVIRONMENT = "node";
const EXPECTED_INSTANCE_COUNT = 1;
const EXPECTED_BLUEPRINT_PATH = "render.yaml";
const SAFE_BLUEPRINT_STATUSES = new Set(["paused", "in_sync"]);
const EXPECTED_INGEST_URL = "https://ingest.axelapp.ai/in/src_delivery_canary";
const EXPECTED_INGEST_HEADER = "x-axel-token";
const EXPECTED_RECEIPT_URL =
  "https://app.axelapp.ai/api/ops/delivery-canary/receipt?probe={probe_id}";
const EXPECTED_RECEIPT_HEADER = "x-axel-canary-token";
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export const MANAGED_CANARY_KEYS = Object.freeze([
  "AXEL_CANARY_ENABLED",
  "AXEL_CANARY_INTERVAL_MS",
  "AXEL_CANARY_INGEST_URL",
  "AXEL_CANARY_INGEST_AUTH_HEADER",
  "AXEL_CANARY_INGEST_AUTH_VALUE",
  "AXEL_CANARY_RECEIPT_URL",
  "AXEL_CANARY_RECEIPT_AUTH_HEADER",
  "AXEL_CANARY_RECEIPT_AUTH_VALUE",
]);

class RenderCanarySyncError extends Error {
  constructor(code) {
    super(code);
    this.name = "RenderCanarySyncError";
  }
}

export function renderCanarySyncFailureCode(error) {
  return error instanceof RenderCanarySyncError
    ? error.message
    : "unexpected_error";
}

function fail(code) {
  throw new RenderCanarySyncError(code);
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`missing_required_environment:${name}`);
  }
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function serviceId(value) {
  if (!/^srv-[0-9a-z]{20}$/.test(value)) fail("render_service_id_invalid");
  return value;
}

function ownerId(value) {
  if (!/^tea-[0-9a-z]{20}$/.test(value)) fail("render_owner_id_invalid");
  return value;
}

function blueprintId(value) {
  if (!/^exs-[0-9a-z]{20}$/.test(value)) fail("render_blueprint_id_invalid");
  return value;
}

function blueprintRepository(value) {
  const normalized = normalizeGitHubRepository(value);
  if (!normalized || normalized !== value) {
    fail("render_blueprint_repository_invalid");
  }
  return normalized;
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function validateUrl(value, code) {
  if (value.length > 4096 || hasControlCharacters(value)) fail(code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) {
    fail(code);
  }
  return value;
}

function validateHeaderName(value, code) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) fail(code);
  return value;
}

function validateAuthValue(value, code) {
  if (value.length > 4096 || hasControlCharacters(value)) fail(code);
  return value;
}

function buildCandidate(env) {
  const candidate = new Map();
  for (const key of MANAGED_CANARY_KEYS) candidate.set(key, requiredEnv(env, key));

  if (candidate.get("AXEL_CANARY_ENABLED") !== "1") {
    fail("canary_enabled_value_invalid");
  }
  if (candidate.get("AXEL_CANARY_INTERVAL_MS") !== "900000") {
    fail("canary_interval_value_invalid");
  }
  const ingestUrl = validateUrl(
    candidate.get("AXEL_CANARY_INGEST_URL"),
    "canary_ingest_url_invalid",
  );
  if (ingestUrl !== EXPECTED_INGEST_URL) fail("canary_ingest_url_invalid");
  const ingestHeader = validateHeaderName(
    candidate.get("AXEL_CANARY_INGEST_AUTH_HEADER"),
    "canary_ingest_header_invalid",
  );
  if (ingestHeader !== EXPECTED_INGEST_HEADER) fail("canary_ingest_header_invalid");
  validateAuthValue(
    candidate.get("AXEL_CANARY_INGEST_AUTH_VALUE"),
    "canary_ingest_auth_invalid",
  );
  if (!/^axt_[A-Za-z0-9_-]{32,128}$/.test(candidate.get("AXEL_CANARY_INGEST_AUTH_VALUE"))) {
    fail("canary_ingest_auth_invalid");
  }
  const receiptUrl = validateUrl(
    candidate.get("AXEL_CANARY_RECEIPT_URL"),
    "canary_receipt_url_invalid",
  );
  if (receiptUrl !== EXPECTED_RECEIPT_URL) fail("canary_receipt_url_invalid");
  const receiptHeader = validateHeaderName(
    candidate.get("AXEL_CANARY_RECEIPT_AUTH_HEADER"),
    "canary_receipt_header_invalid",
  );
  if (receiptHeader !== EXPECTED_RECEIPT_HEADER) fail("canary_receipt_header_invalid");
  validateAuthValue(
    candidate.get("AXEL_CANARY_RECEIPT_AUTH_VALUE"),
    "canary_receipt_auth_invalid",
  );
  if (candidate.get("AXEL_CANARY_RECEIPT_AUTH_VALUE").length < 32) {
    fail("canary_receipt_auth_invalid");
  }
  if (
    candidate.get("AXEL_CANARY_INGEST_AUTH_VALUE")
    === candidate.get("AXEL_CANARY_RECEIPT_AUTH_VALUE")
  ) {
    fail("canary_auth_values_must_differ");
  }
  return candidate;
}

function normalizeGitHubRepository(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const prefixes = [
    "https://github.com/",
    "git@github.com:",
    "ssh://git@github.com/",
  ];
  const prefix = prefixes.find((candidate) =>
    trimmed.toLowerCase().startsWith(candidate)
  );
  let repository = prefix ? trimmed.slice(prefix.length) : trimmed;
  repository = repository.replace(/\/$/, "");
  if (repository.toLowerCase().endsWith(".git")) repository = repository.slice(0, -4);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return "";
  return repository.toLowerCase();
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function consistentServiceField(service, key) {
  const values = [];
  if (Object.hasOwn(service, key)) values.push(service[key]);
  if (object(service.serviceDetails) && Object.hasOwn(service.serviceDetails, key)) {
    values.push(service.serviceDetails[key]);
  }
  if (values.length === 0 || values.some((value) => value !== values[0])) {
    fail("render_service_metadata_mismatch");
  }
  return values[0];
}

function autoscalingDisabled(service) {
  if (!object(service.serviceDetails)) return false;
  if (!Object.hasOwn(service.serviceDetails, "autoscaling")) return true;
  const { autoscaling } = service.serviceDetails;
  return object(autoscaling) && autoscaling.enabled === false;
}

function verifyService(service, expectedServiceId, expectedOwnerId) {
  if (!object(service)) fail("render_service_response_invalid");
  if (
    service.id !== expectedServiceId
    || service.ownerId !== expectedOwnerId
    || service.name !== EXPECTED_SERVICE_NAME
    || service.type !== EXPECTED_SERVICE_TYPE
    || service.branch !== EXPECTED_BRANCH
    || normalizeGitHubRepository(service.repo) !== EXPECTED_SERVICE_REPOSITORY
    || consistentServiceField(service, "env") !== EXPECTED_ENVIRONMENT
    || consistentServiceField(service, "runtime") !== EXPECTED_ENVIRONMENT
    || consistentServiceField(service, "numInstances") !== EXPECTED_INSTANCE_COUNT
    || !autoscalingDisabled(service)
    || service.autoDeploy !== "no"
    || service.suspended !== "not_suspended"
    || !Array.isArray(service.suspenders)
    || service.suspenders.length !== 0
  ) {
    fail("render_service_metadata_mismatch");
  }
}

function verifyBlueprint(
  blueprint,
  expectedBlueprintId,
  expectedServiceId,
  expectedOwnerId,
  expectedRepository,
) {
  if (!object(blueprint)) fail("render_blueprint_response_invalid");
  if (blueprint.id !== expectedBlueprintId) {
    fail("render_blueprint_identity_mismatch");
  }
  if (!SAFE_BLUEPRINT_STATUSES.has(blueprint.status)) {
    fail("render_blueprint_status_unsafe");
  }
  if (blueprint.autoSync !== false) {
    fail("render_blueprint_autosync_not_disabled");
  }
  if (blueprint.branch !== EXPECTED_BRANCH) {
    fail("render_blueprint_branch_mismatch");
  }
  if (blueprint.path !== EXPECTED_BLUEPRINT_PATH) {
    fail("render_blueprint_path_mismatch");
  }
  if (normalizeGitHubRepository(blueprint.repo) !== expectedRepository) {
    fail("render_blueprint_repository_mismatch");
  }
  if (Object.hasOwn(blueprint, "ownerId") && blueprint.ownerId !== expectedOwnerId) {
    fail("render_blueprint_owner_mismatch");
  }
  if (!Array.isArray(blueprint.resources)) {
    fail("render_blueprint_membership_mismatch");
  }
  const matches = blueprint.resources.filter((resource) =>
    object(resource) && resource.id === expectedServiceId
  );
  if (
    matches.length !== 1
    || matches[0].name !== EXPECTED_SERVICE_NAME
    || matches[0].type !== EXPECTED_SERVICE_TYPE
  ) {
    fail("render_blueprint_membership_mismatch");
  }
}

function verifyRuntimePrerequisites(values) {
  if (
    values.get("DELIVERY_ROLE") !== "worker"
    || values.get("SENTRY_ENVIRONMENT") !== "production"
    || !values.get("SENTRY_DSN")
  ) {
    fail("render_worker_runtime_prerequisite_missing");
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response details must not replace fixed local diagnostics.
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
    if (error instanceof RenderCanarySyncError) throw error;
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
    if (error instanceof RenderCanarySyncError) throw error;
    if (controller.signal.aborted) fail("render_api_timeout");
    fail("render_api_request_failed");
  } finally {
    timers.clearTimeout(timer);
  }
}

function validCursor(cursor) {
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 4096;
}

function validEnvKey(key) {
  return typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(key);
}

async function readDirectEnvVars(request, targetServiceId, pageLimit) {
  const values = new Map();
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const pageUrl = new URL(`${API_BASE}/services/${targetServiceId}/env-vars`);
    pageUrl.searchParams.set("limit", String(pageLimit));
    if (cursor !== undefined) pageUrl.searchParams.set("cursor", cursor);
    const entries = await request(pageUrl.href, true);
    if (!Array.isArray(entries) || entries.length > pageLimit) {
      fail("render_environment_response_invalid");
    }
    for (const entry of entries) {
      if (!object(entry) || !validCursor(entry.cursor) || !object(entry.envVar)) {
        fail("render_environment_response_invalid");
      }
      const { key, value } = entry.envVar;
      if (!validEnvKey(key) || typeof value !== "string") {
        fail("render_environment_response_invalid");
      }
      if (values.has(key)) fail("render_environment_duplicate_key");
      values.set(key, value);
    }
    if (entries.length < pageLimit) return values;
    const nextCursor = entries.at(-1)?.cursor;
    if (!validCursor(nextCursor) || seenCursors.has(nextCursor)) {
      fail("render_environment_pagination_invalid");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  fail("render_api_pagination_limit");
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

export async function syncRenderCanarySettings(options = {}) {
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

  const expectedServiceId = serviceId(
    requiredEnv(env, "RENDER_DELIVERY_WORKERS_SERVICE_ID"),
  );
  const expectedOwnerId = ownerId(requiredEnv(env, "RENDER_OWNER_ID"));
  const expectedBlueprintId = blueprintId(
    requiredEnv(env, "RENDER_DELIVERY_WORKERS_BLUEPRINT_ID"),
  );
  const expectedBlueprintRepository = blueprintRepository(
    requiredEnv(env, "RENDER_DELIVERY_WORKERS_BLUEPRINT_REPOSITORY"),
  );
  const token = requiredEnv(env, "RENDER_API_KEY");
  const candidate = buildCandidate(env);

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

  const service = await request(`${API_BASE}/services/${expectedServiceId}`, true);
  verifyService(service, expectedServiceId, expectedOwnerId);

  const blueprint = await request(`${API_BASE}/blueprints/${expectedBlueprintId}`, true);
  verifyBlueprint(
    blueprint,
    expectedBlueprintId,
    expectedServiceId,
    expectedOwnerId,
    expectedBlueprintRepository,
  );

  const current = await readDirectEnvVars(request, expectedServiceId, pageLimit);
  verifyRuntimePrerequisites(current);
  const desired = new Map(current);
  for (const [key, value] of candidate) desired.set(key, value);

  await request(`${API_BASE}/services/${expectedServiceId}/env-vars`, false, {
    method: "PUT",
    body: JSON.stringify(sortedPayload(desired)),
  });

  const confirmed = await readDirectEnvVars(request, expectedServiceId, pageLimit);
  if (!mapsEqual(desired, confirmed)) fail("render_environment_verification_failed");
  log("Saved eight canary settings on the verified delivery worker without deploying.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  syncRenderCanarySettings().catch((error) => {
    console.error(
      `Render delivery-canary settings sync failed: ${renderCanarySyncFailureCode(error)}`,
    );
    process.exitCode = 1;
  });
}
