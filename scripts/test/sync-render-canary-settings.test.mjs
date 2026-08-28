import assert from "node:assert/strict";
import test from "node:test";
import {
  MANAGED_CANARY_KEYS,
  renderCanarySyncFailureCode,
  syncRenderCanarySettings,
} from "../sync-render-canary-settings.mjs";

const API_KEY = "render-api-token-sensitive";
const SERVICE_ID = "srv-aaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = "tea-bbbbbbbbbbbbbbbbbbbb";
const BLUEPRINT_ID = "exs-cccccccccccccccccccc";
const CANARY = Object.freeze({
  AXEL_CANARY_ENABLED: "1",
  AXEL_CANARY_INTERVAL_MS: "900000",
  AXEL_CANARY_INGEST_URL: "https://ingest.axelapp.ai/in/src_delivery_canary",
  AXEL_CANARY_INGEST_AUTH_HEADER: "x-axel-token",
  AXEL_CANARY_INGEST_AUTH_VALUE: "axt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  AXEL_CANARY_RECEIPT_URL:
    "https://app.axelapp.ai/api/ops/delivery-canary/receipt?probe={probe_id}",
  AXEL_CANARY_RECEIPT_AUTH_HEADER: "x-axel-canary-token",
  AXEL_CANARY_RECEIPT_AUTH_VALUE: "receipt-auth-value-sensitive-1234567890",
});
const BASE_ENV = Object.freeze({
  RENDER_API_KEY: API_KEY,
  RENDER_OWNER_ID: OWNER_ID,
  RENDER_DELIVERY_WORKERS_SERVICE_ID: SERVICE_ID,
  RENDER_DELIVERY_WORKERS_BLUEPRINT_ID: BLUEPRINT_ID,
  ...CANARY,
});
const SERVICE = Object.freeze({
  id: SERVICE_ID,
  ownerId: OWNER_ID,
  name: "axel-delivery-workers",
  type: "background_worker",
  repo: "https://github.com/rolln-ai/axel",
  branch: "main",
  autoDeploy: "no",
  serviceDetails: {
    env: "node",
    numInstances: 1,
  },
});
const BLUEPRINT = Object.freeze({
  id: BLUEPRINT_ID,
  autoSync: false,
  status: "paused",
  repo: "https://github.com/rolln-ai/axel",
  branch: "main",
  path: "render.yaml",
  resources: [
    {
      id: SERVICE_ID,
      name: "axel-delivery-workers",
      type: "background_worker",
    },
  ],
});
const SENTRY_DSN_VALUE = "https://sentry-public@example.invalid/1";
const WORKER_PREREQUISITES = Object.freeze([
  { key: "DELIVERY_ROLE", value: "worker" },
  { key: "SENTRY_ENVIRONMENT", value: "production" },
  { key: "SENTRY_DSN", value: SENTRY_DSN_VALUE },
]);
const SENSITIVE_UNRELATED = Object.freeze({
  DATABASE_URL: "postgresql://database-sensitive",
  CLICKHOUSE_URL: "https://clickhouse-sensitive.invalid:8443",
  CLICKHOUSE_PASSWORD: "clickhouse-password-sensitive",
  CLOUDFLARE_API_TOKEN: "cloudflare-token-sensitive",
  DELIVERY_SHARED_SECRET: "delivery-secret-sensitive",
  CREDENTIALS_MASTER_KEY: "master-key-sensitive",
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envPage(items, cursor, pageLimit) {
  const offset = cursor === null ? 0 : Number.parseInt(cursor.slice("environment-".length), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("bad test cursor");
  return items.slice(offset, offset + pageLimit).map((envVar, index) => ({
    cursor: `environment-${offset + index + 1}`,
    envVar,
  }));
}

function createProvider(options = {}) {
  const pageLimit = options.pageLimit ?? 100;
  const service = options.service ?? structuredClone(SERVICE);
  const blueprint = options.blueprint ?? structuredClone(BLUEPRINT);
  let directEnv = structuredClone(
    options.directEnv ?? [
      ...WORKER_PREREQUISITES,
      { key: "UNRELATED_EXISTING", value: "preserve-me" },
    ],
  );
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

    if (method === "GET" && url.pathname === `/v1/services/${SERVICE_ID}`) {
      return jsonResponse(service);
    }
    if (method === "GET" && url.pathname === `/v1/blueprints/${BLUEPRINT_ID}`) {
      return jsonResponse(blueprint);
    }
    if (url.pathname === `/v1/services/${SERVICE_ID}/env-vars`) {
      if (method === "GET") {
        return jsonResponse(
          envPage(directEnv, url.searchParams.get("cursor"), pageLimit),
        );
      }
      if (method === "PUT") {
        putCount += 1;
        directEnv = JSON.parse(init.body);
        return jsonResponse([]);
      }
    }
    throw new Error(`unexpected provider request ${method} ${url.pathname}`);
  };

  return {
    calls,
    fetchImpl,
    get directEnv() {
      return directEnv;
    },
    get putCount() {
      return putCount;
    },
  };
}

function mapOf(entries) {
  return new Map(entries.map(({ key, value }) => [key, value]));
}

function assertSensitiveValuesAbsent(value) {
  const text = String(value);
  for (const secret of [
    API_KEY,
    CANARY.AXEL_CANARY_INGEST_AUTH_VALUE,
    CANARY.AXEL_CANARY_RECEIPT_AUTH_VALUE,
    SENTRY_DSN_VALUE,
    ...Object.values(SENSITIVE_UNRELATED),
  ]) {
    assert.equal(text.includes(secret), false, "sensitive value escaped into diagnostics");
  }
}

test("targets one immutable worker and changes only the eight canary settings", async () => {
  const previousCanary = MANAGED_CANARY_KEYS.map((key) => ({
    key,
    value: `stale-${key.toLowerCase()}`,
  }));
  const unrelated = Object.entries(SENSITIVE_UNRELATED).map(([key, value]) => ({ key, value }));
  const provider = createProvider({
    pageLimit: 3,
    directEnv: [
      ...WORKER_PREREQUISITES,
      { key: "UNRELATED_EXISTING", value: "preserve-me" },
      ...unrelated,
      ...previousCanary,
    ],
  });
  const logs = [];

  await syncRenderCanarySettings({
    env: BASE_ENV,
    fetchImpl: provider.fetchImpl,
    log: (line) => logs.push(line),
    pageLimit: 3,
  });

  assert.equal(provider.putCount, 1);
  assert.equal(provider.calls[0].url.pathname, `/v1/services/${SERVICE_ID}`);
  assert.equal(provider.calls.some((call) => call.url.pathname === "/v1/services"), false);
  assert.equal(provider.calls.some((call) => call.url.pathname.includes("/deploys")), false);
  const putIndex = provider.calls.findIndex((call) => call.method === "PUT");
  const put = provider.calls[putIndex];
  assert.equal(put.url.pathname, `/v1/services/${SERVICE_ID}/env-vars`);
  assert.equal(put.url.origin, "https://api.render.com");
  assert.equal(put.init.redirect, "error");
  assert.equal(put.init.headers.authorization, `Bearer ${API_KEY}`);
  assert.ok(
    provider.calls.slice(0, putIndex).some((call) => call.url.searchParams.has("cursor")),
    "the complete current environment must be read before replacement",
  );
  assert.ok(
    provider.calls.slice(putIndex + 1).some((call) => call.method === "GET"),
    "the complete replacement must be read back",
  );

  const saved = mapOf(JSON.parse(put.init.body));
  for (const [key, value] of Object.entries(SENSITIVE_UNRELATED)) {
    assert.equal(saved.get(key), value, `${key} is preserved byte-for-byte`);
  }
  assert.equal(saved.get("UNRELATED_EXISTING"), "preserve-me");
  for (const { key, value } of WORKER_PREREQUISITES) assert.equal(saved.get(key), value);
  for (const key of MANAGED_CANARY_KEYS) assert.equal(saved.get(key), CANARY[key]);
  const initial = mapOf([
    ...WORKER_PREREQUISITES,
    { key: "UNRELATED_EXISTING", value: "preserve-me" },
    ...unrelated,
    ...previousCanary,
  ]);
  const changedKeys = [...saved]
    .filter(([key, value]) => initial.get(key) !== value)
    .map(([key]) => key)
    .sort();
  assert.deepEqual(changedKeys, [...MANAGED_CANARY_KEYS].sort());
  assert.deepEqual(logs, [
    "Saved eight canary settings on the verified delivery worker without deploying.",
  ]);
  assertSensitiveValuesAbsent(logs);
});

test("verifies the required Blueprint identity and exact worker membership", async () => {
  const provider = createProvider();
  await syncRenderCanarySettings({
    env: BASE_ENV,
    fetchImpl: provider.fetchImpl,
    log: () => {},
  });

  assert.equal(provider.putCount, 1);
  assert.deepEqual(
    provider.calls.slice(0, 2).map((call) => call.url.pathname),
    [`/v1/services/${SERVICE_ID}`, `/v1/blueprints/${BLUEPRINT_ID}`],
  );
});

test("requires exact owner, service name, type, repository, branch, runtime, and singleton state", async () => {
  const patches = [
    { id: "srv-dddddddddddddddddddd" },
    { ownerId: "tea-dddddddddddddddddddd" },
    { name: "axel-delivery-native" },
    { type: "web_service" },
    { repo: "https://github.com/attacker/axel" },
    { branch: "feature/canary" },
    { autoDeploy: "yes" },
    { serviceDetails: { env: "docker", numInstances: 1 } },
    { serviceDetails: { env: "node", numInstances: 2 } },
  ];

  for (const patch of patches) {
    const provider = createProvider({ service: { ...structuredClone(SERVICE), ...patch } });
    await assert.rejects(
      syncRenderCanarySettings({
        env: BASE_ENV,
        fetchImpl: provider.fetchImpl,
        log: () => {},
      }),
      /render_service_metadata_mismatch/,
    );
    assert.equal(provider.putCount, 0);
  }
});

test("accepts documented repository encodings but rejects conflicting flattened metadata", async () => {
  for (const repo of [
    "https://github.com/rolln-ai/axel.git",
    "git@github.com:rolln-ai/axel.git",
    "ssh://git@github.com/rolln-ai/axel",
  ]) {
    const provider = createProvider({ service: { ...structuredClone(SERVICE), repo } });
    await syncRenderCanarySettings({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
    });
    assert.equal(provider.putCount, 1);
  }

  const conflicting = createProvider({
    service: { ...structuredClone(SERVICE), env: "docker" },
  });
  await assert.rejects(
    syncRenderCanarySettings({
      env: BASE_ENV,
      fetchImpl: conflicting.fetchImpl,
      log: () => {},
    }),
    /render_service_metadata_mismatch/,
  );
  assert.equal(conflicting.putCount, 0);
});

test("Blueprint metadata or membership drift fails before mutation", async () => {
  const blueprints = [
    { ...structuredClone(BLUEPRINT), id: "exs-dddddddddddddddddddd" },
    { ...structuredClone(BLUEPRINT), repo: "https://github.com/attacker/axel" },
    { ...structuredClone(BLUEPRINT), branch: "feature/canary" },
    { ...structuredClone(BLUEPRINT), path: "infra/render.yaml" },
    { ...structuredClone(BLUEPRINT), autoSync: true },
    { ...structuredClone(BLUEPRINT), status: "in_sync" },
    { ...structuredClone(BLUEPRINT), status: "syncing" },
    { ...structuredClone(BLUEPRINT), status: "error" },
    { ...structuredClone(BLUEPRINT), ownerId: "tea-dddddddddddddddddddd" },
    { ...structuredClone(BLUEPRINT), resources: [] },
    {
      ...structuredClone(BLUEPRINT),
      resources: [{ id: SERVICE_ID, name: "wrong-worker", type: "background_worker" }],
    },
  ];
  for (const blueprint of blueprints) {
    const provider = createProvider({ blueprint });
    await assert.rejects(
      syncRenderCanarySettings({
        env: BASE_ENV,
        fetchImpl: provider.fetchImpl,
        log: () => {},
      }),
      /render_blueprint_metadata_mismatch/,
    );
    assert.equal(provider.putCount, 0);
  }
});

test("worker role and Sentry monitor prerequisites are required before mutation", async () => {
  const variants = [
    WORKER_PREREQUISITES.filter(({ key }) => key !== "DELIVERY_ROLE"),
    WORKER_PREREQUISITES.map((entry) =>
      entry.key === "DELIVERY_ROLE" ? { ...entry, value: "web" } : entry
    ),
    WORKER_PREREQUISITES.map((entry) =>
      entry.key === "SENTRY_ENVIRONMENT" ? { ...entry, value: "staging" } : entry
    ),
    WORKER_PREREQUISITES.map((entry) =>
      entry.key === "SENTRY_DSN" ? { ...entry, value: "" } : entry
    ),
  ];
  for (const directEnv of variants) {
    const provider = createProvider({ directEnv });
    await assert.rejects(
      syncRenderCanarySettings({
        env: BASE_ENV,
        fetchImpl: provider.fetchImpl,
        log: () => {},
      }),
      /render_worker_runtime_prerequisite_missing/,
    );
    assert.equal(provider.putCount, 0);
  }
});

test("invalid identifiers and incomplete canary candidates fail before provider access", async () => {
  const cases = [
    [{ ...BASE_ENV, RENDER_DELIVERY_WORKERS_SERVICE_ID: "srv-not-an-id" }, /render_service_id_invalid/],
    [{ ...BASE_ENV, RENDER_OWNER_ID: "tea-not-an-id" }, /render_owner_id_invalid/],
    [
      { ...BASE_ENV, RENDER_DELIVERY_WORKERS_BLUEPRINT_ID: "exs-not-an-id" },
      /render_blueprint_id_invalid/,
    ],
    [{ ...BASE_ENV, AXEL_CANARY_INTERVAL_MS: "60000" }, /canary_interval_value_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_INGEST_URL: "http://ingest.invalid" }, /canary_ingest_url_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_INGEST_URL: "https://attacker.invalid/ingest" }, /canary_ingest_url_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_INGEST_AUTH_HEADER: "x_invalid" }, /canary_ingest_header_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_INGEST_AUTH_HEADER: "authorization" }, /canary_ingest_header_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_INGEST_AUTH_VALUE: "not-an-axel-source-token" }, /canary_ingest_auth_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_RECEIPT_URL: "https://dashboard.invalid/receipt" }, /canary_receipt_url_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_RECEIPT_AUTH_HEADER: "authorization" }, /canary_receipt_header_invalid/],
    [{ ...BASE_ENV, AXEL_CANARY_RECEIPT_AUTH_VALUE: "too-short" }, /canary_receipt_auth_invalid/],
    [
      {
        ...BASE_ENV,
        AXEL_CANARY_RECEIPT_AUTH_VALUE: CANARY.AXEL_CANARY_INGEST_AUTH_VALUE,
      },
      /canary_auth_values_must_differ/,
    ],
  ];
  const missing = { ...BASE_ENV };
  delete missing.AXEL_CANARY_INGEST_AUTH_VALUE;
  cases.push([missing, /missing_required_environment:AXEL_CANARY_INGEST_AUTH_VALUE/]);
  const missingBlueprint = { ...BASE_ENV };
  delete missingBlueprint.RENDER_DELIVERY_WORKERS_BLUEPRINT_ID;
  cases.push([
    missingBlueprint,
    /missing_required_environment:RENDER_DELIVERY_WORKERS_BLUEPRINT_ID/,
  ]);

  for (const [env, error] of cases) {
    let calls = 0;
    await assert.rejects(
      syncRenderCanarySettings({
        env,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({});
        },
        log: () => {},
      }),
      error,
    );
    assert.equal(calls, 0);
  }
});

