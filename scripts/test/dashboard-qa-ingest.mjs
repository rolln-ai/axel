import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/**
 * Real ingest handler and authenticated admin endpoints, using the existing
 * direct-Postgres development profile. Only R2/Queues are replaced with local
 * memory. No auth code is mocked or bypassed; credentials come from the same
 * disposable database as the dashboard. Never accepts a production database.
 */
export async function startDashboardQaIngest(databaseUrl, masterKey) {
  const database = new URL(databaseUrl);
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.username, "postgres");
  database.hostname = "localhost"; // The development PG adapter's loopback SSL exception.
  const { default: worker } = await import("../../apps/ingest-worker/src/index.ts");
  const adminToken = randomBytes(32).toString("hex");
  const objects = new Map();
  const messages = [];
  const { startDashboardQaDelivery } = await import("./dashboard-qa-delivery.mjs");
  const delivery = await startDashboardQaDelivery(databaseUrl, objects, messages, masterKey);
  const background = new Set();
  const env = {
    DEV_MODE: "true",
    DATABASE_URL: database.toString(),
    ADMIN_TOKEN: adminToken,
    EVENTS_RAW: {
      async put(key, body, options) {
        objects.set(key, { body, customMetadata: options?.customMetadata });
        return { key };
      },
      async head(key) { return objects.get(key) ?? null; },
    },
  };
  for (let i = 0; i < 16; i++) {
    env[`QUEUE_EVENTS_${String(i).padStart(2, "0")}`] = {
      async send(message) { messages.push(message); },
    };
  }
  const ctx = { waitUntil(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise));
  } };
  let origin;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      if (incoming.method === "POST" && incoming.url === "/__qa/drain") {
        assert.equal(incoming.headers.authorization, `Bearer ${adminToken}`);
        const { workspaceId } = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(typeof workspaceId, "string");
        const result = await delivery.drain(workspaceId);
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(result));
        return;
      }
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method,
        headers: incoming.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await worker.fetch(request, env, ctx);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end("QA ingest request failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  // A missing/wrong admin credential must fail before the dashboard uses it.
  const rejected = await fetch(`${origin}/admin/source-authority/fence`, {
    method: "POST", body: "{}",
  });
  assert.equal(rejected.status, 401);
  await rejected.body?.cancel();
  return {
    origin,
    adminToken,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled(background);
      await delivery.close();
      objects.clear();
      messages.length = 0;
    },
  };
}
