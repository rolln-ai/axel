import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../lib/db";
import {
  appendDataContractVersion,
  createDataContract,
  deleteDataContract,
  getDataContract,
  insertDriftEvent,
  insertDataContractFixture,
  listDataContractFixtures,
  listDataContractsForSource,
  listDataContractVersions,
  listUnresolvedDriftEvents,
  resolveDriftEvent,
  updateDataContractStatus,
} from "../lib/data-contracts/repository";

type Captured = { sql: string; params: unknown[] };

/**
 * Build a fake Queryable that returns a queued sequence of result rows. Each
 * call to query() pops one queued row-set and records the SQL + params for
 * assertion. If the queue is exhausted we surface a useful error rather than
 * silently returning {} — that catches drift between test setup and the
 * actual call order.
 */
function fakeDb(queue: unknown[][]): {
  db: Queryable;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const queueCopy = queue.slice();
  const db: Queryable = {
    async query<T>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      if (queueCopy.length === 0) {
        throw new Error(
          `fakeDb: queue empty for sql: ${sql.slice(0, 80)} (param count ${
            params?.length ?? 0
          })`,
        );
      }
      const rows = queueCopy.shift() ?? [];
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  return { db, captured };
}

/**
 * Fake pg.PoolClient — only the methods exercised by appendDataContractVersion
 * (BEGIN/COMMIT/ROLLBACK + query). withTransaction's BEGIN/COMMIT calls are
 * swallowed by treating any non-SELECT/INSERT/UPDATE statement as a no-op.
 */
function fakePoolClient(queue: unknown[][]): {
  client: pg.PoolClient;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const queueCopy = queue.slice();
  const client = {
    async query<T = Record<string, unknown>>(
      sql: string | { text: string; values?: unknown[] },
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number }> {
      const text = typeof sql === "string" ? sql : sql.text;
      const values =
        typeof sql === "string" ? params ?? [] : sql.values ?? [];
      const head = text.trim().slice(0, 8).toUpperCase();
      if (head.startsWith("BEGIN") || head.startsWith("COMMIT") ||
          head.startsWith("ROLLBACK")) {
        return { rows: [] as T[], rowCount: 0 };
      }
      captured.push({ sql: text, params: values });
      if (queueCopy.length === 0) {
        throw new Error(
          `fakePoolClient: queue empty for sql: ${text.slice(0, 80)}`,
        );
      }
      const rows = queueCopy.shift() ?? [];
      return { rows: rows as T[], rowCount: rows.length };
    },
    release() {},
  } as unknown as pg.PoolClient;
  return { client, captured };
}

/**
 * In-memory Postgres stand-in for the appendDataContractVersion concurrency
 * contract. Emulates only what the race needs:
 *   - `pg_advisory_xact_lock(hashtext($1))` — per-key mutex, held until the
 *     transaction's COMMIT/ROLLBACK (like the real xact lock).
 *   - `SELECT COALESCE(MAX(version_number), 0) + 1` over the shared rows.
 *   - INSERT enforcing UNIQUE (data_contract_id, version_number).
 * Every data statement yields to the event loop first, so two unserialized
 * transactions WOULD interleave (both read the same MAX and the loser would
 * throw the unique violation) — the test only passes because the lock is
 * taken before MAX and held to commit.
 */
function makeVersionRaceEngine(): {
  versions: Array<{ data_contract_id: string; version_number: number }>;
  withFakeTransaction: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
} {
  const versions: Array<{ data_contract_id: string; version_number: number }> = [];
  // key → waiters. Key present = lock held.
  const locks = new Map<string, Array<() => void>>();

  function acquire(key: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = locks.get(key);
      if (!waiters) {
        locks.set(key, []);
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  }
  function release(key: string): void {
    const waiters = locks.get(key);
    if (!waiters) return;
    const next = waiters.shift();
    if (next) next();
    else locks.delete(key);
  }

  function makeClient(): pg.PoolClient {
    const held: string[] = [];
    return {
      async query<T = Record<string, unknown>>(
        sql: string | { text: string; values?: unknown[] },
        params?: unknown[],
      ): Promise<{ rows: T[]; rowCount: number }> {
        const text = typeof sql === "string" ? sql : sql.text;
        const values = typeof sql === "string" ? params ?? [] : sql.values ?? [];
        const head = text.trim().slice(0, 8).toUpperCase();
        if (head.startsWith("BEGIN")) return { rows: [] as T[], rowCount: 0 };
        if (head.startsWith("COMMIT") || head.startsWith("ROLLBACK")) {
          for (const key of held.splice(0)) release(key);
          return { rows: [] as T[], rowCount: 0 };
        }
        if (text.includes("pg_advisory_xact_lock")) {
          const key = String(values[0]);
          await acquire(key);
          held.push(key);
          return { rows: [{} as T], rowCount: 1 };
        }
        // Yield so concurrent transactions interleave unless serialized.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (text.includes("COALESCE(MAX(emv.version_number), 0) + 1")) {
          const contractId = String(values[0]);
          const max = versions
            .filter((v) => v.data_contract_id === contractId)
            .reduce((m, v) => Math.max(m, v.version_number), 0);
          return { rows: [{ next_number: max + 1 } as T], rowCount: 1 };
        }
        if (text.includes("INSERT INTO data_contract_versions")) {
          const contractId = String(values[1]);
          const versionNumber = Number(values[3]);
          if (
            versions.some(
              (v) =>
                v.data_contract_id === contractId &&
                v.version_number === versionNumber,
            )
          ) {
            throw new Error(
              'duplicate key value violates unique constraint "data_contract_versions_data_contract_id_version_number_key"',
            );
          }
          versions.push({ data_contract_id: contractId, version_number: versionNumber });
          return {
            rows: [
              {
                id: String(values[0]),
                data_contract_id: contractId,
                workspace_id: String(values[2]),
                version_number: versionNumber,
              } as T,
            ],
            rowCount: 1,
          };
        }
        if (head.startsWith("UPDATE")) return { rows: [] as T[], rowCount: 1 };
        throw new Error(`makeVersionRaceEngine: unexpected sql: ${text.slice(0, 80)}`);
      },
      release() {},
    } as unknown as pg.PoolClient;
  }

  // Mirrors lib/db.ts withTransaction: BEGIN → fn → COMMIT (ROLLBACK on
  // throw), so the emulated xact lock releases exactly at transaction end.
  async function withFakeTransaction<T>(
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = makeClient();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  return { versions, withFakeTransaction };
}

describe("data-contracts repository", () => {
  describe("createDataContract", () => {
    it("inserts with workspace + source + name and returns the row", async () => {
      const returnedRow = {
        id: "em_test",
        workspace_id: "ws_1",
        source_id: "src_1",
        route_id: null,
        name: "Stripe billing",
        status: "draft",
        current_version_id: null,
        created_by_user_id: "usr_1",
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
      };
      const { db, captured } = fakeDb([[returnedRow]]);
      const row = await createDataContract(
        {
          workspaceId: "ws_1",
          sourceId: "src_1",
          name: "Stripe billing",
          createdByUserId: "usr_1",
        },
        db,
      );
      expect(row).toEqual(returnedRow);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.sql).toMatch(/INSERT INTO data_contracts/);
      expect(captured[0]!.sql).toMatch(/'draft'/);
      const params = captured[0]!.params;
      expect(params[1]).toBe("ws_1");
      expect(params[2]).toBe("src_1");
      expect(params[4]).toBe("Stripe billing");
      expect(params[5]).toBe("usr_1");
      expect(String(params[0])).toMatch(/^em_/);
    });

    it("defaults nullable fields to null", async () => {
      const { db, captured } = fakeDb([
        [
          {
            id: "em_1",
            workspace_id: "ws_1",
            source_id: "src_1",
            route_id: null,
            name: "Map",
            status: "draft",
            current_version_id: null,
            created_by_user_id: null,
            created_at: "2026-05-15",
            updated_at: "2026-05-15",
          },
        ],
      ]);
      await createDataContract(
        { workspaceId: "ws_1", sourceId: "src_1", name: "Map" },
        db,
      );
      const params = captured[0]!.params;
      expect(params[3]).toBeNull();
      expect(params[5]).toBeNull();
    });
  });

  describe("getDataContract + listDataContractsForSource", () => {
    it("getDataContract scopes by workspace_id", async () => {
      const { db, captured } = fakeDb([[]]);
      await getDataContract("em_1", "ws_1", db);
      expect(captured[0]!.sql).toMatch(/FROM data_contracts/);
      expect(captured[0]!.sql).toMatch(
        /WHERE id = \$1 AND workspace_id = \$2/,
      );
      expect(captured[0]!.params).toEqual(["em_1", "ws_1"]);
    });

    it("listDataContractsForSource scopes by source", async () => {
      const { db, captured } = fakeDb([[]]);
      await listDataContractsForSource("ws_1", "src_1", db);
      expect(captured[0]!.sql).toMatch(
        /WHERE workspace_id = \$1 AND source_id = \$2/,
      );
      expect(captured[0]!.params).toEqual(["ws_1", "src_1"]);
    });
  });

  describe("updateDataContractStatus", () => {
    it("transitions status and touches updated_at", async () => {
      const { db, captured } = fakeDb([[]]);
      await updateDataContractStatus("em_1", "ws_1", "active", db);
      expect(captured[0]!.sql).toMatch(/UPDATE data_contracts/);
      expect(captured[0]!.sql).toMatch(/updated_at = now\(\)/);
      expect(captured[0]!.params).toEqual(["em_1", "ws_1", "active"]);
    });
  });

  describe("deleteDataContract", () => {
    it("scopes the DELETE by id + workspace and returns true on hit", async () => {
      // Inject a Queryable that returns rowCount=1 to simulate a hit.
      const captured: Array<{ sql: string; params: unknown[] }> = [];
      const db = {
        async query(sql: string, params?: unknown[]) {
          captured.push({ sql, params: params ?? [] });
          return { rows: [], rowCount: 1 };
        },
      };
      await expect(deleteDataContract("em_1", "ws_1", db)).resolves.toBe(true);
      expect(captured[0]!.sql).toMatch(/DELETE FROM data_contracts/);
      expect(captured[0]!.sql).toMatch(/WHERE id = \$1 AND workspace_id = \$2/);
      expect(captured[0]!.params).toEqual(["em_1", "ws_1"]);
    });

    it("returns false when nothing matched (404 case)", async () => {
      const db = {
        async query() {
          return { rows: [], rowCount: 0 };
        },
      };
      await expect(deleteDataContract("em_missing", "ws_1", db)).resolves.toBe(false);
    });
  });

  describe("appendDataContractVersion", () => {
    it("inserts version, updates parent.current_version_id, increments version_number", async () => {
      const version = {
        id: "emv_1",
        data_contract_id: "em_1",
        workspace_id: "ws_1",
        version_number: 3,
        inferred_schema: { event_types: [] },
        field_annotations: {},
        generated_filter: null,
        generated_transform: null,
        transform_language: null,
        destination_mapping: null,
        model_metadata: { model: "claude-haiku-4-5", prompt_version: "v1" },
        fixture_results: null,
        created_by_user_id: "usr_1",
        created_at: "2026-05-15",
      };
      const { client, captured } = fakePoolClient([
        [],
        [{ next_number: 3 }],
        [version],
        [],
      ]);
      const row = await appendDataContractVersion(
        {
          dataContractId: "em_1",
          workspaceId: "ws_1",
          inferredSchema: { event_types: [] },
          modelMetadata: { model: "claude-haiku-4-5", prompt_version: "v1" },
          createdByUserId: "usr_1",
        },
        client,
      );

      expect(row).toEqual(version);
      expect(captured).toHaveLength(4);

      // 1) Serialize concurrent appends: advisory xact lock keyed on the
      //    contract id, taken BEFORE the version number is computed.
      expect(captured[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
      expect(captured[0]!.params).toEqual(["em_1"]);

      // 2) Compute next version number.
      expect(captured[1]!.sql).toMatch(
        /COALESCE\(MAX\(emv\.version_number\), 0\) \+ 1/,
      );
      expect(captured[1]!.sql).toMatch(/em\.workspace_id = \$2/);
      expect(captured[1]!.params).toEqual(["em_1", "ws_1"]);

      // 3) Insert the new version.
      expect(captured[2]!.sql).toMatch(/INSERT INTO data_contract_versions/);
      const insertParams = captured[2]!.params;
      expect(insertParams[1]).toBe("em_1");
      expect(insertParams[2]).toBe("ws_1");
      expect(insertParams[3]).toBe(3);
      expect(JSON.parse(String(insertParams[4]))).toEqual({
        event_types: [],
        summary: "Observed 0 events across 0 event types and 0 fields. Stored values removed.",
      });
      // model_metadata JSON-stringified into params[10]
      expect(JSON.parse(String(insertParams[10]))).toEqual({
        model: "claude-haiku-4-5",
        prompt_version: "v1",
      });

      // 4) Parent points at the new version.
      expect(captured[3]!.sql).toMatch(/UPDATE data_contracts/);
      expect(captured[3]!.sql).toMatch(/current_version_id = \$3/);
      expect(captured[3]!.params).toEqual(["em_1", "ws_1", "emv_1"]);
    });

    it("starts at version_number 1 for a fresh data contract", async () => {
      const { client, captured } = fakePoolClient([
        [],
        [{ next_number: 1 }],
        [
          {
            id: "emv_first",
            data_contract_id: "em_1",
            workspace_id: "ws_1",
            version_number: 1,
            inferred_schema: {},
            field_annotations: {},
            generated_filter: null,
            generated_transform: null,
            transform_language: null,
            destination_mapping: null,
            model_metadata: {},
            fixture_results: null,
            created_by_user_id: null,
            created_at: "2026-05-15",
          },
        ],
        [],
      ]);
      const row = await appendDataContractVersion(
        {
          dataContractId: "em_1",
          workspaceId: "ws_1",
          inferredSchema: {},
          destinationMapping: null,
        },
        client,
      );
      expect(row.version_number).toBe(1);
      expect(captured[2]!.params[3]).toBe(1);
      expect(captured[2]!.params[9]).toBeNull();
    });

    it("refuses to append a version through a different workspace", async () => {
      const { client, captured } = fakePoolClient([[], [{ next_number: null }]]);
      await expect(
        appendDataContractVersion(
          {
            dataContractId: "em_foreign",
            workspaceId: "ws_attacker",
            inferredSchema: {},
          },
          client,
        ),
      ).rejects.toThrow(/not found in workspace/);
      expect(captured).toHaveLength(2);
      expect(captured[1]!.params).toEqual(["em_foreign", "ws_attacker"]);
    });

    it("serializes concurrent appends: sequential version numbers, no unique violation", async () => {
      const engine = makeVersionRaceEngine();
      const input = {
        dataContractId: "em_race",
        workspaceId: "ws_1",
        inferredSchema: { event_types: [] },
      };
      // Two appends racing on the same contract — exactly the page
      // auto-refresh vs. manual "Refresh now" vs. drift-cron auto-extend
      // scenario. The advisory xact lock must force one to wait for the
      // other's commit, so both land with consecutive version numbers
      // instead of the loser hitting UNIQUE (data_contract_id,
      // version_number).
      const [a, b] = await Promise.all([
        engine.withFakeTransaction((c) => appendDataContractVersion(input, c)),
        engine.withFakeTransaction((c) => appendDataContractVersion(input, c)),
      ]);
      expect([a.version_number, b.version_number].sort()).toEqual([1, 2]);
      expect(
        engine.versions
          .filter((v) => v.data_contract_id === "em_race")
          .map((v) => v.version_number)
          .sort(),
      ).toEqual([1, 2]);
    });

    it("does not serialize appends to DIFFERENT contracts against each other", async () => {
      const engine = makeVersionRaceEngine();
      const [a, b] = await Promise.all([
        engine.withFakeTransaction((c) =>
          appendDataContractVersion(
            { dataContractId: "em_a", workspaceId: "ws_1", inferredSchema: {} },
            c,
          ),
        ),
        engine.withFakeTransaction((c) =>
          appendDataContractVersion(
            { dataContractId: "em_b", workspaceId: "ws_1", inferredSchema: {} },
            c,
          ),
        ),
      ]);
      // Each contract gets its own version 1 — the lock key is per-contract.
      expect(a.version_number).toBe(1);
      expect(b.version_number).toBe(1);
    });
  });

  describe("listDataContractVersions", () => {
    it("returns versions newest first scoped to workspace", async () => {
      const { db, captured } = fakeDb([[]]);
      await listDataContractVersions("em_1", "ws_1", db);
      expect(captured[0]!.sql).toMatch(/FROM data_contract_versions/);
      expect(captured[0]!.sql).toMatch(/ORDER BY version_number DESC/);
      expect(captured[0]!.params).toEqual(["em_1", "ws_1"]);
    });
  });

  describe("fixtures", () => {
    it("insertDataContractFixture stores shape-only payloads without event references", async () => {
      const { db, captured } = fakeDb([
        [
          {
            id: "emf_1",
            data_contract_version_id: "emv_1",
            workspace_id: "ws_1",
            source_event_id: null,
            event_type: "invoice.paid",
            input_payload: { id: "in_1" },
            expected_output: { customer: "c_1" },
            created_at: "2026-05-15",
          },
        ],
      ]);
      await insertDataContractFixture(
        {
          dataContractVersionId: "emv_1",
          workspaceId: "ws_1",
          eventType: "invoice.paid",
          inputPayload: { id: "in_1" },
          expectedOutput: { customer: "c_1" },
        },
        db,
      );
      const params = captured[0]!.params;
      expect(captured[0]!.sql).toMatch(/INSERT INTO data_contract_fixtures/);
      expect(captured[0]!.sql).toMatch(/SELECT \$1, \$2, \$3, NULL, NULL/);
      expect(JSON.parse(String(params[3]))).toEqual({ id: "[STRING]" });
      expect(JSON.parse(String(params[4]))).toEqual({ customer: "[STRING]" });
    });

    it("listDataContractFixtures scopes by version + workspace", async () => {
      const { db, captured } = fakeDb([[]]);
      await listDataContractFixtures("emv_1", "ws_1", db);
      expect(captured[0]!.sql).toMatch(/FROM data_contract_fixtures/);
      expect(captured[0]!.params).toEqual(["emv_1", "ws_1"]);
    });
  });

  describe("drift events", () => {
    it("insertDriftEvent persists category + detail", async () => {
      const driftRow = {
        id: "42",
        data_contract_id: "em_1",
        data_contract_version_id: "emv_1",
        workspace_id: "ws_1",
        category: "new_event_type",
        field_path: null,
        detail: { example: "invoice.refunded" },
        sample_event_id: "evt_x",
        observed_at: "2026-05-15",
        resolved_at: null,
        resolved_by_user_id: null,
      };
      const { db, captured } = fakeDb([[driftRow]]);
      const row = await insertDriftEvent(
        {
          dataContractId: "em_1",
          dataContractVersionId: "emv_1",
          workspaceId: "ws_1",
          category: "new_event_type",
          detail: { example: "invoice.refunded" },
          sampleEventId: "evt_x",
        },
        db,
      );
      expect(row).toEqual(driftRow);
      expect(captured[0]!.sql).toMatch(
        /INSERT INTO data_contract_drift_events/,
      );
      expect(captured[0]!.params[3]).toBe("new_event_type");
      expect(JSON.parse(String(captured[0]!.params[5]))).toEqual({});
      expect(captured[0]!.sql).toMatch(/SELECT \$1, \$2, \$3, \$4, \$5, \$6::jsonb, NULL/);
    });

    it("listUnresolvedDriftEvents filters on resolved_at IS NULL", async () => {
      const { db, captured } = fakeDb([[]]);
      await listUnresolvedDriftEvents("ws_1", "em_1", db);
      expect(captured[0]!.sql).toMatch(/resolved_at IS NULL/);
      expect(captured[0]!.params).toEqual(["ws_1", "em_1"]);
    });

    it("resolveDriftEvent only updates unresolved rows", async () => {
      const { db, captured } = fakeDb([[]]);
      await resolveDriftEvent("42", "ws_1", "usr_1", db);
      expect(captured[0]!.sql).toMatch(/UPDATE data_contract_drift_events/);
      expect(captured[0]!.sql).toMatch(/resolved_at IS NULL/);
      expect(captured[0]!.params).toEqual(["42", "ws_1", "usr_1"]);
    });
  });
});
