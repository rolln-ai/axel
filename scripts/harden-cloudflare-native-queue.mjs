#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const NATIVE_QUEUE = "axel-delivery-native";
const DEAD_LETTER_QUEUE = "axel-dead-letter";
const EXPECTED_SETTINGS = Object.freeze({
  batch_size: 25,
  max_retries: 11,
  retry_delay: 30,
  visibility_timeout_ms: 60_000,
});
const REQUEST_TIMEOUT_MS = 15_000;

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing_required_environment:${name}`);
  return value;
}

function assertResourceId(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(`invalid_cloudflare_${label}`);
  }
  return value;
}

async function apiJson(fetchImpl, url, token, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new Error("cloudflare_api_request_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`cloudflare_api_http_${response.status}`);
  const body = await response.json();
  if (!body || body.success !== true) throw new Error("cloudflare_api_unsuccessful");
  return body.result;
}

function findOneQueue(queues, name) {
  if (!Array.isArray(queues)) throw new Error("cloudflare_queues_response_invalid");
  const matches = queues.filter((queue) => queue?.queue_name === name);
  if (matches.length !== 1) throw new Error(`cloudflare_queue_match_count:${name}:${matches.length}`);
  return matches[0];
}

function findOneHttpPullConsumer(consumers) {
  if (!Array.isArray(consumers)) throw new Error("cloudflare_consumers_response_invalid");
  const matches = consumers.filter((consumer) => consumer?.type === "http_pull");
  if (matches.length !== 1) throw new Error(`cloudflare_http_pull_consumer_count:${matches.length}`);
  return matches[0];
}

function consumerIsHardened(consumer) {
  return consumer?.type === "http_pull"
    && consumer.dead_letter_queue === DEAD_LETTER_QUEUE
    && Object.entries(EXPECTED_SETTINGS).every(([key, value]) => consumer.settings?.[key] === value);
}

export async function hardenCloudflareNativeQueue(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const accountId = assertResourceId(requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID"), "account_id");
  // Consumer updates require Queues:Edit. Keep that wider runtime/admin grant
  // separate from the token Wrangler uses to deploy Workers.
  const token = requiredEnv(env, "CLOUDFLARE_QUEUE_API_TOKEN");
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`;

  const queues = await apiJson(fetchImpl, `${apiBase}?per_page=100`, token);
  const nativeQueue = findOneQueue(queues, NATIVE_QUEUE);
  // Resolve the DLQ as a required resource before changing the consumer.
  findOneQueue(queues, DEAD_LETTER_QUEUE);
  const queueId = assertResourceId(nativeQueue.queue_id, "queue_id");
  const consumersUrl = `${apiBase}/${queueId}/consumers`;
  const consumer = findOneHttpPullConsumer(await apiJson(fetchImpl, consumersUrl, token));
  const consumerId = assertResourceId(consumer.consumer_id, "consumer_id");

  if (!consumerIsHardened(consumer)) {
    await apiJson(fetchImpl, `${consumersUrl}/${consumerId}`, token, {
      method: "PUT",
      body: JSON.stringify({
        type: "http_pull",
        dead_letter_queue: DEAD_LETTER_QUEUE,
        settings: EXPECTED_SETTINGS,
      }),
    });
  }

  const readback = findOneHttpPullConsumer(await apiJson(fetchImpl, consumersUrl, token));
  if (!consumerIsHardened(readback)) {
    throw new Error("cloudflare_native_queue_hardening_readback_failed");
  }
  log(
    `Cloudflare native queue hardened: retries=${EXPECTED_SETTINGS.max_retries} dlq=${DEAD_LETTER_QUEUE}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  hardenCloudflareNativeQueue().catch((error) => {
    const code = error instanceof Error ? error.message : "cloudflare_native_queue_hardening_failed";
    // Error codes contain no response bodies, tokens, or provider URLs.
    console.error(`Cloudflare native queue hardening failed: ${code}`);
    process.exitCode = 1;
  });
}
