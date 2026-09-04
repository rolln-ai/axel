#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_BASE = "https://api.render.com/v1";
export const TARGET_SERVICE_NAMES = Object.freeze([
  "axel-delivery-native",
  "axel-delivery-workers",
  "axel-pull-worker",
]);
const SERVICE_EXPECTATIONS = Object.freeze({
  "axel-delivery-native": Object.freeze({ type: "web_service" }),
  "axel-delivery-workers": Object.freeze({
    type: "background_worker",
    numInstances: 1,
  }),
  "axel-pull-worker": Object.freeze({ type: "background_worker" }),
});
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

class RenderSyncError extends Error {
  constructor(code) {
    super(code);
    this.name = "RenderSyncError";
  }
}

function fail(code) {
  throw new RenderSyncError(code);
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

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response details must not escape through cancellation errors.
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
    if (error instanceof RenderSyncError) throw error;
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
    if (error instanceof RenderSyncError) throw error;
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

function targetServiceName(value) {
  if (!TARGET_SERVICE_NAMES.includes(value)) fail("render_target_service_invalid");
  return value;
}

function renderOwnerId(value) {
  if (!/^tea-[A-Za-z0-9_-]{1,128}$/.test(value)) {
    fail("render_owner_id_invalid");
  }
  return value;
}

async function resolveTargetServiceId(
  request,
  targetName,
  expectedOwnerId,
  expectation,
  pageLimit,
) {
  const matches = [];
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const pageUrl = new URL(`${API_BASE}/services`);
    pageUrl.searchParams.set("ownerId", expectedOwnerId);
    pageUrl.searchParams.set("includePreviews", "false");
    pageUrl.searchParams.set("limit", String(pageLimit));
    if (cursor !== undefined) pageUrl.searchParams.set("cursor", cursor);

    const entries = await request(pageUrl.href, true);
    if (!Array.isArray(entries) || entries.length > pageLimit) {
      fail("render_services_response_invalid");
    }

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

    if (entries.length < pageLimit) break;
    const nextCursor = entries.at(-1)?.cursor;
    if (!validCursor(nextCursor) || seenCursors.has(nextCursor)) {
      fail("render_services_pagination_invalid");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;

    if (pageNumber === MAX_PAGES - 1) fail("render_services_pagination_limit");
  }

  if (matches.length !== 1 || !validateServiceId(matches[0])) {
    fail("render_service_resolution_failed");
  }
  return matches[0];
}

export async function syncRenderDatabaseUrl(options = {}) {
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

  const token = requiredEnv(env, "RENDER_API_KEY");
  const ownerId = renderOwnerId(requiredEnv(env, "RENDER_OWNER_ID"));
  const databaseUrl = requiredEnv(env, "DATABASE_RUNTIME_URL");
  const serviceName = targetServiceName(requiredEnv(env, "RENDER_SERVICE_NAME"));
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
    SERVICE_EXPECTATIONS[serviceName],
    pageLimit,
  );
  await request(`${API_BASE}/services/${serviceId}/env-vars/DATABASE_URL`, false, {
    method: "PUT",
    body: JSON.stringify({ value: databaseUrl }),
  });
  log(`Saved DATABASE_URL on ${serviceName} without deploying.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  syncRenderDatabaseUrl().catch(() => {
    console.error("Render database credential sync failed.");
    process.exitCode = 1;
  });
}
