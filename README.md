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

Requires Node 20+ (CI uses the version in `.node-version`) and pnpm 9. `jq` is
needed for the deploy-script tests in `pnpm test`.

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

The low-volume self-host profile uses Cloudflare's free Workers, Queues, and R2
allowances plus one Docker host you already control. It collapses the 16
production ingest queues to one queue and sends every destination through one
Node delivery service. Postgres, migrations, dashboard, cron, delivery, and
Caddy all run in the included Compose stack.

```sh
AXEL_PUBLIC_URL=https://axel.example.com \
AXEL_SITE_ADDRESS=axel.example.com \
  ./scripts/axel-self-host init

# Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to .env.selfhost.
# A separate, narrower CLOUDFLARE_RUNTIME_API_TOKEN is optional.
./scripts/axel-self-host edge
./scripts/axel-self-host up
```

This can have a $0 cloud bill when it runs on an existing machine, within the
provider's free limits. It is not a promise of free hardware, a free domain, or
an always-on managed database. See [`docs/self-hosting.md`](docs/self-hosting.md)
for the limits, token permissions, backups, and production topology.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: see
[`SECURITY.md`](SECURITY.md). The latest webhook data-flow review and open
hardening backlog are in
[`docs/security-review-2026-08.md`](docs/security-review-2026-08.md).

## License

[MIT](LICENSE). Axel Cloud is the hosted, paid deployment of this same code —
running it yourself, forking it, or building a business on it are all fine.
