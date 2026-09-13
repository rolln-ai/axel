import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/** A local Resend-compatible receiver. No message can leave the QA process. */
export async function startDashboardQaMailbox() {
  const key = `re_qa_${randomBytes(24).toString("hex")}`;
  const messages = [];
  let origin;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const url = new URL(request.url, origin);
      if (request.method === "POST" && url.pathname === "/emails") {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(size < 262144);
          chunks.push(chunk);
        }
        const message = JSON.parse(Buffer.concat(chunks).toString());
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        assert.ok(recipients.every(to => to.endsWith("@example.test")));
        messages.push({ ...message, to: recipients });
        assert.ok(messages.length < 100);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `qa-email-${messages.length}` }));
      } else if (request.method === "GET" && url.pathname === "/messages") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(messages.filter(message => message.to.includes(url.searchParams.get("to")))));
      } else {
        response.writeHead(404); response.end();
      }
    } catch {
      response.writeHead(400); response.end("Invalid synthetic mailbox request");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, key, async close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    messages.length = 0;
  } };
}
