import { CliApiError, makeClient } from "../api-client.js";
import { readConfig } from "../config.js";

interface PolledEvent {
  event_id: string;
  source_id: string;
  received_at: string;
  content_type: string;
  headers: Record<string, string>;
  body_base64: string;
}

interface PollResponse {
  events: PolledEvent[];
  truncated: boolean;
}

const POLL_INTERVAL_MS = 1000;
// Provider signature headers carry a stale timestamp by the time the
// CLI re-fires them. Strip by default so the operator's local handler
// doesn't 401 every replay.
const SIGNATURE_HEADERS = new Set<string>([
  "stripe-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-shopify-hmac-sha256",
  "x-axel-signature",
]);
const STRIP_HEADERS = new Set<string>(["host", "content-length", "connection"]);

/**
 * `axel listen --source <id> --forward-to <url> [--keep-signature]`
 *
 * Polls delivery-service `/v1/cli/events?source_id=<id>&since=<iso>`
 * once a second, forwards each new event to the operator's localhost
 * handler, and prints a one-line log entry per delivery.
 *
 * Phase 2 of AXE-26 — the WebSocket-tunnel design from the original
 * spec requires ingest-worker → delivery-service fanout when an event
 * lands for a registered source, which is significantly more
 * infrastructure for a dev-loop feature. Polling is indistinguishable
 * from "live" for a developer typing into a terminal at ~1s lag, and
 * the WebSocket flag can ship later as `axel listen --ws` without
 * breaking this path.
 */
export async function listenCommand(flags: Record<string, string>): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.error("Not signed in. Run `axel auth login`.");
    process.exitCode = 1;
    return;
  }

  const sourceId = flags.source;
  if (!sourceId) {
    console.error("Missing --source <source_id>. Pass the source you want to listen to.");
    process.exitCode = 64;
    return;
  }
  const forwardTo = flags["forward-to"];
  if (!forwardTo) {
    console.error("Missing --forward-to <url>. Example: --forward-to http://localhost:3000/webhooks");
    process.exitCode = 64;
    return;
  }
  const keepSignature = flags["keep-signature"] === "true";

  const client = makeClient(config);
  // Start watermark: now. Anything received before this poll is
  // ignored (the operator wants new events from this point forward,
  // not the entire backlog).
  let since = new Date().toISOString();
  const seen = new Set<string>();

  console.log(
    `axel listen — forwarding events from source ${sourceId} → ${forwardTo}`,
  );
  console.log(`(polling every ${POLL_INTERVAL_MS}ms · ctrl-c to exit)`);

  // Graceful exit on SIGINT.
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nStopping. (Events that arrive after this point are not forwarded.)");
  });

  while (!stopping) {
    try {
      const path = `/v1/cli/events?source_id=${encodeURIComponent(sourceId)}&since=${encodeURIComponent(since)}`;
      const res = await client.get<PollResponse>(path);
      for (const event of res.events) {
        if (seen.has(event.event_id)) continue;
        seen.add(event.event_id);
        // Memory cap on the dedup set — at 1 event/sec a long-running
        // listener won't realistically hit this, but a bursty source
        // could.
        if (seen.size > 5000) {
          const drop = Array.from(seen).slice(0, 1000);
          for (const id of drop) seen.delete(id);
        }
        await forwardOne(event, forwardTo, keepSignature);
        // Advance the watermark so the next poll skips already-seen events.
        if (event.received_at > since) since = event.received_at;
      }
      if (res.truncated) {
        console.log(`  (more events than the per-poll cap — next poll will catch up)`);
      }
    } catch (err: unknown) {
      // Don't crash the listener on transient errors; warn and keep
      // polling. Auth failures are fatal — the PAT was revoked.
      if (err instanceof CliApiError && err.status === 401) {
        console.error(`Auth failed (${err.code}): ${err.message}. Run \`axel auth login\` to re-authenticate.`);
        process.exitCode = 1;
        return;
      }
      console.error(`Poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function forwardOne(event: PolledEvent, forwardTo: string, keepSignature: boolean): Promise<void> {
  const body = Buffer.from(event.body_base64, "base64");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers)) {
    const lc = k.toLowerCase();
    if (STRIP_HEADERS.has(lc)) continue;
    if (!keepSignature && SIGNATURE_HEADERS.has(lc)) continue;
    headers[k] = v;
  }
  headers["content-type"] = event.content_type;
  headers["x-axel-listen-event-id"] = event.event_id;
  headers["x-axel-listen-source-id"] = event.source_id;

  const started = Date.now();
  let status = 0;
  let errorMessage: string | null = null;
  try {
    const res = await fetch(forwardTo, { method: "POST", headers, body });
    status = res.status;
    // Drain the body so the connection closes cleanly; we don't print
    // the response body in the listen log (would clutter the live feed).
    await res.text().catch(() => "");
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const took = Date.now() - started;

  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const summary = errorMessage
    ? `❌ ${errorMessage}`
    : `${status >= 200 && status < 300 ? "✓" : "✗"} ${status}`;
  console.log(
    `[${ts}] POST ${forwardTo} ← ${event.event_id} · ${took}ms · ${summary}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
