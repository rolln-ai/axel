import { CliApiError, makeClient } from "../api-client.js";
import { readConfig } from "../config.js";

interface EventPayloadResponse {
  event_id: string;
  source_id: string;
  received_at: string;
  content_type: string;
  body_base64: string;
  headers: Record<string, string>;
}

/**
 * `axel replay <event_id> --forward-to <url> [--method POST]`
 *
 * Pulls the raw payload Axel persisted for `event_id` from R2 (via
 * delivery-service `/v1/cli/events/:id/payload`) and POSTs it to the
 * operator-supplied URL. Provider signature headers are stripped by
 * default — the original signed timestamp is stale and the local
 * handler will reject the replay otherwise. Pass --keep-signature to
 * forward them anyway.
 */
export async function replayCommand(
  eventId: string,
  flags: Record<string, string>,
): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.error("Not signed in. Run `axel auth login`.");
    process.exitCode = 1;
    return;
  }

  const forwardTo = flags["forward-to"];
  if (!forwardTo) {
    console.error("Missing --forward-to <url>. Example: --forward-to http://localhost:3000/webhooks");
    process.exitCode = 64;
    return;
  }
  const method = (flags.method ?? "POST").toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
    console.error(`--method ${method} is not supported. Use POST | PUT | PATCH.`);
    process.exitCode = 64;
    return;
  }
  const keepSignature = flags["keep-signature"] === "true";

  let event: EventPayloadResponse;
  try {
    event = await makeClient(config).get<EventPayloadResponse>(
      `/v1/cli/events/${encodeURIComponent(eventId)}/payload`,
    );
  } catch (err: unknown) {
    if (err instanceof CliApiError) {
      console.error(`Replay fetch failed (${err.status} ${err.code}): ${err.message}`);
    } else {
      console.error(`Replay fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  const body = Buffer.from(event.body_base64, "base64");
  const headers = sanitizeHeaders(event.headers, keepSignature);
  headers["content-type"] = event.content_type;
  headers["x-axel-replay-event-id"] = event.event_id;
  headers["x-axel-replay-source-id"] = event.source_id;

  const started = Date.now();
  const res = await fetch(forwardTo, { method, headers, body });
  const took = Date.now() - started;
  const text = await res.text().catch(() => "");
  const status = res.status;
  const statusOk = status >= 200 && status < 300;
  console.log(`${method} ${forwardTo} → ${status} (${took}ms)`);
  if (text.length > 0) {
    const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
    console.log(preview);
  }
  if (!statusOk) {
    process.exitCode = 1;
  }
}

function sanitizeHeaders(
  headers: Record<string, string>,
  keepSignature: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set<string>(["host", "content-length", "connection"]);
  if (!keepSignature) {
    skip.add("stripe-signature");
    skip.add("x-hub-signature");
    skip.add("x-hub-signature-256");
    skip.add("x-shopify-hmac-sha256");
    skip.add("x-axel-signature");
  }
  for (const [k, v] of Object.entries(headers)) {
    if (skip.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
