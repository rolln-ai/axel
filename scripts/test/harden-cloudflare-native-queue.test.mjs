import assert from "node:assert/strict";
import test from "node:test";
import { hardenCloudflareNativeQueue } from "../harden-cloudflare-native-queue.mjs";

const ACCOUNT_ID = "a".repeat(32);
const QUEUE_ID = "b".repeat(32);
const CONSUMER_ID = "c".repeat(32);

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queueList() {
  return [
    { queue_id: QUEUE_ID, queue_name: "axel-delivery-native" },
    { queue_id: "d".repeat(32), queue_name: "axel-dead-letter" },
  ];
}

function consumer(overrides = {}) {
  return {
    consumer_id: CONSUMER_ID,
    type: "http_pull",
    dead_letter_queue: null,
    settings: {
      batch_size: 25,
      max_retries: 3,
      retry_delay: 30,
      visibility_timeout_ms: 60_000,
    },
    ...overrides,
  };
}

test("native queue consumer is updated in place and verified", async () => {
  let hardened = false;
  let updateBody;
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/queues?per_page=100")) return jsonResponse(queueList());
    if (url.endsWith(`/consumers/${CONSUMER_ID}`) && init.method === "PUT") {
      updateBody = JSON.parse(init.body);
      hardened = true;
      return jsonResponse(consumer({ ...updateBody }));
    }
    if (url.endsWith("/consumers")) {
      return jsonResponse([
        hardened
          ? consumer({
              dead_letter_queue: "axel-dead-letter",
              settings: {
                batch_size: 25,
                max_retries: 11,
                retry_delay: 30,
                visibility_timeout_ms: 60_000,
              },
            })
          : consumer(),
      ]);
    }
    return jsonResponse(null, 404);
  };

  const logs = [];
  await hardenCloudflareNativeQueue({
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_QUEUE_API_TOKEN: "test-token" },
    fetchImpl,
    log: (line) => logs.push(line),
  });

  assert.equal(updateBody.type, "http_pull");
  assert.equal(updateBody.dead_letter_queue, "axel-dead-letter");
  assert.equal(updateBody.settings.max_retries, 11);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  assert.match(logs[0], /retries=11/);
  assert.doesNotMatch(logs.join("\n"), /test-token/);
});

test("already-hardened consumer is read only", async () => {
  let putCount = 0;
  const hardenedConsumer = consumer({
    dead_letter_queue: "axel-dead-letter",
    settings: {
      batch_size: 25,
      max_retries: 11,
      retry_delay: 30,
      visibility_timeout_ms: 60_000,
    },
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "PUT") putCount += 1;
    if (url.endsWith("/queues?per_page=100")) return jsonResponse(queueList());
    if (url.endsWith("/consumers")) return jsonResponse([hardenedConsumer]);
    return jsonResponse(null, 404);
  };

  await hardenCloudflareNativeQueue({
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_QUEUE_API_TOKEN: "test-token" },
    fetchImpl,
    log: () => {},
  });
  assert.equal(putCount, 0);
});

test("missing DLQ fails before a consumer mutation", async () => {
  let putCount = 0;
  const fetchImpl = async (input, init = {}) => {
    if (init.method === "PUT") putCount += 1;
    if (String(input).endsWith("/queues?per_page=100")) {
      return jsonResponse([{ queue_id: QUEUE_ID, queue_name: "axel-delivery-native" }]);
    }
    return jsonResponse([], 200);
  };

  await assert.rejects(
    hardenCloudflareNativeQueue({
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_QUEUE_API_TOKEN: "test-token" },
      fetchImpl,
      log: () => {},
    }),
    /cloudflare_queue_match_count:axel-dead-letter:0/,
  );
  assert.equal(putCount, 0);
});

test("worker deploy token cannot substitute for the queue admin token", async () => {
  let fetchCount = 0;
  await assert.rejects(
    hardenCloudflareNativeQueue({
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "deploy-only-token" },
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse([]);
      },
      log: () => {},
    }),
    /missing_required_environment:CLOUDFLARE_QUEUE_API_TOKEN/,
  );
  assert.equal(fetchCount, 0);
});
