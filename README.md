# Axel

Axel receives webhooks, stores their payloads, and delivers events to HTTP
endpoints, Postgres, MongoDB, BigQuery, Databricks, or object storage. Routes
filter and reshape events. Failed deliveries retry automatically and can be
inspected or replayed from the dashboard.

Use [Axel Cloud](https://app.axelapp.ai/signup) for a managed installation, or
[self-host](docs/self-hosting.md) the same code under Apache-2.0.

| | Axel Cloud | Self-hosted |
| --- | --- | --- |
| Hosting and upgrades | Managed by us | Managed by you |
| Routing, connectors, retries, replay | Included | Included |
| Searchable history | 30 days | Requires ClickHouse |
| Cost | 10,000 accepted events/month free; [paid plans](https://axelapp.ai/pricing) for more traffic | No Axel fee; you pay infrastructure costs |

Axel is pre-1.0. Minor releases may change APIs or configuration. Check release
notes for migration steps before upgrading.

![Axel dashboard workspace overview](docs/assets/axel-dashboard.png)

## How it works

```text
Webhook sender
  -> ingest Worker: authenticate, store raw payload in R2, enqueue, return 202
  -> router Worker: evaluate routes and prepare deliveries
     -> edge delivery: HTTP, signed webhooks, R2, JSON S3
     -> Node delivery: Postgres, MongoDB, BigQuery, Databricks, Parquet S3

Dashboard -> Postgres for configuration and accounts
          -> ClickHouse for event and delivery history
```

Delivery is asynchronous and at least once. Destinations should deduplicate
retries using the delivery identifier. A 202 means Axel accepted the event;
it does not mean every destination has received it.

Custom sources use the `x-axel-token` request header. Senders that cannot set
headers can use a separate, opt-in [authenticated webhook URL](docs/webhook-authentication.md).
Stripe, GitHub, Shopify, and Chargebee use their provider-specific authentication.
Do not put the ordinary header token in a URL.

See [current runtime](docs/adr-0002-current-runtime.md) for service responsibilities.

## Run it yourself

The small self-host profile uses Cloudflare Workers, Queues, and R2 for ingest,
plus a Docker host for Postgres, migrations, dashboard, cron, delivery, and Caddy.
It can fit within provider free allowances on an existing host. Queue retention,
CPU limits, and operating costs are covered in the [self-hosting guide](docs/self-hosting.md).

From a checkout:

```sh
AXEL_PUBLIC_URL=https://axel.example.com \
AXEL_SITE_ADDRESS=axel.example.com \
  ./scripts/axel-self-host init

# Add the Cloudflare account ID and separate provisioning/runtime tokens
# to .env.selfhost as described in the guide.
./scripts/axel-self-host edge
./scripts/axel-self-host up
```

`up` creates the database roles and schema before starting the applications.
ClickHouse is optional in this profile. Search, usage views, and some payload
lookups need it; shorter raw-payload retention and indexed erasure also require
the full cleanup and indexing jobs.

## Development

Use Node 22, pinned in `.node-version`, and pnpm 9.12.0. Install `jq` for the
deployment-script tests.

```sh
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Build before testing: workspace packages import compiled files from `dist/`.
For the full suite, including disposable databases and browser tests, install
Docker and Playwright Chromium:

```sh
pnpm exec playwright install chromium
pnpm verify
```

To explore a signed-in dashboard with synthetic data:

```sh
pnpm qa:dashboard
```

Run this in a clean worktree without local environment files. It builds the
app, starts a disposable Postgres database, and prints a URL and test login.
Ctrl-C stops the server and removes the database. `pnpm test:dashboard` runs
automated checks with the same setup. Neither needs hosted credentials.
[AGENTS.md](AGENTS.md) lists focused tests and per-worktree ports.

For database development, `docker compose up -d` starts raw Postgres and
ClickHouse instances. It does not create the protected roles or application
schema. Use the self-host profile when you need a migrated application stack.

Individual development servers:

```sh
pnpm --filter @axel/dashboard dev
pnpm --filter @axel/marketing dev --port 3001
pnpm --filter @axel/ingest-worker dev
```

The dashboard uses port 3000; marketing uses 3001. Start configuration from
`.env.example`. Put Next.js values in each app's `.env.local`, Worker values in
its `.dev.vars`, and export variables needed by root scripts. Unconfigured
Stripe, Resend, Sentry, ClickHouse, and OpenRouter integrations remain inactive
or show an unavailable state for dependent features.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/ingest-worker` | Public webhook receiver |
| `apps/router-edge` | Route evaluation and delivery fan-out |
| `apps/delivery-edge` | HTTP, webhook, R2, and JSON S3 delivery |
| `apps/delivery-service` | Node connectors, internal APIs, and periodic jobs |
| `apps/pull-worker` | API polling through the ingest pipeline |
| `apps/dashboard` | Accounts, configuration, inspection, and replay |
| `apps/marketing` | Public website and docs |
| `apps/router`, `apps/delivery-worker` | Libraries used by the deployed services |
| `packages/shared` | Shared types, contracts, and credential encryption |
| `packages/connectors`, `packages/pull-connectors` | Destination and pull-source connectors |
| `packages/cli` | CLI source; not yet published to npm |
| `infra` | Database migrations and deployment configuration |
| `docs` | Setup guides, architecture, and runbooks |

## Documentation and support

Start with the [documentation index](docs/README.md), [API reference](apps/dashboard/public/openapi.yaml),
[Postman examples](docs/postman/README.md), or [CLI guide](packages/cli/README.md).
The CLI must currently be built from source.

Ask usage questions in [GitHub Discussions](https://github.com/rolln-ai/axel/discussions).
[SUPPORT.md](SUPPORT.md) explains where to report bugs, account issues, and
security vulnerabilities. Use synthetic examples in public reports.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a large change.
[DESIGN.md](DESIGN.md) covers UI conventions. [GOVERNANCE.md](GOVERNANCE.md)
and the [code of conduct](CODE_OF_CONDUCT.md) describe how the project is run.
The [security review](docs/security-review-2026-08.md) records completed work
and remaining verification gaps. Report vulnerabilities privately through
[SECURITY.md](SECURITY.md).

## License

Axel uses the [Apache License 2.0](LICENSE). You may use, modify, self-host, and
distribute it, including commercially. Axel Cloud has separate service terms.
The source license does not grant trademark rights; see [TRADEMARKS.md](TRADEMARKS.md).
Dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
