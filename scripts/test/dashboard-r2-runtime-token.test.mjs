import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardR2PublicErrorCode,
  runDashboardR2TokenCli,
  runDashboardR2TokenCommand,
  runDashboardR2TokenForVercelBuild,
  verifyDashboardR2Configuration,
  verifyDashboardR2Token,
} from "../verify-dashboard-r2-token.mjs";

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "dashboard-r2-secret-never-log";
const BASE_ENV = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_R2_API_TOKEN: TOKEN,
  RAW_PAYLOAD_BUCKET: "axel-events-raw",
};

function successfulFetch(requests, overrides = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({
      url,
      method,
      authorizationMatches: init.headers?.authorization === `Bearer ${TOKEN}`,
    });
    if (url.includes("/r2/buckets/")) {
      if (method === "GET") return new Response("axel-dashboard-r2-token-probe-v1");
      return new Response(null, { status: method === "DELETE" ? 204 : 200 });
    }
    if (url.includes("/queues")) {
      return overrides.queue ?? new Response(null, { status: 403 });
    }
    if (url.endsWith("/settings")) {
      return overrides.workerSettings ?? new Response(null, { status: 403 });
    }
    if (url.includes("/workers/scripts")) {
      return overrides.workers ?? new Response(null, { status: 403 });
    }
    throw new Error("unexpected request");
  };
}

test("dashboard token proves R2 access and rejects Queue and Worker access", async () => {
  const requests = [];
  const logs = [];
  await verifyDashboardR2Token({
    env: BASE_ENV,
    apiBase: "https://cloudflare.example.test/client/v4",
    fetchImpl: successfulFetch(requests),
    log: (line) => logs.push(line),
  });

  assert.deepEqual(requests.map(({ method }) => method), ["PUT", "GET", "GET", "GET", "GET", "DELETE"]);
  assert.ok(requests.every(({ authorizationMatches }) => authorizationMatches));
  assert.deepEqual(logs, ["dashboard Cloudflare token verified for R2 runtime access only"]);
  assert.doesNotMatch(JSON.stringify({ requests, logs }), new RegExp(TOKEN));
});

test("dashboard token rejects a legacy provisioning variable before network access", async () => {
  let called = false;
  await assert.rejects(
    verifyDashboardR2Token({
      env: { ...BASE_ENV, CLOUDFLARE_API_TOKEN: "provisioning-secret-never-log" },
      fetchImpl: async () => {
        called = true;
        return new Response();
      },
    }),
    /legacy_cloudflare_api_token_present_in_dashboard_runtime/,
  );
  assert.equal(called, false);
});

