import assert from "node:assert/strict";
import test from "node:test";
import {
  RENDER_RUNTIME_SECRET_PROFILES,
  syncRenderRuntimeSecrets,
} from "../sync-render-runtime-secrets.mjs";

const API_KEY = "render-test-token-sensitive";
const OWNER_ID = "tea-production_123";
const CANARY_VALUES = Object.freeze({
  AXEL_CANARY_ENABLED: "1",
  AXEL_CANARY_INTERVAL_MS: "123456",
  AXEL_CANARY_INGEST_URL: "https://stale.invalid/ingest",
  AXEL_CANARY_INGEST_AUTH_HEADER: "x-stale-ingest",
  AXEL_CANARY_INGEST_AUTH_VALUE: "stale-ingest-secret",
  AXEL_CANARY_RECEIPT_URL: "https://stale.invalid/receipt",
  AXEL_CANARY_RECEIPT_AUTH_HEADER: "x-stale-receipt",
  AXEL_CANARY_RECEIPT_AUTH_VALUE: "stale-receipt-secret",
});
const CANARY_KEYS = Object.freeze(Object.keys(CANARY_VALUES));
const SENTINELS = Object.freeze({
  CLOUDFLARE_ACCOUNT_ID: "account-sensitive",
  CLOUDFLARE_QUEUE_API_TOKEN: "runtime-token-sensitive",
  DELIVERY_QUEUE_ID: "delivery-queue-sensitive",
  EDGE_DELIVERY_QUEUE_ID: "edge-queue-sensitive",
  CREDENTIALS_MASTER_KEY: "master-key-sensitive",
  DELIVERY_SHARED_SECRET: "delivery-secret-sensitive",
  SOURCE_LOOKUP_SHARED_SECRET: "source-secret-sensitive",
  CLICKHOUSE_URL: "https://clickhouse.test:8443",
  CLICKHOUSE_USER: "clickhouse-user-sensitive",
  CLICKHOUSE_PASSWORD: "clickhouse-password-sensitive",
  SENTRY_DSN: "https://public@example.invalid/1",
  AXEL_CANARY_ENABLED: "1",
  AXEL_CANARY_INTERVAL_MS: "900000",
  AXEL_CANARY_INGEST_URL: "https://ingest.invalid/in/canary",
  AXEL_CANARY_INGEST_AUTH_HEADER: "x-axel-token",
  AXEL_CANARY_INGEST_AUTH_VALUE: "canary-ingest-sensitive",
  AXEL_CANARY_RECEIPT_URL: "https://dashboard.invalid/receipt?probe={probe_id}",
  AXEL_CANARY_RECEIPT_AUTH_HEADER: "x-axel-canary-token",
  AXEL_CANARY_RECEIPT_AUTH_VALUE: "canary-receipt-sensitive",
});
const BASE_ENV = Object.freeze({
  RENDER_API_KEY: API_KEY,
  RENDER_OWNER_ID: OWNER_ID,
  RENDER_SERVICE_NAME: "axel-delivery-native",
  ...SENTINELS,
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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serviceEntries() {
  return [
    {
      name: "unrelated-service",
      id: "srv-unrelated_000",
      ownerId: OWNER_ID,
      type: "web_service",
    },
    ...Object.entries(SERVICE_IDS).map(([name, id]) => ({
      name,
      id,
      ownerId: OWNER_ID,
      type: SERVICE_TYPES[name],
      ...(name === "axel-delivery-workers" ? { serviceDetails: { numInstances: 1 } } : {}),
    })),
  ];
}

function page(items, cursor, pageLimit, mapEntry, prefix) {
  const offset = cursor === null ? 0 : Number.parseInt(cursor.slice(prefix.length), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("bad test cursor");
  return items.slice(offset, offset + pageLimit).map((value, index) => ({
    cursor: `${prefix}${offset + index + 1}`,
    ...mapEntry(value),
  }));
}

function createProvider(options = {}) {
  const pageLimit = options.pageLimit ?? 2;
  const services = options.services ?? serviceEntries();
  let directEnv = [...(options.directEnv ?? [{ key: "UNRELATED_EXISTING", value: "preserve-me" }])];
  const calls = [];
  let putCount = 0;

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });
    if (options.onCall) {
      const response = await options.onCall({ url, method, init, putCount });
      if (response) return response;
    }

    if (method === "GET" && url.pathname === "/v1/services") {
      return jsonResponse(
        page(
          services,
          url.searchParams.get("cursor"),
          pageLimit,
          (service) => ({ service }),
          "services-",
        ),
      );
    }

    const envMatch = url.pathname.match(/^\/v1\/services\/(srv-[A-Za-z0-9_-]+)\/env-vars$/);
    if (!envMatch) throw new Error(`unexpected provider path ${url.pathname}`);
    if (method === "GET") {
      return jsonResponse(
        page(
          directEnv,
          url.searchParams.get("cursor"),
          pageLimit,
          (envVar) => ({ envVar }),
          "environment-",
        ),
      );
    }
    if (method === "PUT") {
      putCount += 1;
      directEnv = JSON.parse(init.body);
      return jsonResponse(directEnv);
    }
    throw new Error(`unexpected provider method ${method}`);
  };

  return {
    calls,
    fetchImpl,
    get putCount() {
      return putCount;
    },
    get directEnv() {
      return directEnv;
    },
  };
}

