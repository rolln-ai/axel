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
- Database permissions or deployment migrations: `pnpm test:database` exercises
  both role models on disposable Postgres 17, including real writes and migrations.
  The self-host Postgres 16 test also runs in `pnpm test:deploy-scripts`.
- Delivery analytics SQL: `pnpm test:analytics`. This starts and removes its
  own loopback-only Docker ClickHouse instance at the production image version.
  It never uses `CLICKHOUSE_URL` from your shell. Optional repeatable benchmark:
  `AXEL_ANALYTICS_BENCHMARK_ROWS=500000 pnpm test:analytics`.
- UI: `AXEL_QA_PORT_BASE=34200 pnpm visual:smoke`. Reserve a different adjacent
  port pair per worktree. Inspect screenshots in `artifacts/visual-smoke` and
  the Playwright report. Check dark/light themes for dashboard changes.
- Signed-in UI: `AXEL_QA_PORT_BASE=34200 pnpm test:dashboard`. The runner builds
  the dashboard, seeds its own Docker Postgres, runs both themes and viewports,
  and removes the database. It covers real sign-in, a persisted workspace
  change, source isolation, keyboard focus, and sign-out. Pass Playwright options
  to focus or repeat it, e.g. `pnpm test:dashboard --project=desktop-light --repeat-each=3 --workers=1`.
  Sign-in throttling stays enabled; restart the disposable runner for longer batches.
- Interactive QA: `AXEL_QA_PORT_BASE=34200 pnpm qa:dashboard`. Use the synthetic
  login printed by the runner. Ctrl-C stops the server and removes its database.
- Full local pass: `pnpm verify`. Requires Docker, jq, and Playwright Chromium.
  Install the browser once with `pnpm exec playwright install chromium`.

The public browser suite checks marketing, authentication, public status, and
protected-route redirects. The signed-in suite uses real auth, Postgres, and the
ingest handler with synthetic fixtures. R2 and Queues use in-memory substitutes; it does not exercise
Cloudflare services or destination delivery. Verify those using the existing
protected smoke and canary workflows.
Do not invent an auth bypass or record customer payloads in test artifacts.
The signed-in runner rejects local Next environment files and does not inherit
application credentials from the shell. Both browser suites use the same port
pair, so run them sequentially within a worktree.

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
  Only @10-01 merges PRs. Leave changes ready for the maintainer to merge;
  do not use their credentials to merge or enable auto-merge on their behalf.
  Use descriptive commit and PR titles. Render Git auto-deploys must remain off.
  If a skip guard is needed while verifying that setting, put `[skip render]`
  on its own line in the commit body, including the squash-merge body. Do not
  put deployment flags in titles. Verify exact deployment URLs, then production
  domains.
- Internal release ledgers and business documents belong in the private
  `axel-internal` repository. Do not publish them here.