test("duplicate direct environment keys fail before the bulk replacement", async () => {
  const provider = createProvider({
    pageLimit: 2,
    directEnv: [
      { key: "FIRST", value: "one" },
      { key: "SECOND", value: "two" },
      { key: "FIRST", value: "rogue-duplicate" },
    ],
  });
  await assert.rejects(
    syncRenderCanarySettings({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
      pageLimit: 2,
    }),
    /render_environment_duplicate_key/,
  );
  assert.equal(provider.putCount, 0);
});

test("provider failures use fixed diagnostics and never request a deploy", async () => {
  const provider = createProvider({
    onCall({ method }) {
      if (method === "PUT") {
        return new Response(
          `provider echoed ${API_KEY} ${CANARY.AXEL_CANARY_INGEST_AUTH_VALUE}`,
          { status: 500 },
        );
      }
      return undefined;
    },
  });
  let caught;
  try {
    await syncRenderCanarySettings({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_api_http_error");
  assert.equal(renderCanarySyncFailureCode(caught), "render_api_http_error");
  assert.equal(
    renderCanarySyncFailureCode(new Error(`provider echoed ${API_KEY}`)),
    "unexpected_error",
  );
  assertSensitiveValuesAbsent(caught?.stack);
  assert.equal(provider.calls.some((call) => call.url.pathname.includes("/deploys")), false);
});

test("mismatched readback fails closed without a second mutation", async () => {
  let putSeen = false;
  const provider = createProvider({
    onCall({ url, method }) {
      if (method === "PUT") putSeen = true;
      if (putSeen && method === "GET" && url.pathname.endsWith("/env-vars")) {
        return jsonResponse([
          {
            cursor: "verification-1",
            envVar: { key: "UNRELATED_EXISTING", value: "provider-corrupted-value" },
          },
        ]);
      }
      return undefined;
    },
  });
  let caught;
  try {
    await syncRenderCanarySettings({
      env: BASE_ENV,
      fetchImpl: provider.fetchImpl,
      log: () => {},
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "render_environment_verification_failed");
  assert.equal(provider.putCount, 1);
  assertSensitiveValuesAbsent(caught?.stack);
});
