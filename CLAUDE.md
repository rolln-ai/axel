# CLAUDE.md

Guidance for AI agents working in this repo (the Axel platform).

## What this repo is

This repository contains the Axel platform and runs Axel Cloud. Reviewed
commits land on `main`, then a
maintainer manually promotes them through the protected Production environment
using the deployment workflows in `.github/workflows/`.

## Working here

- Run `pnpm install --frozen-lockfile && pnpm build && pnpm test`. Workspace
  packages resolve from `dist/`, so build before testing.
- Lint with `pnpm lint` (biome), types with `pnpm typecheck`.
- Postgres migrations are append-only numbered files in
  `infra/postgres/migrations/`; never edit an applied migration.
- Check whether optional Stripe, Resend, Sentry, ClickHouse, and OpenRouter
  integrations are configured before using them. Self-hosted installs must
  start without them and show an unavailable state for dependent features.
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
private `rolln-ai/axel-internal` repo. Do not copy them here.