function assertSensitiveValuesAbsent(value) {
  const text = String(value);
  const sensitiveSentinels = Object.entries(SENTINELS)
    .filter(([name]) => ![
      "AXEL_CANARY_ENABLED",
      "AXEL_CANARY_INTERVAL_MS",
    ].includes(name))
    .map(([, sentinel]) => sentinel);
  for (const secret of [API_KEY, ...sensitiveSentinels]) {
    assert.equal(text.includes(secret), false, "sensitive value escaped into diagnostics");
  }
}

test("fully discovers one target and its env before one preserving bulk save", async () => {
  const provider = createProvider({
    directEnv: [
      { key: "UNRELATED_EXISTING", value: "preserve-me" },
      { key: "DELIVERY_SHARED_SECRET", value: "old-value" },
      { key: "DATABASE_URL", value: "postgresql://must-remain-unchanged" },
    ],
  });
  const logs = [];

  await syncRenderRuntimeSecrets({
    env: BASE_ENV,
    fetchImpl: provider.fetchImpl,
    log: (line) => logs.push(line),
    pageLimit: 2,
  });

  assert.equal(provider.putCount, 1);
  const putIndex = provider.calls.findIndex((call) => call.method === "PUT");
  assert.ok(putIndex > 0);
  assert.ok(
    provider.calls.slice(0, putIndex).some((call) => call.url.searchParams.has("cursor")),
    "preflight discovery must follow pagination",
  );
  assert.ok(
    provider.calls.slice(putIndex + 1).some((call) => call.method === "GET"),
    "the full saved profile must be read back",
  );

  const put = provider.calls[putIndex];
  assert.equal(put.url.pathname, `/v1/services/${SERVICE_IDS[BASE_ENV.RENDER_SERVICE_NAME]}/env-vars`);
  assert.equal(put.url.origin, "https://api.render.com");
  assert.equal(put.init.redirect, "error");
  assert.equal(put.init.headers.authorization, `Bearer ${API_KEY}`);
  const saved = new Map(JSON.parse(put.init.body).map(({ key, value }) => [key, value]));
  assert.equal(saved.get("UNRELATED_EXISTING"), "preserve-me");
  assert.equal(saved.get("DATABASE_URL"), "postgresql://must-remain-unchanged");
  assert.equal(saved.get("CLOUDFLARE_API_TOKEN"), SENTINELS.CLOUDFLARE_QUEUE_API_TOKEN);
  assert.equal(saved.get("DELIVERY_SHARED_SECRET"), SENTINELS.DELIVERY_SHARED_SECRET);
  assert.equal(saved.get("DELIVERY_SHARED_SECRET_PREVIOUS"), "");
  assert.equal(saved.get("SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS"), "");
  assert.equal(saved.get("SENTRY_ENVIRONMENT"), "production");
  assert.deepEqual(logs, [
    "Saved reviewed runtime secrets on axel-delivery-native without deploying.",
  ]);
  assertSensitiveValuesAbsent(logs);
  assert.equal(provider.calls.some((call) => call.url.pathname.includes("/deploys")), false);
  const serviceRead = provider.calls.find((call) => call.url.pathname === "/v1/services");
  assert.equal(serviceRead.url.searchParams.get("ownerId"), OWNER_ID);
  assert.equal(serviceRead.url.searchParams.get("includePreviews"), "false");
});

