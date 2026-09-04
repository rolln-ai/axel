# Working on Axel

Axel Cloud runs this repository. Read `DESIGN.md` before UI changes and
`docs/adr-0002-current-runtime.md` before changing routing or delivery.

## Start in an isolated worktree

```sh
git fetch origin
git worktree add ../axel-change -b fix/your-change origin/main
cd ../axel-change
nvm install "$(cat .node-version)"
nvm use "$(cat .node-version)"
corepack enable
corepack pnpm install --frozen-lockfile
```

Use an equivalent Node version manager if nvm is unavailable. Match
`.node-version` and the `packageManager` in `package.json`; do not update the
lockfile to accommodate your machine. Do not copy production `.env.local`,
`.dev.vars`, provider tokens, or database URLs into a test checkout. The unit
and public browser suites require no production services.

## Verify the behavior you changed

- Dashboard logic: `pnpm --filter @axel/dashboard... build`, then
  `pnpm --filter @axel/dashboard exec vitest run test/<name>.test.ts`.
- Shared code: run the affected package's tests and its runtime consumers.
- Delivery analytics SQL: `pnpm test:analytics`. This starts and removes its
  own loopback-only Docker ClickHouse instance at the production image version.
  It never uses `CLICKHOUSE_URL` from your shell. Optional repeatable benchmark:
  `AXEL_ANALYTICS_BENCHMARK_ROWS=500000 pnpm test:analytics`.
- UI: `AXEL_QA_PORT_BASE=34200 pnpm visual:smoke`. Reserve a different adjacent
  port pair per worktree. Inspect screenshots in `artifacts/visual-smoke` and
  the Playwright report. Check dark/light themes for dashboard changes.
- Full local pass: `pnpm verify`. Requires Docker, jq, and Playwright Chromium.
  Install the browser once with `pnpm exec playwright install chromium`.

The public browser suite checks marketing, authentication, public status, and
protected-route redirects. It does not prove authenticated workspace flows.
For those, use a disposable self-host install and synthetic data, then verify
any production rollout using the existing protected smoke and canary workflows.
Do not invent an auth bypass or record customer payloads in test artifacts.

## Keep verification useful

Test observable behavior and failure boundaries. SQL string assertions cannot
prove query semantics or performance; run SQL against the disposable database.
Use baseline and candidate measurements with identical inputs, check output
equality, and discard optimizations that do not improve the measured workload.
Do not remove security regressions just because they are verbose. Delete dead
code and no-op scripts instead of adding wrappers around them. Dashboard
TypeScript checks reject unused local code.

## Production constraints

- Postgres migrations are append-only. Never edit an applied migration.
- Source changes must preserve authority fencing and workspace isolation.
- Queue acknowledgements must follow durable delivery, retry, or dead-letter
  persistence. Delivery is at least once; ambiguous results are not success.
- Optional Stripe, Resend, ClickHouse, Sentry, and OpenRouter integrations must
  have explicit unavailable states in self-hosted deployments.
- Keep secrets and provider response bodies out of logs and errors. Numeric
  error codes can preserve recovery behavior without retaining raw responses.
- Land reviewed commits through a PR. CI must pass. Production promotions use
  the existing manual workflows, with migrations before application code.
  Keep `[skip render]` in merge titles so a merge cannot trigger an unrelated
  native-service rollout. Verify exact deployment URLs, then production domains.
- Internal release ledgers and business documents belong in the private
  `axel-internal` repository. Do not publish them here.
