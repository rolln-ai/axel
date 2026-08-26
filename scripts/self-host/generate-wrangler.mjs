import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const quote = (value) => JSON.stringify(value);
const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const prefix = required("AXEL_RESOURCE_PREFIX");
if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(prefix)) {
  throw new Error("AXEL_RESOURCE_PREFIX must contain 2-49 lowercase letters, digits, or hyphens");
}
const deliveryUrl = required("AXEL_DELIVERY_PUBLIC_URL").replace(/\/$/, "");
const outputDir = path.resolve(process.argv[2] ?? ".selfhost");
const ingressQueue = `${prefix}-events`;
const deliveryQueue = `${prefix}-delivery`;
const deadQueue = `${prefix}-dead-letter`;
const bucket = `${prefix}-raw`;
const ingestName = `${prefix}-ingest`;
const routerName = `${prefix}-router`;
const customDomain = process.env.AXEL_INGEST_DOMAIN?.trim();

const ingestProducerBindings = Array.from({ length: 16 }, (_, index) => {
  const binding = `QUEUE_EVENTS_${index.toString().padStart(2, "0")}`;
  return `[[queues.producers]]\nbinding = ${quote(binding)}\nqueue = ${quote(ingressQueue)}\n`;
}).join("\n");

const ingest = `name = ${quote(ingestName)}
account_id = ${quote(accountId)}
main = "../apps/ingest-worker/src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = ${customDomain ? "false" : "true"}
${customDomain ? `routes = [{ pattern = ${quote(customDomain)}, custom_domain = true }]` : ""}

[[r2_buckets]]
binding = "EVENTS_RAW"
bucket_name = ${quote(bucket)}

${ingestProducerBindings}
[vars]
DELIVERY_SERVICE_URL = ${quote(deliveryUrl)}
SENTRY_ENVIRONMENT = "self-hosted"
`;

const router = `name = ${quote(routerName)}
account_id = ${quote(accountId)}
main = "../apps/router-edge/src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false

[[queues.consumers]]
queue = ${quote(ingressQueue)}
max_batch_size = 25
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = ${quote(deadQueue)}

# The low-volume self-host profile sends every connector type to the Node
# delivery service. Both bindings intentionally target the same pull queue.
[[queues.producers]]
binding = "DELIVERY_QUEUE"
queue = ${quote(deliveryQueue)}

[[queues.producers]]
binding = "DELIVERY_NATIVE_QUEUE"
queue = ${quote(deliveryQueue)}

[[queues.producers]]
binding = "DEAD_LETTER_QUEUE"
queue = ${quote(deadQueue)}

[[r2_buckets]]
binding = "EVENTS_RAW"
bucket_name = ${quote(bucket)}

[vars]
DELIVERY_SERVICE_URL = ${quote(deliveryUrl)}
SENTRY_ENVIRONMENT = "self-hosted"
`;

await mkdir(outputDir, { recursive: true, mode: 0o700 });
await Promise.all([
  writeFile(path.join(outputDir, "ingest.toml"), ingest, "utf8"),
  writeFile(path.join(outputDir, "router.toml"), router, "utf8"),
  writeFile(
    path.join(outputDir, "resources.env"),
    [
      `INGRESS_QUEUE=${ingressQueue}`,
      `DELIVERY_QUEUE=${deliveryQueue}`,
      `DEAD_QUEUE=${deadQueue}`,
      `RAW_PAYLOAD_BUCKET=${bucket}`,
      `INGEST_WORKER_NAME=${ingestName}`,
      `ROUTER_WORKER_NAME=${routerName}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  ),
]);
