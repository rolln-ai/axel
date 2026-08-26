import { beforeEach, describe, expect, it, } from "vitest";
import { OrderingQueueCore, type OrderingEntry, type OrderingStorageLike } from "@axel/shared";

// In-memory stand-in for Cloudflare Durable Object storage: list() returns keys
// in lexicographic order (as DO storage does), which is what makes the padded
// pending keys come back in seq order.
class FakeStorage implements OrderingStorageLike {
  private map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const out = new Map<string, T>();
    for (const k of keys) out.set(k, structuredClone(this.map.get(k)) as T);
    return out;
  }
}

type Leaf = { event_id: string };
const leaf = (id: string): Leaf => ({ event_id: id });

function makeCore(storage: OrderingStorageLike) {
  const dispatched: OrderingEntry<Leaf>[] = [];
  const core = new OrderingQueueCore<Leaf>(storage, async (entry) => {
    dispatched.push(entry);
  });
  return { core, dispatched };
}

describe("OrderingQueueCore", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("dispatches only the head when several same-key events enqueue", async () => {
    const { core, dispatched } = makeCore(storage);
    await core.enqueue(leaf("A"));
    await core.enqueue(leaf("B"));
    await core.enqueue(leaf("C"));

    expect(dispatched.map((d) => d.leaf.event_id)).toEqual(["A"]);
    const snap = await core.snapshot();
    expect(snap.inFlightSeq).toBe(0);
    expect(snap.pendingSeqs).toEqual([0, 1, 2]);
  });

  it("advances to the next only on terminal success", async () => {
    const { core, dispatched } = makeCore(storage);
    await core.enqueue(leaf("A"));
    await core.enqueue(leaf("B"));

    await core.report(0, "success");
    expect(dispatched.map((d) => d.leaf.event_id)).toEqual(["A", "B"]);
    const snap = await core.snapshot();
    expect(snap.inFlightSeq).toBe(1);
    expect(snap.pendingSeqs).toEqual([1]);
    expect(snap.gaps).toEqual([]);
  });

  it("a retrying head blocks its successors (no advance on retry)", async () => {
    const { core, dispatched } = makeCore(storage);
    await core.enqueue(leaf("A"));
    await core.enqueue(leaf("B"));

    await core.report(0, "retry");
    // B must NOT be dispatched while A is still retrying.
    expect(dispatched.map((d) => d.leaf.event_id)).toEqual(["A"]);
    expect((await core.snapshot()).inFlightSeq).toBe(0);
  });

  it("a dead-lettered predecessor unblocks the key and records a gap", async () => {
    const { core, dispatched } = makeCore(storage);
    await core.enqueue(leaf("A"));
    await core.enqueue(leaf("B"));

    await core.report(0, "dead");
    expect(dispatched.map((d) => d.leaf.event_id)).toEqual(["A", "B"]);
    const snap = await core.snapshot();
    expect(snap.inFlightSeq).toBe(1);
    expect(snap.gaps).toEqual([{ seq: 0, event_id: "A" }]);
  });

  it("ignores stale / duplicate reports (no double-advance)", async () => {
    const { core, dispatched } = makeCore(storage);
    await core.enqueue(leaf("A"));
    await core.enqueue(leaf("B"));
    await core.enqueue(leaf("C"));

    await core.report(0, "success"); // A done -> B in flight
    await core.report(0, "success"); // stale duplicate -> ignored
    await core.report(0, "dead"); // stale -> ignored

    expect(dispatched.map((d) => d.leaf.event_id)).toEqual(["A", "B"]);
    const snap = await core.snapshot();
    expect(snap.inFlightSeq).toBe(1); // still B, did not skip to C
    expect(snap.gaps).toEqual([]);
  });

  it("survives reconstruction from storage (durable state)", async () => {
    const first = makeCore(storage);
    await first.core.enqueue(leaf("A"));
    await first.core.enqueue(leaf("B"));

    // New core instance over the SAME storage — as if the DO was evicted+rehydrated.
    const second = makeCore(storage);
    const snap = await second.core.snapshot();
    expect(snap.inFlightSeq).toBe(0);
    expect(snap.pendingSeqs).toEqual([0, 1]);

    await second.core.report(0, "success");
    expect(second.dispatched.map((d) => d.leaf.event_id)).toEqual(["B"]);
    expect((await second.core.snapshot()).inFlightSeq).toBe(1);
  });

  it("different keys are independent — each dispatches its own head immediately", async () => {
    const k1 = makeCore(new FakeStorage());
    const k2 = makeCore(new FakeStorage());
    await k1.core.enqueue(leaf("A1"));
    await k2.core.enqueue(leaf("A2"));
    expect(k1.dispatched.map((d) => d.leaf.event_id)).toEqual(["A1"]);
    expect(k2.dispatched.map((d) => d.leaf.event_id)).toEqual(["A2"]);
  });

  it("releases the in-flight slot if dispatch throws, so it re-pumps later", async () => {
    const dispatched: string[] = [];
    let failNext = true;
    const core = new OrderingQueueCore<Leaf>(storage, async (entry) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient dispatch failure");
      }
      dispatched.push(entry.leaf.event_id);
    });

    await expect(core.enqueue(leaf("A"))).rejects.toThrow("transient dispatch failure");
    // Slot was released — nothing in flight, A still pending.
    let snap = await core.snapshot();
    expect(snap.inFlightSeq).toBeNull();
    expect(snap.pendingSeqs).toEqual([0]);

    // A later enqueue re-pumps the head (A), which now dispatches.
    await core.enqueue(leaf("B"));
    expect(dispatched).toEqual(["A"]);
    snap = await core.snapshot();
    expect(snap.inFlightSeq).toBe(0);
    expect(snap.pendingSeqs).toEqual([0, 1]);
  });
});
