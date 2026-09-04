import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_NODE_VERSION,
  syncRenderNodeVersion,
} from "../sync-render-node-version.mjs";

const API_KEY = "obviously-fake-render-token";
const OWNER_ID = "tea-test_workspace";
const BASE_ENV = Object.freeze({
  RENDER_API_KEY: API_KEY,
  RENDER_OWNER_ID: OWNER_ID,
  RENDER_SERVICE_NAME: "axel-delivery-native",
  NODE_VERSION: EXPECTED_NODE_VERSION,
});
const SERVICE_IDS = Object.freeze({
  "axel-delivery-native": "srv-native_test",
  "axel-delivery-workers": "srv-workers_test",
  "axel-pull-worker": "srv-pull_test",
});
const SERVICE_TYPES = Object.freeze({
  "axel-delivery-native": "web_service",
  "axel-delivery-workers": "background_worker",
  "axel-pull-worker": "background_worker",
});

function entry(name, cursor, id = SERVICE_IDS[name] ?? "srv-unrelated_test", patch = {}) {
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

function assertSensitiveValuesAbsent(value) {
  const text = String(value);
  assert.doesNotMatch(text, new RegExp(API_KEY));
}

function createSinglePageProvider(options = {}) {
  const calls = [];
  const entries = options.entries ?? completePage();
  const readback = options.readback ?? EXPECTED_NODE_VERSION;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });
    if (url.pathname === "/v1/services" && method === "GET") {
      return jsonResponse(entries);
    }
    if (url.pathname.endsWith("/env-vars/NODE_VERSION") && method === "PUT") {
      return jsonResponse({ ok: true });
    }
    if (url.pathname.endsWith("/env-vars/NODE_VERSION") && method === "GET") {
      return jsonResponse({ envVar: { key: "NODE_VERSION", value: readback } });
    }
    throw new Error("unexpected_test_request");
  };
  return { calls, fetchImpl };
}

test("paginates fully, writes one exact key, and reads back only that key", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });

    if (url.pathname === "/v1/services" && method === "GET") {
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
    if (url.pathname.endsWith("/env-vars/NODE_VERSION") && method === "PUT") {
      return jsonResponse({ ok: true });
    }
    if (url.pathname.endsWith("/env-vars/NODE_VERSION") && method === "GET") {
      return jsonResponse({ key: "NODE_VERSION", value: EXPECTED_NODE_VERSION });
    }
    throw new Error("unexpected_test_request");
  };

  await syncRenderNodeVersion({
    env: BASE_ENV,
    fetchImpl,
    log: (line) => logs.push(line),
    pageLimit: 2,
  });

  const discoveryReads = calls.filter(
    (call) => call.method === "GET" && call.url.pathname === "/v1/services",
  );
  const writes = calls.filter((call) => call.method === "PUT");
  const readbacks = calls.filter(
    (call) => call.method === "GET" && call.url.pathname.endsWith("/env-vars/NODE_VERSION"),
  );
  assert.deepEqual(
    discoveryReads.map((call) => call.url.searchParams.get("cursor")),
    [null, "cursor-native", "cursor-pull"],
  );
  for (const read of discoveryReads) {
    assert.equal(read.url.searchParams.get("ownerId"), OWNER_ID);
    assert.equal(read.url.searchParams.get("includePreviews"), "false");
  }
  assert.equal(writes.length, 1);
  assert.equal(readbacks.length, 1);
  const expectedPath = `/v1/services/${SERVICE_IDS["axel-delivery-native"]}/env-vars/NODE_VERSION`;
  assert.equal(writes[0].url.pathname, expectedPath);
  assert.equal(readbacks[0].url.pathname, expectedPath);
  assert.deepEqual(JSON.parse(writes[0].init.body), { value: EXPECTED_NODE_VERSION });
  assert.equal(writes[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(writes[0].init.redirect, "error");
  assert.ok(calls.indexOf(writes[0]) > calls.indexOf(discoveryReads.at(-1)));
  assert.ok(calls.indexOf(readbacks[0]) > calls.indexOf(writes[0]));
  assert.deepEqual(logs, [
    "Saved and verified NODE_VERSION on axel-delivery-native without deploying.",
  ]);
  assertSensitiveValuesAbsent(logs.join("\n"));
});

test("reads the repository pin when NODE_VERSION is not explicit", async () => {
  const provider = createSinglePageProvider();
  const reads = [];
  const env = { ...BASE_ENV };
  delete env.NODE_VERSION;

  await syncRenderNodeVersion({
    env,
    fetchImpl: provider.fetchImpl,
    log: () => {},
    readFileImpl: async (path, encoding) => {
      reads.push({ path: String(path), encoding });
      return `${EXPECTED_NODE_VERSION}\n`;
    },
  });

  assert.equal(reads.length, 1);
  assert.match(reads[0].path, /\.node-version$/);
  assert.equal(reads[0].encoding, "utf8");
  const write = provider.calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(write.init.body), { value: EXPECTED_NODE_VERSION });
});

