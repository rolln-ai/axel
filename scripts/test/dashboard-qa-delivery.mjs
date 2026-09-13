import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import pg from "pg";
import { createWebhookConnector } from "../../packages/connectors/src/index.ts";
import { credentialAadString, decryptCredentialV2, parseHexMasterKey, toArrayBuffer } from "../../packages/shared/src/index.ts";
import { processQueueMessage } from "../../apps/router/src/processor.ts";
import { processDeliveryMessage, createInMemoryIdempotencyStore } from "../../apps/delivery-worker/src/index.ts";
import { loadActiveRoutes } from "../../apps/delivery-service/src/route-store.ts";

/** Real routing/delivery code and a real HTTP receiver. Only the test connector's
 * transport maps receiver.example.test to loopback; production SSRF rules stay intact.
 * Queues, attempt logs, idempotency and object storage are local memory.
 */
export async function startDashboardQaDelivery(databaseUrl, objects, messages, masterKey) {
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const received = [];
  const retriedPaths = new Set();
  let origin;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let status = 204;
    if (request.url.includes("retry-once") && !retriedPaths.has(request.url)) {
      retriedPaths.add(request.url);
      status = 503;
    }
    received.push({ path: request.url, body, status, signature: request.headers["x-axel-signature"] });
    response.writeHead(status); response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const retries = [];
  const attempts = [];
  const eventOwners = new Map();
  const deps = {
    connectors: new Map([["webhook", createWebhookConnector(async (url, init) => {
      const target = new URL(url);
      assert.equal(target.hostname, "receiver.example.test");
      return fetch(new URL(target.pathname, origin), init);
    })]]),
    destinations: { async getDestination(workspaceId, destinationId) {
      const row = (await pool.query("SELECT id AS destination_id, workspace_id, type, config, status, credentials_ref FROM destinations WHERE workspace_id=$1 AND id=$2", [workspaceId, destinationId])).rows[0];
      if (row?.credentials_ref) {
        const credential = (await pool.query("SELECT ciphertext, nonce, auth_tag, encryption_version FROM destination_credentials WHERE id=$1 AND workspace_id=$2 AND destination_id=$3", [row.credentials_ref, workspaceId, destinationId])).rows[0];
        assert.ok(credential);
        const plaintext = await decryptCredentialV2(credential, parseHexMasterKey(masterKey), new TextEncoder().encode(credentialAadString(workspaceId, destinationId)));
        row.config = { ...row.config, ...JSON.parse(plaintext) };
      }
      return row ?? null;
    } },
    attempts: { recordAttempt(attempt) { attempts.push({ ...attempt, workspace_id: eventOwners.get(attempt.event_id) }); } },
    retries: { scheduleRetry(message) { retries.push(message); } },
    idempotency: createInMemoryIdempotencyStore(),
  };
  const router = {
    rawPayloads: { async get(key) { const value = objects.get(key); return value ? toArrayBuffer(new Uint8Array(value.body)) : null; } },
    routes: {
      listActiveBySource: (workspace, source) => loadActiveRoutes(pool, workspace, source),
      markErrored() { throw new Error("Synthetic route errored"); },
    },
    destinationQueue: { async enqueue(message) { await processDeliveryMessage(deps, message); } },
    deadLetter: { async push() { throw new Error("Synthetic route dead-lettered"); } },
  };
  let draining = Promise.resolve();
  return {
    async drain(workspaceId) {
      const work = draining.then(async () => {
        const pending = messages.filter(message => message.workspace_id === workspaceId);
        const pendingRetries = retries.filter(message => message.workspace_id === workspaceId);
        for (const message of pending) {
          eventOwners.set(message.event_id, message.workspace_id);
          await processQueueMessage(router, message);
          messages.splice(messages.indexOf(message), 1);
        }
        for (const message of pendingRetries) {
          await processDeliveryMessage(deps, message);
          retries.splice(retries.indexOf(message), 1);
        }
        return {
          attempts: attempts.filter(attempt => attempt.workspace_id === workspaceId),
          received: received.filter(entry => entry.path.startsWith(`/${workspaceId}/`)),
          retries: retries.filter(message => message.workspace_id === workspaceId).length,
        };
      });
      draining = work.catch(() => {});
      return work;
    },
    async close() {
      await draining;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await pool.end();
    },
  };
}
