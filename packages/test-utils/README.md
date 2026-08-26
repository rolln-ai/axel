# @axel/test-utils

Shared test fakes for the monorepo. Private, consumed straight from `src`
(no build step) — add `"@axel/test-utils": "workspace:*"` to a package's
`devDependencies` and import.

## Exports

- **`capturingPg(options?)`** — the canonical Postgres fake: FIFO scripted
  responses (`Error` entries reject), every call captured as `{ sql, params }`,
  optional `intercept` for answering interleaved queries (e.g. billing gates)
  without consuming the FIFO. `pg.dbModule()` is a drop-in factory for
  `vi.mock("../lib/db", () => pg.dbModule())`.
- **`fakeClickhouse({ responses })`** — scripted ClickHouse fake returning
  `{ client, calls }`. `responses` is a FIFO array of rows arrays, or a
  `(sql, params) => rows` router for order-independent scripting.
- **`fakeSession(role?, overrides?)`** — session fixture matching the
  dashboard's `lib/session` shapes: `usr_1` on active workspace `ws_1`.

## Convention

**New tests use these helpers; don't hand-roll new pg/ClickHouse/session
fakes.** If a helper is missing a capability, extend it here (keeping existing
signatures backward-compatible) instead of forking a local copy. Thin local
wrappers that adapt a helper to a file's specific scripting (e.g. routing rows
by table) are fine — reimplementing the capture/FIFO mechanics is not.

One caveat: `vi.mock` factories are hoisted, so a factory may only reference
module-scope helpers when the mocked module is imported lazily (dynamic
`await import(...)` inside tests). Files that statically import their module
under test may need `vi.hoisted` or an inline factory — that's the one case
where hand-rolled setup is still acceptable.
