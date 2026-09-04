import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      connect = mocks.connect;
      query = mocks.query;
      on = vi.fn();
    },
  },
}));

import { db, withTransaction } from "../lib/db";

describe("database retry boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
    delete globalThis.__axelDashboardPoolV2;
    mocks.connect.mockReset();
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  afterEach(() => {
    delete globalThis.__axelDashboardPoolV2;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("retries acquisition before sending SQL, including pg's callback overload", async () => {
    const client = { query: mocks.query, release: mocks.release };
    mocks.connect.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue(client);
    const callback = vi.fn();
    const result = db().connect(callback);
    expect(result).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined, client, mocks.release);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(["timeout exceeded when trying to connect", "authentication failed"])(
    "does not retry acquisition when %s", async (message) => {
      const error = new Error(message);
      mocks.connect.mockRejectedValue(error);
      await expect(db().connect()).rejects.toBe(error);
      expect(mocks.connect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not replay a query after a lost response, even for SELECT functions", async () => {
    const error = new Error("Connection terminated unexpectedly");
    mocks.query.mockRejectedValue(error);
    await expect(db().query("SELECT consume_rate_token($1)", ["ws_test"])).rejects.toBe(error);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the transaction failure and discards a client when rollback fails", async () => {
    const original = new Error("write failed");
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Connection terminated"));
    await expect(withTransaction(async () => { throw original; })).rejects.toBe(original);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("commits and releases a successful transaction once", async () => {
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockResolvedValue({});
    await expect(withTransaction(async () => 42)).resolves.toBe(42);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
