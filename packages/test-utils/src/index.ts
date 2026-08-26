/**
 * Shared test fakes for the Axel monorepo.
 *
 * Consumed straight from src (no build step) like @axel/connectors and
 * @axel/pull-connectors. Everything here is framework-free plain TS so it can
 * be used from any package's vitest suite, whether the fake is handed in via
 * dependency injection or wired up inside a `vi.mock` factory.
 */

/* ------------------------------- Postgres ------------------------------- */

/** A single captured query call. */
export interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/** A scripted response for one query. `rowCount` defaults to `rows.length`. */
export interface PgResponse {
  rows: unknown[];
  rowCount?: number;
}

export interface CapturingPgOptions {
  /**
   * FIFO of scripted responses. Each query consumes one entry; an `Error`
   * entry makes that query reject. When the FIFO is empty, queries answer
   * `{ rows: [], rowCount: 0 }`. Tests can also push onto `.responses` later.
   */
  responses?: Array<PgResponse | Error>;
  /**
   * Answer matching queries without consuming the FIFO (e.g. a billing-gate
   * lookup interleaved with the queries under test). The call is still
   * captured in `.calls`. Return `undefined` to fall through to the FIFO.
   */
  intercept?: (sql: string, params: unknown[]) => PgResponse | undefined;
}

export interface CapturingPg {
  /** Every query issued, in order. */
  calls: CapturedQuery[];
  /** The live FIFO — push scripted responses, or `.length = 0` to reset. */
  responses: Array<PgResponse | Error>;
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  /**
   * Drop-in module shape for the dashboard's `../lib/db`:
   * `vi.mock("../lib/db", () => pg.dbModule())`. `withTransaction` hands the
   * callback the same capturing client, so transactional queries land in
   * `.calls` too, and thrown errors surface like a real rollback.
   */
  dbModule: () => {
    db: () => { query: CapturingPg["query"] };
    withTransaction: <T>(
      fn: (client: { query: CapturingPg["query"] }) => Promise<T>,
    ) => Promise<T>;
  };
  /** Clear captured calls and any unconsumed responses. */
  reset: () => void;
}

/**
 * FIFO-response, call-capturing Postgres fake. The single canonical shape for
 * scripting `db().query(...)` / `pool.query(...)` in tests: responses are
 * consumed in order, every call is recorded as `{ sql, params }`.
 */
export function capturingPg(options: CapturingPgOptions = {}): CapturingPg {
  const calls: CapturedQuery[] = [];
  const responses: Array<PgResponse | Error> = [...(options.responses ?? [])];
  const query = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    calls.push({ sql, params });
    const next = options.intercept?.(sql, params) ?? responses.shift() ?? { rows: [], rowCount: 0 };
    if (next instanceof Error) throw next;
    return { rows: next.rows as T[], rowCount: next.rowCount ?? next.rows.length };
  };
  return {
    calls,
    responses,
    query,
    dbModule: () => ({
      db: () => ({ query }),
      withTransaction: (fn) => fn({ query }),
    }),
    reset() {
      calls.length = 0;
      responses.length = 0;
    },
  };
}

/* ------------------------------ ClickHouse ------------------------------ */

/** A single captured ClickHouse query. */
export interface CapturedClickhouseQuery {
  sql: string;
  params: Record<string, string | number>;
}

export type FakeClickhouseResponses =
  /** FIFO: one entry (a rows array, or an Error to throw) per query; `[]` once exhausted. */
  | Array<unknown>
  /** Router: derive the rows for each query from its SQL/params. */
  | ((sql: string, params: Record<string, string | number>) => unknown);

export interface FakeClickhouseOptions {
  responses: FakeClickhouseResponses;
}

/** Structurally compatible with the dashboard's `ClickhouseQueryable`. */
export interface FakeClickhouseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number>,
  ): Promise<{ rows: T[] }>;
}

/**
 * Scripted ClickHouse fake. `responses` is either a FIFO array of rows arrays
 * (an `Error` entry rejects that query) or a router function `(sql, params) =>
 * rows` for order-independent scripting. Every query is captured in `calls`.
 */
export function fakeClickhouse({ responses }: FakeClickhouseOptions): {
  client: FakeClickhouseClient;
  calls: CapturedClickhouseQuery[];
} {
  const calls: CapturedClickhouseQuery[] = [];
  let cursor = 0;
  const client: FakeClickhouseClient = {
    async query(sql, params = {}) {
      calls.push({ sql, params });
      const next =
        typeof responses === "function" ? responses(sql, params) : (responses[cursor++] ?? []);
      if (next instanceof Error) throw next;
      return { rows: next as never };
    },
  };
  return { client, calls };
}

/* -------------------------------- Session ------------------------------- */

export type SessionRole = "owner" | "admin" | "member";

export interface FakeSessionUser {
  id: string;
  [key: string]: unknown;
}

export interface FakeSessionWorkspace {
  workspace_id: string;
  role: SessionRole;
  workspace_status: string;
  [key: string]: unknown;
}

/** Matches the dashboard's `CurrentSession` shape as far as tests rely on it. */
export interface FakeSession {
  user: FakeSessionUser;
  activeWorkspace: FakeSessionWorkspace;
  [key: string]: unknown;
}

export interface FakeSessionOverrides {
  user?: Record<string, unknown>;
  activeWorkspace?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Session fixture for mocking `requireSession` and friends:
 * `usr_1` on active workspace `ws_1` with the given role. Overrides are
 * shallow-merged into `user` / `activeWorkspace`; extra top-level keys
 * (e.g. `memberships`, `impersonator`) pass straight through.
 */
export function fakeSession(
  role: SessionRole = "owner",
  overrides: FakeSessionOverrides = {},
): FakeSession {
  const { user, activeWorkspace, ...rest } = overrides;
  return {
    user: { id: "usr_1", ...user },
    activeWorkspace: {
      workspace_id: "ws_1",
      role,
      workspace_status: "active",
      ...activeWorkspace,
    },
    ...rest,
  };
}
