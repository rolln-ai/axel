# @axel/test-utils

Shared test fakes for workspace packages. This package is not published and
imports directly from `src`, with no build step. Add
`"@axel/test-utils": "workspace:*"` to a package's `devDependencies`.

## Exports

- `capturingPg(options?)` returns a Postgres fake with FIFO scripted
  responses (`Error` entries reject), every call captured as `{ sql, params }`,
  optional `intercept` for answering interleaved queries (e.g. billing gates)
  without consuming the FIFO. `pg.dbModule()` is a drop-in factory for
  `vi.mock("../lib/db", () => pg.dbModule())`.
- `fakeClickhouse({ responses })` returns a scripted ClickHouse fake with
  `{ client, calls }`. `responses` is a FIFO array of rows arrays, or a
  `(sql, params) => rows` router for order-independent scripting.
- `fakeSession(role?, overrides?)` creates a session fixture matching the
  dashboard's `lib/session` shapes: `usr_1` on active workspace `ws_1`.

## Convention

Use these helpers for new Postgres, ClickHouse, and session tests. Extend them
when a test needs more behavior, keeping existing signatures compatible. A
local wrapper can adapt a helper to a test, such as routing responses by table. Keep capture and response ordering in these shared helpers.

`vi.mock` factories are hoisted, so a factory may only reference
module-scope helpers when the mocked module is imported lazily (dynamic
`await import(...)` inside tests). Files that statically import their module
under test may need `vi.hoisted` or an inline factory. Keep local mock setup where hoisting requires it.
