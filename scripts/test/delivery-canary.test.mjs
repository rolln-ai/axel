import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runDeliveryCanary } from "../delivery-canary.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(new URL("../delivery-canary.mjs", import.meta.url));

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function run(env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("delivery canary proves accepted ingest reached the controlled destination", async () => {
  let probeId = "";
  let receiptPolls = 0;
  const { server, origin } = await listen(async (request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/ingest")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.deepEqual(Object.keys(payload).sort(), [
        "axel_canary_probe_id",
        "event_type",
        "expected_runtime",
        "sent_at",
      ]);
      assert.equal(payload.event_type, "axel.delivery_canary");
      assert.equal(payload.expected_runtime, "native");
      probeId = payload.axel_canary_probe_id;
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ event_id: "evt_canary_1" }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/receipt")) {
      receiptPolls += 1;
      assert.equal(request.headers.authorization, "Bearer header-secret-never-log");
      assert.equal(
        request.headers["x-vercel-protection-bypass"],
        "protection-secret-never-log",
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(receiptPolls >= 2
        ? JSON.stringify({ probe_id: probeId, received_at: new Date().toISOString() })
        : "[]");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const result = await run({
      AXEL_CANARY_INGEST_URL: `${origin}/ingest?token=ingest-secret-never-log`,
      AXEL_CANARY_RECEIPT_URL: `${origin}/receipt?probe={probe_id}&key=receipt-secret-never-log`,
      AXEL_CANARY_RECEIPT_AUTH_HEADER: "authorization",
      AXEL_CANARY_RECEIPT_AUTH_VALUE: "Bearer header-secret-never-log",
      AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_HEADER: "x-vercel-protection-bypass",
      AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_VALUE: "protection-secret-never-log",
      AXEL_CANARY_TIMEOUT_MS: "2000",
      AXEL_CANARY_POLL_INTERVAL_MS: "100",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /canary accepted/);
    assert.match(result.stdout, /canary delivered/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\b(?:probe|event)=/);
    assert.equal(result.stdout.includes(probeId), false);
    assert.equal(result.stdout.includes("evt_canary_1"), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-never-log/);
  } finally {
    await close(server);
  }
});

test("delivery canary rejects HTML and substring receipt false positives", async (t) => {
  const cases = [
    {
      name: "HTML containing the probe identifier",
      contentType: "text/html",
      body: (probeId) => `<html><body>${probeId}</body></html>`,
    },
    {
      name: "JSON containing the probe identifier as a substring",
      contentType: "application/json",
      body: (probeId) => JSON.stringify({
        probe_id: `prefix-${probeId}-suffix`,
        received_at: new Date().toISOString(),
      }),
    },
    {
      name: "an exact probe with an invalid receipt timestamp",
      contentType: "application/json",
      body: (probeId) => JSON.stringify({
        probe_id: probeId,
        received_at: "not-a-timestamp",
      }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let probeId = "";
      const { server, origin } = await listen(async (request, response) => {
        if (request.method === "POST") {
          let body = "";
          for await (const chunk of request) body += chunk;
          probeId = JSON.parse(body).axel_canary_probe_id;
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ event_id: "evt_false_positive_1" }));
          return;
        }
        response.writeHead(200, { "content-type": fixture.contentType });
        response.end(fixture.body(probeId));
      });

      try {
        const result = await run({
          AXEL_CANARY_INGEST_URL: `${origin}/ingest`,
          AXEL_CANARY_RECEIPT_URL: `${origin}/receipt?probe={probe_id}`,
          AXEL_CANARY_TIMEOUT_MS: "500",
          AXEL_CANARY_POLL_INTERVAL_MS: "100",
        });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /canary_delivery_divergence/);
      } finally {
        await close(server);
      }
    });
  }
});

