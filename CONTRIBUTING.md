# Contributing to Axel

Thanks for your interest. Axel is maintained by a very small team (mostly one
person) that also operates [Axel Cloud](https://axelapp.ai) from this repo, so
please read this before opening a PR.

## Ground rules

- **Open an issue before a large PR.** Small fixes and doc improvements can go
  straight to a PR. Anything that changes behavior, schemas, or public
  contracts should start as an issue so we can agree on the approach first —
  this repo deploys a production service, and some constraints (queue
  semantics, migration ordering, credential crypto) are not obvious from the
  code alone.
- **No new required env vars without a graceful fallback.** A self-hosted or
  local install must keep working when an optional service (Stripe, Resend,
  Sentry, PostHog, ClickHouse, OpenRouter) is not configured.
- **Migrations are append-only.** Add a new numbered file under
  `infra/postgres/migrations/`; never edit an applied one.

## Development

```sh
pnpm install
pnpm build      # required once before tests (workspace packages build to dist/)
pnpm test
pnpm lint       # biome
pnpm typecheck
```

Local Postgres + ClickHouse: `docker compose up -d`, then run
`./scripts/run-migrations.sh` (see README). The unit test suite is hermetic —
it needs no cloud resources.

Running the full pipeline locally requires a Cloudflare account for the edge
workers (`wrangler dev`); see [`docs/self-hosting.md`](docs/self-hosting.md).

## Pull requests

- Keep PRs focused; one change per PR.
- Add or update tests for behavior changes. CI runs build, tests, lint,
  typecheck, and CodeQL.
- CI must be green. Deploy workflows only run for the cloud deployment and
  will no-op on forks.

## Security

Do not open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
