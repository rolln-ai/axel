import assert from "node:assert/strict";
import test from "node:test";
import { syncRenderDatabaseUrl } from "../sync-render-database-url.mjs";

const API_KEY = "test-render-api-key-keep-private";
const OWNER_ID = "tea-production_123";
const DATABASE_URL = "postgresql://runtime:test-password@db.test/axel";
const ENV = Object.freeze({
  RENDER_API_KEY: API_KEY,
  RENDER_OWNER_ID: OWNER_ID,
  DATABASE_RUNTIME_URL: DATABASE_URL,
  RENDER_SERVICE_NAME: "axel-delivery-native",
});
const SERVICE_IDS = Object.freeze({
  "axel-delivery-native": "srv-native_123",
  "axel-delivery-workers": "srv-workers_456",
  "axel-pull-worker": "srv-pull_789",
});
const SERVICE_TYPES = Object.freeze({
  "axel-delivery-native": "web_service",
  "axel-delivery-workers": "background_worker",
  "axel-pull-worker": "background_worker",
});

function entry(name, cursor, id = SERVICE_IDS[name] ?? "srv-unrelated_000", patch = {}) {
  return {
    cursor,
    service: {
      id,
      name,
      ownerId: OWNER_ID,
      type: SERVICE_TYPES[name] ?? "web_service",
      ...(name === "axel-delivery-workers" ? { numInstances: 1 } : {}),
      ...patch,
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completePage() {
  return [
    entry("axel-delivery-native", "cursor-native"),
    entry("axel-delivery-workers", "cursor-workers"),
    entry("axel-pull-worker", "cursor-pull"),
  ];
}

function assertSecretsAbsent(value) {
  const text = String(value);
  assert.doesNotMatch(text, new RegExp(API_KEY));
  assert.doesNotMatch(text, /test-password/);
  assert.doesNotMatch(text, new RegExp(DATABASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("paginates fully, resolves one explicit target, then performs exactly one write", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });

    if (method === "GET") {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) {
        return jsonResponse([
          entry("unrelated-service", "cursor-unrelated"),
          entry("axel-delivery-native", "cursor-native"),
        ]);
      }
      if (cursor === "cursor-native") {
        return jsonResponse([
          entry("axel-delivery-workers", "cursor-workers"),
          entry("axel-pull-worker", "cursor-pull"),
        ]);
      }
      if (cursor === "cursor-pull") return jsonResponse([]);
    }

    return jsonResponse({ ok: true });
  };

  await syncRenderDatabaseUrl({
    env: ENV,
    fetchImpl,
    log: (line) => logs.push(line),
    pageLimit: 2,
  });

  const reads = calls.filter((call) => call.method === "GET");
  const writes = calls.filter((call) => call.method === "PUT");
  assert.deepEqual(
    reads.map((call) => call.url.searchParams.get("cursor")),
    [null, "cursor-native", "cursor-pull"],
  );
  for (const read of reads) {
    assert.equal(read.url.searchParams.get("ownerId"), OWNER_ID);
    assert.equal(read.url.searchParams.get("includePreviews"), "false");
  }
  assert.ok(calls.indexOf(writes[0]) > calls.indexOf(reads.at(-1)), "all reads finish before writes");
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].url.pathname,
    `/v1/services/${SERVICE_IDS["axel-delivery-native"]}/env-vars/DATABASE_URL`,
  );
  for (const write of writes) {
    assert.equal(write.url.origin, "https://api.render.com");
    assert.deepEqual(JSON.parse(write.init.body), { value: DATABASE_URL });
    assert.equal(write.init.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(write.init.redirect, "error");
  }
  assert.deepEqual(logs, ["Saved DATABASE_URL on axel-delivery-native without deploying."]);
  assertSecretsAbsent(logs.join("\n"));
});

test("a duplicate target fails before the first write", async () => {
  let writeCount = 0;
  const fetchImpl = async (_input, init = {}) => {
    if (init.method === "PUT") writeCount += 1;
    return jsonResponse([
      ...completePage(),
      entry("axel-delivery-native", "cursor-native-duplicate", "srv-native_duplicate"),
    ]);
  };

  await assert.rejects(
    syncRenderDatabaseUrl({ env: ENV, fetchImpl, log: () => {} }),
    /render_service_resolution_failed/,
  );
  assert.equal(writeCount, 0);
});