test("duplicate and missing targets fail before any write", async () => {
  for (const entries of [
    [
      ...completePage(),
      entry("axel-delivery-native", "cursor-native-duplicate", "srv-native_duplicate"),
    ],
    completePage().filter((item) => item.service.name !== "axel-pull-worker"),
  ]) {
    const provider = createSinglePageProvider({ entries });
    const env = entries.length === 2
      ? { ...BASE_ENV, RENDER_SERVICE_NAME: "axel-pull-worker" }
      : BASE_ENV;
    await assert.rejects(
      syncRenderNodeVersion({ env, fetchImpl: provider.fetchImpl, log: () => {} }),
      /render_service_resolution_failed/,
    );
    assert.equal(provider.calls.some((call) => call.method === "PUT"), false);
  }
});

test("wrong owner, service type, or singleton count fails before any write", async () => {
  for (const patch of [
    { ownerId: "tea-wrong_workspace" },
    { type: "web_service" },
    { numInstances: 2 },
  ]) {
    const provider = createSinglePageProvider({
      entries: [entry("axel-delivery-workers", "cursor-workers", undefined, patch)],
    });
    await assert.rejects(
      syncRenderNodeVersion({
        env: { ...BASE_ENV, RENDER_SERVICE_NAME: "axel-delivery-workers" },
        fetchImpl: provider.fetchImpl,
        log: () => {},
      }),
      /render_services_response_invalid|render_service_metadata_mismatch/,
    );
    assert.equal(provider.calls.some((call) => call.method === "PUT"), false);
  }
});

test("ClickHouse, invalid targets, and invalid pins fail before provider discovery", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse([]);
  };

  for (const serviceName of [undefined, "axel-clickhouse", "axel-delivery-native-copy"]) {
    const env = { ...BASE_ENV };
    if (serviceName === undefined) delete env.RENDER_SERVICE_NAME;
    else env.RENDER_SERVICE_NAME = serviceName;
    await assert.rejects(
      syncRenderNodeVersion({ env, fetchImpl, log: () => {} }),
      /missing_required_environment:RENDER_SERVICE_NAME|render_target_service_invalid/,
    );
  }
  for (const nodeVersion of ["22.23.1", "22.23.2 ", ""]) {
    await assert.rejects(
      syncRenderNodeVersion({
        env: { ...BASE_ENV, NODE_VERSION: nodeVersion },
        fetchImpl,
        log: () => {},
      }),
      /node_version_invalid/,
    );
  }
  await assert.rejects(
    syncRenderNodeVersion({
      env: (() => {
        const env = { ...BASE_ENV };
        delete env.NODE_VERSION;
        return env;
      })(),
      fetchImpl,
      log: () => {},
      readFileImpl: async () => `${EXPECTED_NODE_VERSION}\n\n`,
    }),
    /node_version_file_invalid/,
  );
  assert.equal(callCount, 0);
});

test("repeated pagination cursors fail before any write", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input, init });
    return jsonResponse([
      entry("axel-delivery-native", "same-cursor"),
      entry("axel-delivery-workers", "same-cursor"),
    ]);
  };

  await assert.rejects(
    syncRenderNodeVersion({ env: BASE_ENV, fetchImpl, log: () => {}, pageLimit: 2 }),
    /render_services_pagination_invalid/,
  );
  assert.equal(calls.some(({ init }) => init.method === "PUT"), false);
});

test("timeouts return a fixed error without provider details", async () => {
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
    throw new Error(`provider exposed ${API_KEY}`);
  };

  let caught;
  try {
    await syncRenderNodeVersion({
      env: BASE_ENV,
      fetchImpl,
      log: (line) => logs.push(line),
      timers,
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_timeout");
  assertSensitiveValuesAbsent(caught?.stack);
  assertSensitiveValuesAbsent(logs.join("\n"));
});

test("HTTP failures ignore provider bodies and return a fixed error", async () => {
  const fetchImpl = async () =>
    new Response(`provider exposed ${API_KEY}`, { status: 500 });

  let caught;
  try {
    await syncRenderNodeVersion({ env: BASE_ENV, fetchImpl, log: () => {} });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_http_error");
  assertSensitiveValuesAbsent(caught?.stack);
});

test("provider response bodies have a hard byte limit", async () => {
  const fetchImpl = async () => jsonResponse([{ padding: "x".repeat(256) }]);

  await assert.rejects(
    syncRenderNodeVersion({
      env: BASE_ENV,
      fetchImpl,
      log: () => {},
      responseBodyLimit: 64,
    }),
    /render_api_response_too_large/,
  );
});

test("mismatched or malformed exact-key readback fails closed after one write", async () => {
  for (const readbackResponse of [
    { envVar: { key: "NODE_VERSION", value: "22.23.1" } },
    { envVar: { key: "OTHER_KEY", value: EXPECTED_NODE_VERSION } },
  ]) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      calls.push({ url, method });
      if (url.pathname === "/v1/services") return jsonResponse(completePage());
      if (method === "PUT") return jsonResponse({ ok: true });
      return jsonResponse(readbackResponse);
    };

    await assert.rejects(
      syncRenderNodeVersion({ env: BASE_ENV, fetchImpl, log: () => {} }),
      /render_node_version_verification_failed|render_node_version_response_invalid/,
    );
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(
      calls.filter(
        (call) => call.method === "GET" && call.url.pathname.endsWith("/env-vars/NODE_VERSION"),
      ).length,
      1,
    );
  }
});
