import assert from "node:assert/strict";
import test from "node:test";

import { verifyRuntimeToken } from "../self-host/verify-runtime-token.mjs";

const ACCOUNT_ID = "a".repeat(32);
const QUEUE_ID = "b".repeat(32);
const CONSUMER_ID = "c".repeat(32);
const BASE_ENV = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: "provisioning-token-never-log",
  CLOUDFLARE_RUNTIME_API_TOKEN: "runtime-token-never-log",
  DELIVERY_QUEUE_ID: QUEUE_ID,
  RAW_PAYLOAD_BUCKET: "axel-test-raw",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONSUMER = {
  consumer_id: CONSUMER_ID,
  type: "http_pull",
  dead_letter_queue: "axel-test-dead-letter",
  settings: { batch_size: 25, max_retries: 11, visibility_timeout_ms: 300_000 },
};

test("runtime token proves Queue edit and R2 access without leasing a message", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.headers.authorization, "Bearer runtime-token-never-log");
    if (String(url).endsWith("/consumers") && (init.method ?? "GET") === "GET") {
      return json({ success: true, result: [CONSUMER] });
    }
    if (String(url).endsWith(`/consumers/${CONSUMER_ID}`)) {
      return json({ success: true, result: CONSUMER });
    }
    if (init.method === "PUT") return new Response(null, { status: 200 });
    if (init.method === "GET") return new Response("axel-runtime-token-probe-v1", { status: 200 });
    if (init.method === "DELETE") return new Response(null, { status: 200 });
    throw new Error("unexpected request");
  };

  const messages = [];
  await verifyRuntimeToken({
    env: BASE_ENV,
    fetchImpl,
    apiBase: "https://api.example.test/client/v4",
    log: (message) => messages.push(message),
  });

  assert.deepEqual(calls.map((call) => call.init.method ?? "GET"), ["GET", "PUT", "GET", "PUT", "GET", "DELETE"]);
  assert.equal(calls.some((call) => call.url.includes("/messages/")), false);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(JSON.stringify({ calls, messages }), /provisioning-token-never-log/);
});

test("runtime token rejects provisioning-token reuse before network access", async () => {
  let called = false;
  await assert.rejects(
    verifyRuntimeToken({
      env: { ...BASE_ENV, CLOUDFLARE_RUNTIME_API_TOKEN: BASE_ENV.CLOUDFLARE_API_TOKEN },
      fetchImpl: async () => {
        called = true;
        throw new Error("must not run");
      },
      log: () => {},
    }),
    /cloudflare_runtime_token_must_differ_from_provisioning_token/,
  );
  assert.equal(called, false);
});

test("runtime token leaves messages untouched when the R2 proof fails", async () => {
  const methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(`${init.method} ${String(url)}`);
    if (String(url).endsWith("/consumers")) {
      return json({ success: true, result: [CONSUMER] });
    }
    if (String(url).endsWith(`/consumers/${CONSUMER_ID}`)) {
      return json({ success: true, result: CONSUMER });
    }
    return new Response(null, { status: 403 });
  };
  await assert.rejects(
    verifyRuntimeToken({ env: BASE_ENV, fetchImpl, apiBase: "https://api.example.test", log: () => {} }),
    /cloudflare_runtime_r2_http_403/,
  );
  assert.equal(methods.some((entry) => entry.includes("/messages/")), false);
});
