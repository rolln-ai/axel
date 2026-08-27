#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_BODY = "axel-runtime-token-probe-v1";

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing_required_environment:${name}`);
  return value;
}

function resourceId(value, label) {
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function bucketName(value) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) throw new Error("invalid_raw_payload_bucket");
  return value;
}

function findOneHttpPullConsumer(consumers) {
  if (!Array.isArray(consumers)) throw new Error("cloudflare_runtime_consumers_response_invalid");
  const matches = consumers.filter((consumer) => consumer?.type === "http_pull");
  if (matches.length !== 1) throw new Error(`cloudflare_runtime_http_pull_consumer_count:${matches.length}`);
  return matches[0];
}

async function fetchBounded(fetchImpl, input, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, redirect: "error", signal: controller.signal });
  } catch {
    throw new Error("cloudflare_runtime_probe_request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function queueJson(fetchImpl, url, token, init = {}) {
  const response = await fetchBounded(fetchImpl, url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`cloudflare_runtime_queue_http_${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("cloudflare_runtime_queue_response_invalid");
  }
  if (!body || body.success !== true) throw new Error("cloudflare_runtime_queue_response_unsuccessful");
  return body.result;
}

async function objectRequest(fetchImpl, url, token, init) {
  const response = await fetchBounded(fetchImpl, url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`cloudflare_runtime_r2_http_${response.status}`);
  return response;
}

/**
 * Prove that the token handed to application containers has the exact runtime
 * operations Axel needs. Queue edit permission is proved with an idempotent
 * same-configuration consumer PUT/readback; no live message is leased. A
 * unique, non-customer R2 object is deleted before returning.
 */
export async function verifyRuntimeToken(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;

  const accountId = resourceId(requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID"), "cloudflare_account_id");
  let queueId = env.DELIVERY_QUEUE_ID
    ? resourceId(env.DELIVERY_QUEUE_ID, "delivery_queue_id")
    : null;
  const bucket = bucketName(requiredEnv(env, "RAW_PAYLOAD_BUCKET"));
  const runtimeToken = requiredEnv(env, "CLOUDFLARE_RUNTIME_API_TOKEN");
  const provisioningToken = env.CLOUDFLARE_API_TOKEN;
  if (provisioningToken && runtimeToken === provisioningToken) {
    throw new Error("cloudflare_runtime_token_must_differ_from_provisioning_token");
  }

  if (!queueId) {
    const queueName = requiredEnv(env, "DELIVERY_QUEUE_NAME");
    const queues = await queueJson(
      fetchImpl,
      `${apiBase}/accounts/${accountId}/queues?per_page=100`,
      runtimeToken,
    );
    if (!Array.isArray(queues)) throw new Error("cloudflare_runtime_queues_response_invalid");
    const matches = queues.filter((queue) => queue?.queue_name === queueName);
    if (matches.length !== 1) throw new Error(`cloudflare_runtime_queue_match_count:${matches.length}`);
    queueId = resourceId(matches[0]?.queue_id, "delivery_queue_id");
  }

  const consumersUrl = `${apiBase}/accounts/${accountId}/queues/${queueId}/consumers`;
  let primaryError = null;
  let cleanupError = null;
  let objectCreated = false;
  const objectKey = `_axel/runtime-token-probes/${randomUUID()}`;
  const objectUrl = `${apiBase}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${objectKey}`;

  try {
    const current = findOneHttpPullConsumer(
      await queueJson(fetchImpl, consumersUrl, runtimeToken),
    );
    const consumerId = resourceId(current.consumer_id, "delivery_consumer_id");
    const expected = {
      type: "http_pull",
      dead_letter_queue: current.dead_letter_queue,
      settings: current.settings,
    };
    await queueJson(fetchImpl, `${consumersUrl}/${consumerId}`, runtimeToken, {
      method: "PUT",
      body: JSON.stringify(expected),
    });
    const readback = findOneHttpPullConsumer(
      await queueJson(fetchImpl, consumersUrl, runtimeToken),
    );
    const settingsMatch = expected.settings
      && Object.entries(expected.settings).every(([key, value]) => readback.settings?.[key] === value);
    if (
      readback.dead_letter_queue !== expected.dead_letter_queue
      || !settingsMatch
    ) {
      throw new Error("cloudflare_runtime_queue_consumer_readback_failed");
    }

    await objectRequest(fetchImpl, objectUrl, runtimeToken, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: PROBE_BODY,
    });
    objectCreated = true;
    const read = await objectRequest(fetchImpl, objectUrl, runtimeToken, { method: "GET" });
    if (await read.text() !== PROBE_BODY) throw new Error("cloudflare_runtime_r2_probe_mismatch");
  } catch (error) {
    primaryError = error;
  } finally {
    if (objectCreated) {
      try {
        await objectRequest(fetchImpl, objectUrl, runtimeToken, { method: "DELETE" });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  log("[self-host] runtime Cloudflare token verified for Queue and R2 operations");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  verifyRuntimeToken().catch((error) => {
    const code = error instanceof Error ? error.message : "cloudflare_runtime_token_probe_failed";
    // Error codes contain no provider response bodies, object bodies, or token values.
    console.error(`[self-host] runtime Cloudflare token verification failed: ${code}`);
    process.exitCode = 1;
  });
}
