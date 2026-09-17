// Live check of Jev-backed provider inference. Needs TYPESAFE_API_KEY in
// .env.local and a built @axel/shared (pnpm --filter @axel/shared build).
//
//   node scripts/jev-inference-smoke.mjs
//
// Sends schema-only summaries of a few fixture payloads (no values leave the
// machine) and prints what heuristics vs Jev decide.
import { loadLocalEnv } from "./load-env.mjs";
import {
  inferProvider,
  inferProviderWithJev,
  resolveJevConfig,
} from "../packages/shared/dist/index.js";

loadLocalEnv();
const config = resolveJevConfig(process.env);
if (!config) {
  console.error("TYPESAFE_API_KEY is not set; nothing to test.");
  process.exit(1);
}

const samples = [
  {
    name: "stripe, no headers",
    input: {
      payload: {
        id: "evt_1",
        object: "event",
        api_version: "2024-06-20",
        created: 1,
        livemode: false,
        type: "invoice.paid",
        data: { object: { id: "in_1", object: "invoice", amount_paid: 100 } },
      },
    },
  },
  {
    name: "github, no headers",
    input: {
      payload: {
        action: "opened",
        number: 1,
        pull_request: { id: 1, title: "x" },
        repository: { full_name: "a/b" },
        sender: { login: "a" },
      },
    },
  },
  {
    name: "shopify order, no headers",
    input: {
      payload: {
        id: 1,
        admin_graphql_api_id: "gid://shopify/Order/1",
        currency: "USD",
        email: "x@y.z",
        line_items: [{ id: 1 }],
        created_at: "2026-01-01",
      },
    },
  },
  {
    name: "chargebee",
    input: {
      payload: {
        id: "ev_1",
        occurred_at: 1,
        source: "api",
        event_type: "subscription_created",
        content: { subscription: { id: "s" }, customer: { id: "c" } },
      },
    },
  },
  {
    name: "unknown sender with a `kind` discriminator",
    input: { payload: { kind: "order.paid", id: "abc", total: 3 } },
  },
  {
    name: "shopify header smoking gun (should skip Jev)",
    input: { payload: { id: 1 }, headers: { "X-Shopify-Topic": "orders/create" } },
  },
];

for (const sample of samples) {
  const rules = inferProvider(sample.input);
  const t0 = performance.now();
  const jev = await inferProviderWithJev(sample.input, config);
  const ms = Math.round(performance.now() - t0);
  console.log(`\n== ${sample.name} (${ms} ms)`);
  console.log(`  rules: ${rules.provider} / ${rules.event_type ?? "-"} @ ${rules.confidence}`);
  console.log(
    `  jev:   ${jev.provider} / ${jev.event_type ?? "-"} @ ${jev.confidence.toFixed(2)} [${jev.source}]${jev.jev_error ? ` error=${jev.jev_error}` : ""}`,
  );
  if (jev.probabilities) {
    const top = Object.entries(jev.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(" ");
    console.log(`  p:     ${top}`);
  }
  console.log(`  why:   ${jev.why}`);
}
