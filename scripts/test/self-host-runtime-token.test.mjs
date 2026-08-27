import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("self-host example requires a distinct runtime Cloudflare token", () => {
  const example = readFileSync(
    new URL("../../infra/self-host/self-host.env.example", import.meta.url),
    "utf8",
  );
  const runtimeSection = example.slice(
    example.indexOf("# Required Queue/R2 runtime token"),
    example.indexOf("DELIVERY_QUEUE_ID="),
  );
  assert.match(runtimeSection, /CLOUDFLARE_RUNTIME_API_TOKEN=/);
  assert.match(runtimeSection, /must not reuse CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(runtimeSection, /optional/i);
});

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
    if (String(url).endsWith("/workers/scripts")) {
      return new Response(null, { status: 403 });
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

  assert.deepEqual(
    calls.map((call) => call.init.method ?? "GET"),
    ["GET", "PUT", "GET", "PUT", "GET", "GET", "DELETE"],
  );
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

test("runtime token normalizes R2 body-reader failures", async () => {
  const providerSecret = "provider-body-reader-secret-never-log";
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/consumers")) {
      return json({ success: true, result: [CONSUMER] });
    }
    if (String(url).endsWith(`/consumers/${CONSUMER_ID}`)) {
      return json({ success: true, result: CONSUMER });
    }
    if (init.method === "GET") {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error(providerSecret);
        },
      };
    }
    return new Response(null, { status: 200 });
  };

  await assert.rejects(
    verifyRuntimeToken({ env: BASE_ENV, fetchImpl, apiBase: "https://api.example.test", log: () => {} }),
    (error) => {
      assert.equal(error.message, "cloudflare_runtime_r2_probe_read_failed");
      assert.doesNotMatch(error.message, new RegExp(providerSecret));
      return true;
    },
  );
});

test("runtime token hard-bounds a stalled Queue response body", { timeout: 1_000 }, async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/consumers$/);
    return {
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    };
  };

  await assert.rejects(
    verifyRuntimeToken({
      env: BASE_ENV,
      fetchImpl,
      apiBase: "https://api.example.test",
      log: () => {},
      requestTimeoutMs: 20,
    }),
    { message: "cloudflare_runtime_queue_response_invalid" },
  );
});

test("runtime token hard-bounds a stalled R2 body and still cleans up", { timeout: 1_000 }, async () => {
  const methods = [];
  const fetchImpl = async (url, init) => {
    const method = init.method ?? "GET";
    methods.push(method);
    if (String(url).endsWith("/consumers")) {
      return json({ success: true, result: [CONSUMER] });
    }
    if (String(url).endsWith(`/consumers/${CONSUMER_ID}`)) {
      return json({ success: true, result: CONSUMER });
    }
    if (method === "GET") {
      return {
        ok: true,
        status: 200,
        text: () => new Promise(() => {}),
      };
    }
    return new Response(null, { status: 200 });
  };

  await assert.rejects(
    verifyRuntimeToken({
      env: BASE_ENV,
      fetchImpl,
      apiBase: "https://api.example.test",
      log: () => {},
      requestTimeoutMs: 20,
    }),
    { message: "cloudflare_runtime_r2_probe_read_failed" },
  );
  assert.equal(methods.at(-1), "DELETE");
});

test("runtime token fails closed when Worker Scripts access is present", async () => {
  const methods = [];
  const fetchImpl = async (url, init) => {
    const method = init.method ?? "GET";
    methods.push(`${method} ${String(url)}`);
    if (String(url).endsWith("/consumers")) {
      return json({ success: true, result: [CONSUMER] });
    }
    if (String(url).endsWith(`/consumers/${CONSUMER_ID}`)) {
      return json({ success: true, result: CONSUMER });
    }
    if (String(url).endsWith("/workers/scripts")) {
      return json({ success: true, result: [] });
    }
    if (method === "GET") return new Response("axel-runtime-token-probe-v1");
    return new Response(null, { status: 200 });
  };

  await assert.rejects(
    verifyRuntimeToken({
      env: BASE_ENV,
      fetchImpl,
      apiBase: "https://api.example.test",
      log: () => {},
    }),
    /cloudflare_runtime_token_workers_scripts_permission_present/,
  );
  assert.match(methods.at(-2) ?? "", /GET .*\/workers\/scripts$/);
  assert.match(methods.at(-1) ?? "", /DELETE .*\/r2\/buckets\//);
});
