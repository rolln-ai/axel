# CLAUDE.md

Guidance for AI agents working in this repo (the Axel platform).

## What this repo is

The Axel webhook platform — and the production source for Axel Cloud. Treat
every change as production-bound: reviewed commits land on `main`, then a
maintainer manually promotes them through the protected Production environment
using the deployment workflows in `.github/workflows/`.

## Working here

- `pnpm install && pnpm build && pnpm test` — build is required before tests
  (workspace packages resolve from `dist/`).
- Lint with `pnpm lint` (biome), types with `pnpm typecheck`.
- Postgres migrations are append-only numbered files in
  `infra/postgres/migrations/`; never edit an applied migration.
- Optional integrations (Stripe, Resend, Sentry, ClickHouse, OpenRouter) must
  degrade gracefully when unconfigured — self-hosted installs
  rely on it. The pattern is a `has*Configured()` probe, not a crash.
- The dashboard test suite models the cloud deployment; `test/setup-env.ts`
  sets a Stripe fixture key. Self-hosted behavior is tested in
  `apps/dashboard/test/billing-self-hosted.test.ts`.
- UI work: read `DESIGN.md` before creating or changing anything user-facing
  in `apps/dashboard` or `apps/marketing`. It documents the existing tokens,
  composites, and named anti-patterns; match them. Run `pnpm visual:smoke`
  after UI changes.

## Docs

Public docs are ADRs and runbooks in `docs/`. Internal/business docs
(cost model, brand voice, go-live records, release ledgers) live in the
private `rolln-ai/axel-internal` repo — do not recreate them here.