test("profiles are target-specific and never obtain secrets from a peer service", async () => {
  for (const target of Object.keys(RENDER_RUNTIME_SECRET_PROFILES)) {
    const provider = createProvider({
      pageLimit: 100,
      directEnv: [
        { key: "UNRELATED_EXISTING", value: "preserve-me" },
        { key: "SOURCE_LOOKUP_SHARED_SECRET", value: "stale-source-secret" },
        { key: "SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS", value: "stale-source-previous" },
        { key: "DELIVERY_SHARED_SECRET_PREVIOUS", value: "stale-delivery-previous" },
        ...Object.entries(CANARY_VALUES).map(([key, value]) => ({ key, value })),
      ],
    });
    const env = { ...BASE_ENV, RENDER_SERVICE_NAME: target };
    for (const key of CANARY_KEYS) delete env[key];
    await syncRenderRuntimeSecrets({
      env,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 100,
    });
    const write = provider.calls.find((call) => call.method === "PUT");
    const saved = new Map(JSON.parse(write.init.body).map(({ key, value }) => [key, value]));
    assert.equal(write.url.pathname, `/v1/services/${SERVICE_IDS[target]}/env-vars`);
    assert.equal(saved.has("DATABASE_URL"), false);
    if (target === "axel-delivery-native") {
      assert.equal(saved.get("SOURCE_LOOKUP_SHARED_SECRET"), SENTINELS.SOURCE_LOOKUP_SHARED_SECRET);
      assert.equal(saved.get("SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS"), "");
    } else {
      assert.equal(saved.has("SOURCE_LOOKUP_SHARED_SECRET"), false);
      assert.equal(saved.has("SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS"), false);
    }
    if (target === "axel-delivery-workers") {
      assert.deepEqual(
        Object.fromEntries(CANARY_KEYS.map((key) => [key, saved.get(key)])),
        CANARY_VALUES,
      );
    } else {
      assert.deepEqual(
        [...saved.keys()].filter((key) => key.startsWith("AXEL_CANARY_")),
        [],
      );
    }
    if (target === "axel-pull-worker") {
      assert.equal(saved.has("DELIVERY_SHARED_SECRET"), false);
      assert.equal(saved.has("DELIVERY_SHARED_SECRET_PREVIOUS"), false);
      assert.equal(saved.has("CLOUDFLARE_API_TOKEN"), false);
    } else if (target === "axel-delivery-workers") {
      assert.equal(saved.has("DELIVERY_SHARED_SECRET_PREVIOUS"), false);
    }
  }
});

test("generic worker sync cannot source or change dedicated canary settings", async () => {
  assert.deepEqual(
    Object.keys(RENDER_RUNTIME_SECRET_PROFILES["axel-delivery-workers"])
      .filter((key) => key.startsWith("AXEL_CANARY_")),
    [],
  );

  const provider = createProvider({
    pageLimit: 100,
    directEnv: Object.entries(CANARY_VALUES).map(([key, value]) => ({ key, value })),
  });
  const env = { ...BASE_ENV, RENDER_SERVICE_NAME: "axel-delivery-workers" };
  for (const key of CANARY_KEYS) delete env[key];

  await syncRenderRuntimeSecrets({
    env,
    fetchImpl: provider.fetchImpl,
    log: () => {},
    pageLimit: 100,
  });

  const write = provider.calls.find((call) => call.method === "PUT");
  const saved = new Map(JSON.parse(write.init.body).map(({ key, value }) => [key, value]));
  assert.deepEqual(
    Object.fromEntries(CANARY_KEYS.map((key) => [key, saved.get(key)])),
    CANARY_VALUES,
  );
});

