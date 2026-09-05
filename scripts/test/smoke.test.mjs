import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("production smoke distinguishes missing sources from the real auth boundary", async (t) => {
  for (const fixture of [
    { unknown: 404, unauthenticated: 401, success: true },
    { unknown: 401, unauthenticated: 401, success: true },
    { unknown: 202, unauthenticated: 401, success: false },
    { unknown: 503, unauthenticated: 401, success: false },
    { unknown: 404, unauthenticated: 202, success: false },
    { unknown: 404, unauthenticated: 404, success: false },
    { unknown: 404, unauthenticated: 503, success: false },
  ]) {
    await t.test(`unknown=${fixture.unknown}, unauthenticated=${fixture.unauthenticated}`, async () => {
      let probeId = "";
      let authenticatedRequests = 0;
      let anonymousRequests = 0;
      const server = http.createServer(async (request, response) => {
        if (request.url === "/in/__smoke__") {
          response.writeHead(fixture.unknown);
          response.end("response-secret-never-log");
        } else if (request.url === "/in/canary") {
          if (request.headers["x-axel-token"] !== "credential-never-log") {
            anonymousRequests += 1;
            assert.equal(request.headers["x-axel-token"], undefined);
            response.writeHead(fixture.unauthenticated);
            response.end("response-secret-never-log");
            return;
          }
          authenticatedRequests += 1;
          let body = "";
          for await (const chunk of request) body += chunk;
          probeId = JSON.parse(body).axel_canary_probe_id;
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ event_id: "evt_smoke_canary" }));
        } else if (request.url?.startsWith("/receipt")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ probe_id: probeId, received_at: new Date().toISOString() }));
        } else {
          response.writeHead(200);
          response.end("All systems operational");
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      try {
        const child = spawn("bash", ["scripts/smoke.sh"], {
          cwd: repoRoot,
          env: {
            PATH: process.env.PATH,
            AXEL_MARKETING_URL: origin,
            AXEL_APP_URL: origin,
            AXEL_INGEST_URL: origin,
            AXEL_DELIVERY_URL: origin,
            AXEL_REQUIRE_OPERATIONAL_STATUS: "1",
            AXEL_REQUIRE_DELIVERY_CANARY: "1",
            AXEL_CANARY_INGEST_URL: `${origin}/in/canary`,
            AXEL_CANARY_INGEST_AUTH_HEADER: "x-axel-token",
            AXEL_CANARY_INGEST_AUTH_VALUE: "credential-never-log",
            AXEL_CANARY_RECEIPT_URL: `${origin}/receipt?probe={probe_id}`,
            AXEL_CANARY_TIMEOUT_MS: "2000",
            AXEL_CANARY_POLL_INTERVAL_MS: "100",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code === 0, fixture.success, output);
        assert.equal(authenticatedRequests, fixture.success ? 1 : 0);
        if (fixture.success) {
          assert.equal(anonymousRequests, 1);
          assert.match(output, /ok ingest-auth-gate: 401/);
          assert.match(output, /canary delivered/);
        }
        assert.doesNotMatch(output, /(?:credential|response-secret)-never-log/);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});
