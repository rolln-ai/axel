# Self-hosting Axel

Axel's edge pipeline is built on Cloudflare primitives with no abstraction
layer, so self-hosting means running the workers in **your own Cloudflare
account** — there is currently no Kafka/Redis/queue-of-your-choice port. This
is an honest constraint, not a licensing one.

## What you need

| Component | Runs on | Required? |
| --- | --- | --- |
| `apps/ingest-worker`, `apps/router-edge`, `apps/delivery-edge` | Cloudflare Workers (paid plan — Queues, R2, KV, Durable Objects) | Yes |
| `apps/delivery-service` | Any Node 22 host (Docker, Render, Railway, a VM) | Yes, for native destinations (Postgres/Mongo/BigQuery/Databricks) and DLQ drain |
| `apps/pull-worker` | Any Node 22 host | Only for pull-based sources |
| `apps/dashboard` | Any Next.js host (Vercel, or `next start` behind a proxy) | Yes |
| `apps/marketing` | Anywhere | No |
| Postgres 15+ | Anywhere | Yes (control plane: config, users, delivery state) |
| ClickHouse 24+ | Anywhere | Optional (delivery logs, usage analytics — dashboard shows empty states without it) |

`docker-compose.yml` at the repo root provides Postgres + ClickHouse for local
use.

## Steps

1. **Databases.** Create Postgres, then apply migrations:

   ```sh
   DATABASE_URL=postgres://... ./scripts/run-migrations.sh
   ```

   Optionally ClickHouse:

   ```sh
   CLICKHOUSE_URL=... CLICKHOUSE_USER=... CLICKHOUSE_PASSWORD=... \
     ./scripts/apply-clickhouse-schema.sh
   ```

2. **Cloudflare resources.** In your account, create: sixteen ingest queues
   (`axel-events-00` … `axel-events-15`), the delivery queues
   (`axel-delivery`, `axel-delivery-native`, `axel-dead-letter`), an R2 bucket
   for raw payloads, and a KV namespace for the source/plan cache. Update the
   `wrangler.toml` in each of the three worker apps with your account's
   resource IDs and your ingest domain, then:

   ```sh
   pnpm --filter @axel/ingest-worker exec wrangler deploy   # and router-edge, delivery-edge
   ```

   Worker secrets (set via `wrangler secret put`): see the `[vars]` sections
   and `.env.example` — notably `DATABASE_URL`, `CREDENTIALS_MASTER_KEY`,
   `DELIVERY_SHARED_SECRET`, `SOURCE_LOOKUP_SHARED_SECRET`.

3. **Delivery service / pull worker.** Deploy `apps/delivery-service` (and
   `apps/pull-worker` if you use pull sources) to any Node host with the env
   vars from `.env.example`. `render.yaml` is the cloud's own blueprint and a
   useful reference for service shape and health checks.

4. **Dashboard.** Deploy `apps/dashboard` with `DATABASE_URL`,
   `CREDENTIALS_MASTER_KEY`, and `NEXT_PUBLIC_AXEL_*` URLs pointing at your
   domains. On Vercel, the cron jobs in `apps/dashboard/vercel.json` run
   automatically; on other hosts, hit the `/api/cron/*` routes on the same
   schedules with `Authorization: Bearer $CRON_SECRET`.

5. **Generate `CREDENTIALS_MASTER_KEY`** (AES-256-GCM key for destination
   credentials):

   ```sh
   openssl rand -base64 32
   ```

   Rotation procedure: [`credential-rotation.md`](credential-rotation.md).

## What "no billing" means

Billing only activates when `STRIPE_SECRET_KEY` is set. Without it:

- Every workspace is unlimited — no free-tier cap, no 429s, no suspension
  (`deriveGate` in `apps/dashboard/lib/billing/plan-state.ts` returns
  `accept` unconditionally).
- The billing UI renders an inert self-hosted state; no upgrade emails or cap
  banners are produced.
- The hourly billing-rollup cron degrades to a plan-state push and skips the
  ClickHouse aggregation when ClickHouse is absent.

Other integrations degrade the same way: no `RESEND_API_KEY` → no emails
(note: password reset and email verification will not arrive), no
`SENTRY_DSN`/`NEXT_PUBLIC_POSTHOG_KEY` → no telemetry, no
`OPENROUTER_API_KEY` → no AI dead-letter explanations.

## Branding

`apps/marketing` and the legal pages under `apps/marketing/content/legal/`
describe Axel Cloud (operated by rolln, Inc.). If you run a public deployment,
replace them with your own content.