test("dashboard configuration accepts Vercel's opaque Sensitive marker without network access", async () => {
  const env = { ...BASE_ENV, CLOUDFLARE_R2_API_TOKEN: "(Sensitive)" };
  assert.deepEqual(verifyDashboardR2Configuration(env), {
    account: ACCOUNT_ID,
    bucket: "axel-events-raw",
    token: "(Sensitive)",
  });

  const logs = [];
  const exitCode = await runDashboardR2TokenCli({
    envFile: "ignored.env",
    loadEnvFile: () => {},
    env,
    configurationOnly: true,
    fetchImpl: async () => {
      throw new Error("configuration-only verification made a network request");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(logs, ["dashboard Cloudflare token configuration verified"]);
});

test("Vercel build probes only the production trust boundary", async () => {
  const previewLogs = [];
  const previewCode = await runDashboardR2TokenForVercelBuild({
    env: { VERCEL_ENV: "preview" },
    fetchImpl: async () => {
      throw new Error("preview build made a network request");
    },
    log: (line) => previewLogs.push(line),
  });
  assert.equal(previewCode, 0);
  assert.deepEqual(previewLogs, [
    "dashboard Cloudflare token verification skipped outside Vercel production",
  ]);

  const requests = [];
  const productionLogs = [];
  const productionCode = await runDashboardR2TokenForVercelBuild({
    env: { ...BASE_ENV, VERCEL_ENV: "production" },
    apiBase: "https://cloudflare.example.test/client/v4",
    fetchImpl: successfulFetch(requests),
    log: (line) => productionLogs.push(line),
  });
  assert.equal(productionCode, 0);
  assert.deepEqual(requests.map(({ method }) => method), ["PUT", "GET", "GET", "GET", "GET", "DELETE"]);
  assert.deepEqual(productionLogs, [
    "dashboard Cloudflare token verified for R2 runtime access only",
  ]);
});

test("Vercel build fails closed for missing or unknown environment identity", async () => {
  for (const env of [{}, { VERCEL_ENV: "staging" }]) {
    const errors = [];
    const exitCode = await runDashboardR2TokenForVercelBuild({
      env,
      errorLog: (line) => errors.push(line),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(errors, [
      "dashboard Cloudflare token verification failed: "
      + "invalid_vercel_environment_for_dashboard_r2_verification",
    ]);
  }
});

test("dashboard verifier command dispatches the hosted production probe", async () => {
  const requests = [];
  const logs = [];
  const exitCode = await runDashboardR2TokenCommand({
    argv: ["--runtime-if-production"],
    env: { ...BASE_ENV, VERCEL_ENV: "production" },
    apiBase: "https://cloudflare.example.test/client/v4",
    fetchImpl: successfulFetch(requests),
    log: (line) => logs.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(requests.map(({ method }) => method), ["PUT", "GET", "GET", "GET", "GET", "DELETE"]);
  assert.deepEqual(logs, [
    "dashboard Cloudflare token verified for R2 runtime access only",
  ]);
});

test("dashboard token fails closed when Queue access is present and still cleans up", async () => {
  const requests = [];
  await assert.rejects(
    verifyDashboardR2Token({
      env: BASE_ENV,
      apiBase: "https://cloudflare.example.test/client/v4",
      fetchImpl: successfulFetch(requests, {
        queue: new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }),
      }),
    }),
    /cloudflare_dashboard_r2_token_queue_permission_present/,
  );
  assert.equal(requests.at(-1)?.method, "DELETE");
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(TOKEN));
});

test("dashboard token fails closed when Worker Scripts access is present", async () => {
  const requests = [];
  await assert.rejects(
    verifyDashboardR2Token({
      env: BASE_ENV,
      apiBase: "https://cloudflare.example.test/client/v4",
      fetchImpl: successfulFetch(requests, {
        workers: Response.json({ success: true, result: [{ id: "visible-worker" }], errors: [] }),
      }),
    }),
    /cloudflare_dashboard_r2_token_workers_scripts_permission_present/,
  );
  assert.equal(requests.at(-1)?.method, "DELETE");
});

test("dashboard token CLI never emits a provider body-reader exception", async () => {
  const providerSecret = "provider-body-reader-secret-never-log";
  const errors = [];
  const fetchImpl = async (input, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET" && String(input).includes("/r2/buckets/")) {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error(providerSecret);
        },
      };
    }
    return new Response(null, { status: method === "DELETE" ? 204 : 200 });
  };

  const exitCode = await runDashboardR2TokenCli({
    envFile: "ignored.env",
    loadEnvFile: () => {},
    env: BASE_ENV,
    apiBase: "https://cloudflare.example.test/client/v4",
    fetchImpl,
    log: () => {},
    errorLog: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, [
    "dashboard Cloudflare token verification failed: cloudflare_dashboard_r2_probe_read_failed",
  ]);
  assert.doesNotMatch(JSON.stringify(errors), new RegExp(providerSecret));
  assert.doesNotMatch(JSON.stringify(errors), new RegExp(TOKEN));
});

test("dashboard token hard-bounds a stalled R2 body and still cleans up", { timeout: 1_000 }, async () => {
  const methods = [];
  const fetchImpl = async (input, init = {}) => {
    const method = init.method ?? "GET";
    methods.push(method);
    if (method === "GET" && String(input).includes("/r2/buckets/")) {
      return {
        ok: true,
        status: 200,
        text: () => new Promise(() => {}),
      };
    }
    return new Response(null, { status: method === "DELETE" ? 204 : 200 });
  };

  await assert.rejects(
    verifyDashboardR2Token({
      env: BASE_ENV,
      apiBase: "https://cloudflare.example.test/client/v4",
      fetchImpl,
      log: () => {},
      requestTimeoutMs: 20,
    }),
    { message: "cloudflare_dashboard_r2_probe_read_failed" },
  );
  assert.deepEqual(methods, ["PUT", "GET", "DELETE"]);
});

test("dashboard token CLI collapses arbitrary exception messages", () => {
  assert.equal(
    dashboardR2PublicErrorCode(new Error("provider-secret-never-log")),
    "cloudflare_dashboard_r2_token_probe_failed",
  );
});

const EMPTY_WORKER_LIST = { success: true, result: [], errors: [] };

test("R2-only token accepts a filtered empty Worker list plus explicit settings denial", async () => {
  const requests = [];
  await verifyDashboardR2Token({
    env: BASE_ENV,
    fetchImpl: successfulFetch(requests, { workers: Response.json(EMPTY_WORKER_LIST) }),
    log: () => {},
  });
  assert.match(requests.at(-2).url, /\/workers\/scripts\/axel-r2-denial-[a-f0-9-]+\/settings$/);
  assert.equal(requests.at(-2).method, "GET");
  assert.equal(requests.at(-1).method, "DELETE");
});

test("empty Worker lists never bypass the settings authorization check", async () => {
  for (const status of [200, 204, 302, 404, 429, 500]) {
    const requests = [];
    await assert.rejects(verifyDashboardR2Token({
      env: BASE_ENV,
      fetchImpl: successfulFetch(requests, {
        workers: Response.json(EMPTY_WORKER_LIST),
        workerSettings: new Response(null, { status }),
      }),
    }), /cloudflare_dashboard_r2_(token_workers_scripts_permission_present|workers_scripts_denial_probe_http_)/);
    assert.equal(requests.at(-1).method, "DELETE");
  }
});

test("ambiguous Worker list envelopes fail closed without leaking response data", async () => {
  const secret = "provider-secret-never-log";
  for (const value of [null, {}, {success: false, result: [], errors: []},
    {success: true, result: []}, {success: true, result: {}, errors: []},
    {...EMPTY_WORKER_LIST, errors: [{message: secret}]},
    {...EMPTY_WORKER_LIST, padding: secret.repeat(2000)},
  ]) {
    const requests = [];
    const errors = [];
    const code = await runDashboardR2TokenCli({
      envFile: "ignored.env", loadEnvFile: () => {}, env: BASE_ENV,
      fetchImpl: successfulFetch(requests, {workers: Response.json(value)}),
      errorLog: line => errors.push(line),
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, ["dashboard Cloudflare token verification failed: cloudflare_dashboard_r2_workers_list_probe_invalid"]);
    assert.equal(requests.at(-1).method, "DELETE");
    assert.doesNotMatch(JSON.stringify(errors), new RegExp(secret));
  }
});

test("stalled Worker list bodies time out, cancel, and clean up R2", {timeout: 1000}, async () => {
  let cancelled = false;
  const requests = [];
  const body = new ReadableStream({cancel() { cancelled = true; }});
  await assert.rejects(verifyDashboardR2Token({
    env: BASE_ENV, requestTimeoutMs: 20,
    fetchImpl: successfulFetch(requests, {workers: new Response(body)}),
  }), {message: "cloudflare_dashboard_r2_workers_list_probe_invalid"});
  assert.equal(cancelled, true);
  assert.equal(requests.at(-1).method, "DELETE");
});