test("delivery canary rejects colliding receipt authentication headers", async () => {
  const result = await run({
    AXEL_CANARY_INGEST_URL: "https://ingest.invalid/in/canary",
    AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/probe/{probe_id}",
    AXEL_CANARY_RECEIPT_AUTH_HEADER: "X-Axel-Canary-Token",
    AXEL_CANARY_RECEIPT_AUTH_VALUE: "receipt-secret-never-log",
    AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_HEADER: "x-axel-canary-token",
    AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_VALUE: "protection-secret-never-log",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /duplicate_credential_header:AXEL_CANARY_RECEIPT_PROTECTION_BYPASS/,
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-never-log/);

  const bypassOnly = await run({
    AXEL_CANARY_INGEST_URL: "https://ingest.invalid/in/canary",
    AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/probe/{probe_id}",
    AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_HEADER: "x-vercel-protection-bypass",
    AXEL_CANARY_RECEIPT_PROTECTION_BYPASS_VALUE: "protection-secret-never-log",
  });
  assert.equal(bypassOnly.code, 1);
  assert.match(bypassOnly.stderr, /receipt_protection_bypass_requires_receipt_auth/);
  assert.doesNotMatch(`${bypassOnly.stdout}${bypassOnly.stderr}`, /secret-never-log/);
});

test("delivery canary rejects reused credentials across trust boundaries", async () => {
  const result = await run({
    AXEL_CANARY_INGEST_URL: "https://ingest.invalid/in/canary",
    AXEL_CANARY_INGEST_AUTH_HEADER: "x-axel-token",
    AXEL_CANARY_INGEST_AUTH_VALUE: "shared-secret-never-log",
    AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/probe/{probe_id}",
    AXEL_CANARY_RECEIPT_AUTH_HEADER: "x-axel-canary-token",
    AXEL_CANARY_RECEIPT_AUTH_VALUE: "shared-secret-never-log",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /canary_credential_values_must_be_distinct/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /shared-secret-never-log/);
});

test("delivery canary fails on ingest and receipt divergence without printing credentials", async () => {
  const { server, origin } = await listen(async (request, response) => {
    if (request.method === "POST") {
      for await (const _ of request) {
        // Drain request body.
      }
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ event_id: "evt_diverged_1" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });

  try {
    const result = await run({
      AXEL_CANARY_INGEST_URL: `${origin}/ingest?token=divergence-secret-never-log`,
      AXEL_CANARY_RECEIPT_URL: `${origin}/receipt?probe={probe_id}`,
      AXEL_CANARY_TIMEOUT_MS: "500",
      AXEL_CANARY_POLL_INTERVAL_MS: "100",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /canary delivery divergence/);
    assert.match(result.stderr, /canary_delivery_divergence/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\b(?:probe|event)=/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /evt_diverged_1/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /divergence-secret-never-log/);
  } finally {
    await close(server);
  }
});

test("delivery canary bounds response bodies before parsing", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ event_id: "evt_oversized", padding: "x".repeat(70_000) }),
    {
      status: 202,
      headers: {
        "content-type": "application/json",
        "content-length": "70064",
      },
    },
  );

  await assert.rejects(
    runDeliveryCanary({
      env: {
        AXEL_CANARY_INGEST_URL: "https://ingest.invalid/canary",
        AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/{probe_id}",
      },
      fetchImpl,
      log: () => {},
      errorLog: () => {},
    }),
    /canary_ingest_response_invalid/,
  );
});

test("delivery canary aborts a stalled response-body read promptly", async () => {
  let bodyReadStarted;
  const started = new Promise((resolve) => {
    bodyReadStarted = resolve;
  });
  const body = new ReadableStream({
    pull() {
      bodyReadStarted();
      return new Promise(() => {});
    },
  });
  const fetchImpl = async () => new Response(body, {
    status: 202,
    headers: { "content-type": "application/json" },
  });
  const controller = new AbortController();
  const canary = runDeliveryCanary({
    env: {
      AXEL_CANARY_INGEST_URL: "https://ingest.invalid/canary",
      AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/{probe_id}",
    },
    fetchImpl,
    log: () => {},
    errorLog: () => {},
    signal: controller.signal,
  });

  await started;
  const abortStartedAt = Date.now();
  controller.abort();
  await assert.rejects(canary, /canary_aborted/);
  assert.ok(Date.now() - abortStartedAt < 500, "abort should not wait for the request timeout");
});

test("delivery canary cancels its receipt polling sleep promptly", async () => {
  let receiptRequested;
  const requested = new Promise((resolve) => {
    receiptRequested = resolve;
  });
  const fetchImpl = async (_input, init = {}) => {
    if (init.method === "POST") {
      return new Response(JSON.stringify({ event_id: "evt_sleep_abort" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    receiptRequested();
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const controller = new AbortController();
  const canary = runDeliveryCanary({
    env: {
      AXEL_CANARY_INGEST_URL: "https://ingest.invalid/canary",
      AXEL_CANARY_RECEIPT_URL: "https://receipt.invalid/{probe_id}",
      AXEL_CANARY_POLL_INTERVAL_MS: "60000",
    },
    fetchImpl,
    log: () => {},
    errorLog: () => {},
    signal: controller.signal,
  });

  await requested;
  await new Promise((resolve) => setImmediate(resolve));
  const abortStartedAt = Date.now();
  controller.abort();
  await assert.rejects(canary, /canary_aborted/);
  assert.ok(Date.now() - abortStartedAt < 500, "abort should not wait for the poll interval");
});
