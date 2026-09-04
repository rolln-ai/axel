# Contributing to Axel

Thanks for your interest. Axel is maintained by a very small team (mostly one
person) that also operates [Axel Cloud](https://axelapp.ai) from this repo, so
please read this before opening a PR.

By submitting a contribution, you agree that it is licensed under the
repository's [Apache License 2.0](LICENSE). You retain copyright in your contribution.
Participation in this project follows the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Ground rules

- **Open an issue before a large PR.** Small fixes and doc improvements can go
  straight to a PR. Anything that changes behavior, schemas, or public
  contracts should start as an issue so we can agree on the approach first.
  This repo deploys a production service, and some constraints (queue
  semantics, migration ordering, credential crypto) are not obvious from the
  code alone.
- **Optional integrations need a graceful fallback.** A self-hosted or local
  install must keep working when Stripe, Resend, Sentry, ClickHouse,
  or OpenRouter is not configured. Required base-infrastructure variables must
  be documented and validated at startup.
- **Migrations are append-only.** Add a uniquely numbered file under
  `infra/postgres/migrations/`; never edit an applied one. The two `0025_*`
  files are a frozen historical collision. CI rejects any new duplicate and
  the production runner rejects changed checksums.
- **UI changes follow [`DESIGN.md`](DESIGN.md).** It documents the existing
  tokens, type scale, composites, and the anti-patterns we reject in review.
  Build from the components in `apps/dashboard/app/_components/` before
  adding new ones, and check both themes.

## Development

Install Node 22.13 or newer on the Node 22 LTS line, pnpm 9.12.0, and `jq`.
The repository pins the exact Node and pnpm versions used by CI.

```sh
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm build      # required once before tests (workspace packages build to dist/)
pnpm test
pnpm lint       # biome
pnpm typecheck
```

`docker compose up -d` starts raw Postgres and ClickHouse services for
database-specific development. It does not create Axel's protected database
roles or application schema. Use the self-host profile in
[`README.md`](README.md#self-hosting) when you need a migrated Postgres database
with the dashboard and delivery service. The unit test suite is hermetic. It
needs no cloud resources.

Running the full pipeline locally requires a Cloudflare account for the edge
workers (`wrangler dev`); see [`docs/self-hosting.md`](docs/self-hosting.md).

## Pull requests

- Keep PRs focused; one change per PR.
- Add or update tests for behavior changes. CI runs build, tests, lint,
  typecheck, dependency audit, and secret scanning. CodeQL and native dependency
  review activate automatically when the repository becomes public.
- CI must be green. Forks receive no repository or deployment secrets. Their
  required preview check compiles the dashboard and marketing app without
  deploying them.
- Hosted PR previews are currently disabled. Operators can stage an exact
  commit through the protected deployment workflow. The supported production
  path is a manual promotion through the protected Production environment,
  with pending Postgres migrations applied first.
- Render secret sync saves provider configuration without deploying it. Promote
  the reviewed commit afterward through `Deploy Render Services`; that workflow
  pins the commit SHA, waits for a terminal provider result, and runs the
  production smoke and delivery canary. Cloudflare secret changes create Worker
  versions immediately, so their protected workflow shares the production lock
  and runs the smoke and canary before completing.

## Security

Do not open public issues for vulnerabilities. See [`SECURITY.md`](SECURITY.md).

For setup questions and support routing, see [`SUPPORT.md`](SUPPORT.md).
Project decision-making is documented in [`GOVERNANCE.md`](GOVERNANCE.md).