test("a missing target fails before the first write", async () => {
  let writeCount = 0;
  const fetchImpl = async (_input, init = {}) => {
    if (init.method === "PUT") writeCount += 1;
    return jsonResponse(completePage().filter((item) => item.service.name !== "axel-pull-worker"));
  };

  await assert.rejects(
    syncRenderDatabaseUrl({
      env: { ...ENV, RENDER_SERVICE_NAME: "axel-pull-worker" },
      fetchImpl,
      log: () => {},
    }),
    /render_service_resolution_failed/,
  );
  assert.equal(writeCount, 0);
});

test("wrong workspace, service type, or singleton count fails before the first write", async () => {
  for (const patch of [
    { ownerId: "tea-wrong_456" },
    { type: "web_service" },
    { numInstances: 2 },
  ]) {
    let writeCount = 0;
    const fetchImpl = async (_input, init = {}) => {
      if (init.method === "PUT") writeCount += 1;
      return jsonResponse([
        entry("axel-delivery-workers", "cursor-workers", undefined, patch),
      ]);
    };
    await assert.rejects(
      syncRenderDatabaseUrl({
        env: { ...ENV, RENDER_SERVICE_NAME: "axel-delivery-workers" },
        fetchImpl,
        log: () => {},
      }),
      /render_services_response_invalid|render_service_metadata_mismatch/,
    );
    assert.equal(writeCount, 0);
  }
});

test("rejects an unapproved or missing service before provider discovery", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse(completePage());
  };
  for (const serviceName of [undefined, "axel-clickhouse", "axel-delivery-native-copy"]) {
    const env = { ...ENV };
    if (serviceName === undefined) delete env.RENDER_SERVICE_NAME;
    else env.RENDER_SERVICE_NAME = serviceName;
    await assert.rejects(
      syncRenderDatabaseUrl({ env, fetchImpl, log: () => {} }),
      /missing_required_environment:RENDER_SERVICE_NAME|render_target_service_invalid/,
    );
  }
  for (const ownerId of [undefined, "org-not-a-render-workspace", "tea-"]) {
    const env = { ...ENV };
    if (ownerId === undefined) delete env.RENDER_OWNER_ID;
    else env.RENDER_OWNER_ID = ownerId;
    await assert.rejects(
      syncRenderDatabaseUrl({ env, fetchImpl, log: () => {} }),
      /missing_required_environment:RENDER_OWNER_ID|render_owner_id_invalid/,
    );
  }
  assert.equal(callCount, 0);
});

test("a repeated pagination cursor fails before the first write", async () => {
  let writeCount = 0;
  const fetchImpl = async (_input, init = {}) => {
    if (init.method === "PUT") writeCount += 1;
    return jsonResponse([
      entry("axel-delivery-native", "same-cursor"),
      entry("axel-delivery-workers", "same-cursor"),
    ]);
  };

  await assert.rejects(
    syncRenderDatabaseUrl({ env: ENV, fetchImpl, log: () => {}, pageLimit: 2 }),
    /render_services_pagination_invalid/,
  );
  assert.equal(writeCount, 0);
});

test("timeout errors are fixed and disclose neither credential", async () => {
  const logs = [];
  const timers = {
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
  };
  const fetchImpl = async (_input, init) => {
    assert.equal(init.signal.aborted, true);
    throw new Error(`provider exposed ${API_KEY} and ${DATABASE_URL}`);
  };

  let caught;
  try {
    await syncRenderDatabaseUrl({
      env: ENV,
      fetchImpl,
      log: (line) => logs.push(line),
      timers,
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_timeout");
  assertSecretsAbsent(caught?.stack);
  assertSecretsAbsent(logs.join("\n"));
});

test("HTTP failures ignore provider bodies and disclose neither credential", async () => {
  const fetchImpl = async () =>
    new Response(`provider exposed ${API_KEY} and ${DATABASE_URL}`, { status: 500 });

  let caught;
  try {
    await syncRenderDatabaseUrl({ env: ENV, fetchImpl, log: () => {} });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_http_error");
  assertSecretsAbsent(caught?.stack);
});

test("unexpected success statuses are rejected", async () => {
  const fetchImpl = async () => jsonResponse([], 201);

  await assert.rejects(
    syncRenderDatabaseUrl({ env: ENV, fetchImpl, log: () => {} }),
    /render_api_http_error/,
  );
});

test("service-list response bodies have a hard byte limit", async () => {
  const fetchImpl = async () => jsonResponse([{ padding: "x".repeat(256) }]);

  await assert.rejects(
    syncRenderDatabaseUrl({
      env: ENV,
      fetchImpl,
      log: () => {},
      responseBodyLimit: 64,
    }),
    /render_api_response_too_large/,
  );
});
