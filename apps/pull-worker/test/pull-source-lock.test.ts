import { describe, expect, it } from "vitest";
import { tryAcquirePullSourceLock } from "@axel/shared";

describe("pull source advisory lock", () => {
  it("holds the checked-out PostgreSQL session until the lease is released", async () => {
    const client = new FakeClient(true);
    const lease = await tryAcquirePullSourceLock({ connect: async () => client }, "src_1");

    expect(lease).not.toBeNull();
    expect(client.releases).toBe(0);
    expect(client.calls[0]).toMatchObject({ params: ["axel.pull_source_sync", "src_1"] });

    await lease?.release();
    await lease?.release();

    expect(client.unlocks).toBe(1);
    expect(client.releases).toBe(1);
  });

  it("returns a contended session to the pool immediately", async () => {
    const client = new FakeClient(false);
    const lease = await tryAcquirePullSourceLock({ connect: async () => client }, "src_busy");

    expect(lease).toBeNull();
    expect(client.unlocks).toBe(0);
    expect(client.releases).toBe(1);
  });
});

class FakeClient {
  readonly calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  releases = 0;
  unlocks = 0;

  constructor(private readonly acquired: boolean) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (sql.includes("pg_advisory_unlock")) {
      this.unlocks += 1;
      return { rows: [] };
    }
    return { rows: [{ acquired: this.acquired } as T] };
  }

  release(): void {
    this.releases += 1;
  }
}
