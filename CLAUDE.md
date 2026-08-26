# CLAUDE.md

Guidance for AI agents working in this repo (the Axel platform).

## What this repo is

The open-source Axel webhook platform — and the production source for Axel
Cloud, which deploys from `main`. Treat every change as production-bound:
deploy workflows in `.github/workflows/` push to the cloud on merge.

## Working here

- `pnpm install && pnpm build && pnpm test` — build is required before tests
  (workspace packages resolve from `dist/`).
- Lint with `pnpm lint` (biome), types with `pnpm typecheck`.
- Postgres migrations are append-only numbered files in
  `infra/postgres/migrations/`; never edit an applied migration.
- Optional integrations (Stripe, Resend, Sentry, PostHog, ClickHouse,
  OpenRouter) must degrade gracefully when unconfigured — self-hosted installs
  rely on it. The pattern is a `has*Configured()` probe, not a crash.
- The dashboard test suite models the cloud deployment; `test/setup-env.ts`
  sets a Stripe fixture key. Self-hosted behavior is tested in
  `apps/dashboard/test/billing-self-hosted.test.ts`.

## Docs

Public docs are ADRs and runbooks in `docs/`. Internal/business docs
(cost model, brand voice, go-live records, release ledgers) live in the
private `rolln-ai/axel-internal` repo — do not recreate them here.