test("wrong workspace, service type, or singleton count fails before mutation", async () => {
  for (const servicePatch of [
    { ownerId: "tea-wrong_456" },
    { type: "web_service" },
    { numInstances: 2 },
    { serviceDetails: { numInstances: 2 } },
    { serviceDetails: { numInstances: 1, autoscaling: { enabled: true } } },
  ]) {
    const services = serviceEntries().map((service) =>
      service.name === "axel-delivery-workers"
        ? { ...service, ...servicePatch }
        : service
    );
    const provider = createProvider({ services, pageLimit: 100 });
    await assert.rejects(
      syncRenderRuntimeSecrets({
        env: { ...BASE_ENV, RENDER_SERVICE_NAME: "axel-delivery-workers" },
        fetchImpl: provider.fetchImpl,
        log: () => {},
        pageLimit: 100,
      }),
      /render_services_response_invalid|render_service_metadata_mismatch/,
    );
    assert.equal(provider.putCount, 0);
  }
});

test("duplicate service discovery fails before any provider mutation", async () => {
  const services = [
    ...serviceEntries(),
    {
      name: "axel-delivery-native",
      id: "srv-native_duplicate",
      ownerId: OWNER_ID,
      type: "web_service",
    },
  ];
  const provider = createProvider({ services });
  await assert.rejects(
    syncRenderRuntimeSecrets({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 2,
    }),
    /render_service_resolution_failed/,
  );
  assert.equal(provider.putCount, 0);
});

test("duplicate env keys on a later page fail before the atomic save", async () => {
  const provider = createProvider({
    directEnv: [
      { key: "FIRST", value: "one" },
      { key: "SECOND", value: "two" },
      { key: "FIRST", value: "rogue-duplicate" },
    ],
  });
  await assert.rejects(
    syncRenderRuntimeSecrets({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 2,
    }),
    /render_environment_duplicate_key/,
  );
  assert.equal(provider.putCount, 0);
});

test("all, ClickHouse, and missing required candidates fail before discovery", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse([]);
  };
  for (const target of ["all", "axel-clickhouse", "delivery-service"]) {
    await assert.rejects(
      syncRenderRuntimeSecrets({
        env: { ...BASE_ENV, RENDER_SERVICE_NAME: target },
        fetchImpl,
        log: () => {},
      }),
      /render_target_service_invalid/,
    );
  }
  const missing = { ...BASE_ENV };
  delete missing.CREDENTIALS_MASTER_KEY;
  await assert.rejects(
    syncRenderRuntimeSecrets({ env: missing, fetchImpl, log: () => {} }),
    /missing_required_environment:CREDENTIALS_MASTER_KEY/,
  );
  for (const ownerId of [undefined, "org-not-a-render-workspace", "tea-"]) {
    const env = { ...BASE_ENV };
    if (ownerId === undefined) delete env.RENDER_OWNER_ID;
    else env.RENDER_OWNER_ID = ownerId;
    await assert.rejects(
      syncRenderRuntimeSecrets({ env, fetchImpl, log: () => {} }),
      /missing_required_environment:RENDER_OWNER_ID|render_owner_id_invalid/,
    );
  }
  assert.equal(calls, 0);
});

test("provider failures have fixed diagnostics and never trigger a deploy", async () => {
  const provider = createProvider({
    pageLimit: 100,
    onCall({ url, method }) {
      if (method === "PUT") {
        return new Response(`provider echoed ${API_KEY} ${SENTINELS.DELIVERY_SHARED_SECRET}`, {
          status: 500,
        });
      }
      if (url.pathname.includes("/deploys")) throw new Error("deploy must never be requested");
      return undefined;
    },
  });
  let caught;
  try {
    await syncRenderRuntimeSecrets({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 100,
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_http_error");
  assertSensitiveValuesAbsent(caught?.stack);
  assert.equal(provider.calls.some((call) => call.url.pathname.includes("/deploys")), false);
});

test("a mismatched readback fails closed with no secret disclosure", async () => {
  let putSeen = false;
  const provider = createProvider({
    pageLimit: 100,
    onCall({ url, method }) {
      if (method === "PUT") putSeen = true;
      if (putSeen && method === "GET" && url.pathname.endsWith("/env-vars")) {
        return jsonResponse([
          {
            cursor: "verification-1",
            envVar: { key: "CREDENTIALS_MASTER_KEY", value: "provider-corrupted-value" },
          },
        ]);
      }
      return undefined;
    },
  });
  let caught;
  try {
    await syncRenderRuntimeSecrets({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 100,
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_environment_verification_failed");
  assertSensitiveValuesAbsent(caught?.stack);
});
