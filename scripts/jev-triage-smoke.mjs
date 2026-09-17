// Live check of Jev dead-letter triage. Needs TYPESAFE_API_KEY in .env.local
// and a built @axel/shared. Sends synthetic, allowlisted states only.
//
//   node scripts/jev-triage-smoke.mjs
import { loadLocalEnv } from "./load-env.mjs";
import { resolveJevConfig, shouldAutoReplay, triageDeadLetter } from "../packages/shared/dist/index.js";

loadLocalEnv();
const config = resolveJevConfig(process.env);
if (!config) {
  console.error("TYPESAFE_API_KEY is not set; nothing to test.");
  process.exit(1);
}

const base = { same_fingerprint_1h: 1, same_fingerprint_24h: 1, replay_successes_24h: 0, replay_failures_24h: 0, age_minutes: 10 };
const cases = [
  ["one-off 503 timeout, replays landed before", { ...base, reason: "delivery_dead", destination_type: "http", message: "HTTP 503 upstream timed out", replay_successes_24h: 4 }],
  ["Axel shed at capacity", { ...base, reason: "delivery_service_503", destination_type: "postgres", message: "delivery-service shed request: inflight cap reached" }],
  ["breaker open", { ...base, reason: "breaker_open_cooldown_active", destination_type: "http", message: "circuit breaker open for destination; cooldown active" }],
  ["ECONNREFUSED, 240 in the last hour, replays failing", { ...base, reason: "delivery_dead", destination_type: "http", message: "connect ECONNREFUSED 10.1.2.3:443", same_fingerprint_1h: 240, same_fingerprint_24h: 300, replay_failures_24h: 12 }],
  ["postgres unknown column", { ...base, reason: "connector_failed", destination_type: "postgres", message: 'column "amount_cents" of relation "events" does not exist', same_fingerprint_24h: 40 }],
  ["bigquery type mismatch", { ...base, reason: "destination_rejected", destination_type: "bigquery", message: "Invalid value: could not convert string to INT64 for field total", same_fingerprint_24h: 15 }],
  ["raw payload missing", { ...base, reason: "raw_payload_missing", destination_type: "s3", message: "object not found in R2" }],
  ["403 forbidden on S3", { ...base, reason: "connector_failed", destination_type: "s3", message: "AccessDenied: 403 Forbidden", same_fingerprint_24h: 8 }],
  ["rate limited by webhook", { ...base, reason: "rate_limited", destination_type: "webhook", message: "HTTP 429 Too Many Requests", same_fingerprint_1h: 30 }],
];

for (const [name, input] of cases) {
  const t0 = performance.now();
  try {
    const r = await triageDeadLetter(input, config);
    const ms = Math.round(performance.now() - t0);
    const top = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
    const replay = shouldAutoReplay(r, input.reason) ? "AUTO-REPLAY" : "human";
    console.log(`${name.padEnd(52)} -> ${r.reason.padEnd(17)} conf=${r.confidence.toFixed(2)} ${replay.padEnd(11)} [${top}] ${ms}ms`);
    console.log(`  signals=${r.state.signals.join(",") || "-"} status=${r.state.http_status ?? "-"}`);
  } catch (err) {
    console.log(`${name} -> ERROR ${err.message}`);
  }
}
