/**
 * FIFO / ordered delivery — per-key serialization core (Phase 2).
 *
 * This is the runtime-agnostic state machine behind the per-key Durable Object.
 * One instance serializes one `(workspace, source, ordering_key)` stream: it
 * holds the key's pending leaf-deliveries in durable storage and dispatches
 * exactly ONE at a time, only advancing to the next when the in-flight one
 * reaches a TERMINAL outcome (success, or dead-letter after its full retry
 * budget). A `retry` outcome is a no-op — the in-flight slot stays occupied, so
 * the head-of-line naturally blocks its successors *for this key only*. Other
 * keys are other instances and run fully in parallel.
 *
 * Why a separate pure core (not logic inside the DO class): router-edge has no
 * test runner, and a DO needs the workerd runtime to exercise. By isolating the
 * invariants here against an injected storage interface, we unit-test the
 * ordering guarantees deterministically under plain vitest (mirroring how
 * redact/ordering-key/subject-key are tested), and keep the CF wrapper a thin
 * delegation.
 *
 * Ordering correctness rests on the host providing SINGLE-THREADED execution
 * per instance (Cloudflare DOs do: one request at a time, input-gated). The
 * core does not add its own locking.
 *
 * Design choices, mirrored from the FIFO design doc:
 *  - Advance on actual DELIVERY outcome, never on enqueue.
 *  - Block via a stored pending queue (head-of-line), never via msg.retry()
 *    spin (which dies at the queue's max_retries).
 *  - A dead-lettered predecessor UNBLOCKS the key (liveness over an infinite
 *    stall) and records an ordering gap, rather than wedging forever.
 *  - report() is idempotent: a duplicate/stale report cannot double-advance.
 */

/** Minimal async KV surface — the subset of Cloudflare DO storage we use. */
export interface OrderingStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export type OrderingOutcome = "success" | "dead" | "retry";

/** A dispatched entry: the host-assigned sequence + the opaque leaf payload. */
export interface OrderingEntry<TLeaf> {
  seq: number;
  leaf: TLeaf;
}

export interface OrderingGap {
  seq: number;
  event_id: string;
}

export interface OrderingSnapshot {
  nextSeq: number;
  inFlightSeq: number | null;
  pendingSeqs: number[];
  gaps: OrderingGap[];
}

const SEQ_KEY = "seq";
const INFLIGHT_KEY = "inflight";
const PENDING_PREFIX = "p:";
const GAP_PREFIX = "gap:";
const SEQ_WIDTH = 16; // zero-pad so storage.list() returns pending in seq order

function pendingKey(seq: number): string {
  return PENDING_PREFIX + String(seq).padStart(SEQ_WIDTH, "0");
}
function gapKey(seq: number): string {
  return GAP_PREFIX + String(seq).padStart(SEQ_WIDTH, "0");
}

/**
 * Per-key ordered-delivery serializer. `dispatch` is invoked when an entry
 * becomes the single in-flight delivery — in the DO it sends the leaf to the
 * delivery queue / native HTTP; the delivery worker later calls `report` with
 * the terminal outcome. `dispatch` must be effectively idempotent (the same
 * entry can be re-dispatched after a crash); the delivery idempotency key
 * already provides this downstream.
 */
export class OrderingQueueCore<TLeaf = unknown> {
  constructor(
    private readonly storage: OrderingStorageLike,
    private readonly dispatch: (entry: OrderingEntry<TLeaf>) => Promise<void>,
  ) {}

  /** Append a leaf to the key's pending queue (assigning the next seq), then pump. */
  async enqueue(leaf: TLeaf): Promise<number> {
    const seq = (await this.storage.get<number>(SEQ_KEY)) ?? 0;
    await this.storage.put(SEQ_KEY, seq + 1);
    await this.storage.put(pendingKey(seq), leaf);
    await this.pump();
    return seq;
  }

  /**
   * Report the terminal (or retry) outcome of the in-flight delivery. Stale or
   * duplicate reports (seq != current in-flight) are ignored, so a lost ack
   * followed by a retried report cannot double-advance the cursor.
   */
  async report(seq: number, outcome: OrderingOutcome): Promise<void> {
    const inFlight = await this.storage.get<number>(INFLIGHT_KEY);
    if (inFlight === undefined || inFlight !== seq) return; // stale / duplicate
    if (outcome === "retry") return; // keep the slot — head-of-line blocks successors

    const leaf = await this.storage.get<TLeaf>(pendingKey(seq));
    if (outcome === "dead") {
      const eventId = extractEventId(leaf);
      await this.storage.put(gapKey(seq), { seq, event_id: eventId });
    }
    await this.storage.delete(pendingKey(seq));
    await this.storage.delete(INFLIGHT_KEY);
    await this.pump();
  }

  /** Dispatch the head of the pending queue if nothing is in flight. */
  private async pump(): Promise<void> {
    const inFlight = await this.storage.get<number>(INFLIGHT_KEY);
    if (inFlight !== undefined) return; // one in flight already — wait for report

    const head = await this.head();
    if (head === null) return; // nothing pending

    await this.storage.put(INFLIGHT_KEY, head.seq);
    try {
      await this.dispatch(head);
    } catch (err) {
      // Dispatch failed before the delivery worker took ownership — release the
      // slot so a later enqueue/report re-pumps the same head (idempotent).
      await this.storage.delete(INFLIGHT_KEY);
      throw err;
    }
  }

  private async head(): Promise<OrderingEntry<TLeaf> | null> {
    const pending = await this.storage.list<TLeaf>({ prefix: PENDING_PREFIX });
    for (const [key, leaf] of pending) {
      const seq = Number(key.slice(PENDING_PREFIX.length));
      return { seq, leaf };
    }
    return null;
  }

  /** Read-only view for observability / tests. */
  async snapshot(): Promise<OrderingSnapshot> {
    const nextSeq = (await this.storage.get<number>(SEQ_KEY)) ?? 0;
    const inFlight = await this.storage.get<number>(INFLIGHT_KEY);
    const pending = await this.storage.list<TLeaf>({ prefix: PENDING_PREFIX });
    const pendingSeqs = [...pending.keys()].map((k) => Number(k.slice(PENDING_PREFIX.length)));
    const gapMap = await this.storage.list<OrderingGap>({ prefix: GAP_PREFIX });
    return {
      nextSeq,
      inFlightSeq: inFlight ?? null,
      pendingSeqs,
      gaps: [...gapMap.values()],
    };
  }
}

function extractEventId(leaf: unknown): string {
  if (leaf && typeof leaf === "object" && "event_id" in leaf) {
    const id = (leaf as { event_id: unknown }).event_id;
    if (typeof id === "string") return id;
  }
  return "";
}
