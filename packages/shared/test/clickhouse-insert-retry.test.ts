import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertRows } from "../src/clickhouse-insert.js";

const env = { CLICKHOUSE_URL: "https://clickhouse.example.test" };

describe("ClickHouse insert retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a transport failure and succeeds without logging", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = insertRows(env, "delivery_attempts", [{ event_id: "evt_1" }]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    // The retry resends the identical row batch.
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it("retries 5xx and 429 responses, then reports the final status once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("origin timeout", { status: 520 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = insertRows(env, "events", [{ event_id: "evt_1" }]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[clickhouse] events insert 520 after 3 attempts");
  });

  it("waits before each retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("reset"))
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = insertRows(env, "events", [{ event_id: "evt_1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await pending;
  });

  it("does not retry a rejected row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Cannot parse row", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = insertRows(env, "events", [{ event_id: "evt_1" }]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[clickhouse] events insert 400");
  });

  it("does not retry a successful insert", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = insertRows(env, "events", [{ event_id: "evt_1" }]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
