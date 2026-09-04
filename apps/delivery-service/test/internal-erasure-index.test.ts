import { describe, expect, it, vi } from "vitest";
import {
  handleInternalErasureIndexRequest,
  type ErasureIndexPool,
} from "../src/internal-erasure-index.js";

const SECRET = "internal-erasure-test-secret"; // gitleaks:allow
const PREVIOUS_SECRET = "internal-erasure-previous-secret"; // gitleaks:allow
const SUBJECT_ID = `sub_${"a".repeat(64)}`;
const VALID_BODY = {
  source_id: "src_1",
  subject_ids: [SUBJECT_ID],
  event_id: "evt_1",
  r2_key: "events/ws_1/2026-08-27/evt_1",
  received_at: "2026-08-27T20:00:00.000Z",
};

function request(body: unknown, secret: string = SECRET) {
  return {
    providedSecret: secret,
    readBody: vi.fn(async () => JSON.stringify(body)),
  };
}

function pool(rows: Array<{ source_exists: boolean; r2_key_matches: boolean }> = [
  { source_exists: true, r2_key_matches: true },
]): ErasureIndexPool & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as ErasureIndexPool & { query: ReturnType<typeof vi.fn> };
}

describe("POST /internal/erasure-subjects", () => {
  it("authenticates before reading the request body", async () => {
    const req = request(VALID_BODY, "wrong-secret"); // gitleaks:allow
    const result = await handleInternalErasureIndexRequest(req, {
      sharedSecret: SECRET,
      pool: pool(),
    });
    expect(result).toMatchObject({
      status: 401,
      body: { ok: false, error: "unauthorized" },
    });
    expect(req.readBody).not.toHaveBeenCalled();
  });

  it("accepts the explicit previous secret during rotation", async () => {
    const result = await handleInternalErasureIndexRequest(
      request(VALID_BODY, PREVIOUS_SECRET),
      { sharedSecret: SECRET, previousSharedSecret: PREVIOUS_SECRET, pool: pool() },
    );
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("derives the workspace from the source and binds the R2 key in SQL", async () => {
    const database = pool();
    const result = await handleInternalErasureIndexRequest(request(VALID_BODY), {
      sharedSecret: SECRET,
      pool: database,
    });
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(database.query).toHaveBeenCalledOnce();
    const [sql, values] = database.query.mock.calls[0]!;
    expect(sql).toContain("SELECT workspace_id");
    expect(sql).toContain("WHERE id = $1");
    expect(sql).toContain("events/");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(values).toEqual([
      VALID_BODY.source_id,
      VALID_BODY.subject_ids,
      VALID_BODY.event_id,
      VALID_BODY.r2_key,
      VALID_BODY.received_at,
    ]);
    expect(values).not.toContain("ws_1");
  });

  it.each([
    ["extra workspace override", { ...VALID_BODY, workspace_id: "ws_other" }],
    ["malformed subject", { ...VALID_BODY, subject_ids: ["raw@example.com"] }],
    ["duplicate subjects", { ...VALID_BODY, subject_ids: [SUBJECT_ID, SUBJECT_ID] }],
    ["empty subjects", { ...VALID_BODY, subject_ids: [] }],
    ["control characters", { ...VALID_BODY, event_id: "evt_1\nforged" }],
    ["invalid time", { ...VALID_BODY, received_at: "tomorrow-ish" }],
  ])("rejects %s before querying Postgres", async (_label, body) => {
    const database = pool();
    const result = await handleInternalErasureIndexRequest(request(body), {
      sharedSecret: SECRET,
      pool: database,
    });
    expect(result).toMatchObject({
      status: 400,
      body: { ok: false, error: "invalid_body" },
    });
    expect(database.query).not.toHaveBeenCalled();
  });

  it("rejects an unknown source and a cross-workspace R2 key", async () => {
    const missing = await handleInternalErasureIndexRequest(request(VALID_BODY), {
      sharedSecret: SECRET,
      pool: pool([{ source_exists: false, r2_key_matches: false }]),
    });
    expect(missing).toMatchObject({
      status: 404,
      body: { ok: false, error: "source_not_found" },
    });

    const mismatched = await handleInternalErasureIndexRequest(request(VALID_BODY), {
      sharedSecret: SECRET,
      pool: pool([{ source_exists: true, r2_key_matches: false }]),
    });
    expect(mismatched).toMatchObject({
      status: 400,
      body: { ok: false, error: "invalid_r2_key" },
    });
  });

  it("returns a fixed error without exposing database details", async () => {
    const onError = vi.fn();
    const database = {
      query: vi.fn(async () => {
        throw new Error("password and database host must stay private");
      }),
    } as unknown as ErasureIndexPool;
    const result = await handleInternalErasureIndexRequest(request(VALID_BODY), {
      sharedSecret: SECRET,
      pool: database,
      onError,
    });
    expect(result).toMatchObject({
      status: 503,
      body: { ok: false, error: "erasure_index_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(onError).toHaveBeenCalledOnce();
  });
});
