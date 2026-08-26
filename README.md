# Axel

Open-source webhook ingestion and event delivery platform. Capture webhooks
from any source, filter and transform them with declarative routes, and
deliver them to HTTP endpoints, Postgres, MongoDB, BigQuery, Databricks, or
object storage — with retries, dead-lettering, replay, and full delivery
history.

Axel is the code behind [**Axel Cloud**](https://axelapp.ai) — the hosted
version, if you'd rather not run it yourself. This repo is the real production
source, not a mirror: the cloud deploys from `main`.

![Axel dashboard — workspace overview](docs/assets/axel-dashboard.png)

## How it works

```
                    ┌──────────────────────────── Cloudflare ───────────────────────────┐
Webhook sources ──▶ │ ingest-worker ─▶ R2 (raw payloads) + sharded Queues               │
                    │      └─▶ router-edge (route eval, fan-out) ─▶ delivery queues     │
                    │               └─▶ delivery-edge (HTTP / webhook / R2 / S3)        │
                    └────────────────────────────────────────────────────────────────────┘
                                   └─▶ delivery-service (Node) — Postgres / MongoDB /
                                       BigQuery / Databricks destinations
Control plane:  dashboard (Next.js) + Postgres (config, users) + ClickHouse (delivery logs)
Pull sources:   pull-worker polls APIs (e.g. Stripe) and feeds the same pipeline
```

Design notes live in [`docs/adr-0001-architecture.md`](docs/adr-0001-architecture.md)
and [`docs/production-scale.md`](docs/production-scale.md).

## Repo layout

| Path                     | What lives here                                            |
| ------------------------ | ---------------------------------------------------------- |
| `apps/ingest-worker`     | Cloudflare Worker — public webhook ingest endpoint         |
| `apps/router-edge`       | Cloudflare Worker — route evaluation and fan-out           |
| `apps/delivery-edge`     | Cloudflare Worker — HTTP/webhook/R2/S3 delivery + DLQ      |
| `apps/delivery-service`  | Node service — Postgres/Mongo/BigQuery/Databricks delivery |
| `apps/pull-worker`       | Node service — polls pull-based sources                    |
| `apps/dashboard`         | Next.js control plane (auth, routes, replay, admin)        |
| `apps/marketing`         | Marketing + public docs site                               |
| `packages/shared`        | Shared types, contracts, credential crypto                 |
| `packages/connectors`    | Destination connectors                                     |
| `packages/pull-connectors` | Pull-source connectors                                   |
| `packages/cli`           | `@axel/cli`                                                |
| `infra/`                 | Postgres migrations, ClickHouse schema, lifecycle rules    |
| `docs/`                  | ADRs and operational runbooks                              |

## Development

Requires Node 22 (see `.node-version`) and pnpm 9.

```sh
pnpm install
pnpm build       # builds workspace packages (required before tests)
pnpm test
pnpm lint
```

Local backing stores (Postgres + ClickHouse) for running the dashboard and
delivery service:

```sh
docker compose up -d
DATABASE_URL=postgres://axel:axel@localhost:5432/axel ./scripts/run-migrations.sh
```

Per-app dev servers:

```sh
pnpm --filter @axel/dashboard dev       # control plane on :3000
pnpm --filter @axel/marketing dev       # marketing site on :3001
pnpm --filter @axel/ingest-worker dev   # wrangler dev
```

Copy `.env.example` to `.env.local` and fill in what you need — every feature
degrades gracefully when its variable is unset (no Stripe → no billing, no
caps; no Resend → no emails; no Sentry/PostHog → no telemetry).

## Self-hosting

See [`docs/self-hosting.md`](docs/self-hosting.md). Short version: the edge
pipeline runs on Cloudflare (Workers, Queues, R2, KV — a Cloudflare account
with the paid Workers plan is required), the delivery service and pull worker
run on any Node host, the dashboard runs on any Next.js host, and you bring
Postgres and (optionally) ClickHouse. A self-hosted deployment with no Stripe
configured has no usage caps or billing UI.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: see
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). Axel Cloud is the hosted, paid deployment of this same code —
running it yourself, forking it, or building a business on it are all fine.
