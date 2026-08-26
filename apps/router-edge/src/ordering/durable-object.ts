/**
 * FIFO / ordered delivery — per-key Durable Object (Phase 2).
 *
 * THE FIRST DURABLE OBJECT IN THIS CODEBASE. It is a thin wrapper: all ordering
 * logic lives in the runtime-agnostic, unit-tested `OrderingQueueCore`
 * (@axel/shared). One DO instance per `(workspace, source, ordering_key)` —
 * addressed via `idFromName(ordering_key)` — holds that key's pending deliveries
 * and dispatches exactly one at a time, advancing only when the delivery worker
 * reports a terminal outcome.
 *
 * RPC surface (over `fetch`, JSON body):
 *   { op: "enqueue", leaf: OrderingLeaf }      -> { seq }
 *   { op: "report", seq, outcome }             -> { ok: true }   (outcome: success|dead|retry)
 *   { op: "snapshot" }                         -> OrderingSnapshot
 *
 * STATUS: scaffold. The class + binding exist and are unit-tested at the core
 * level, but the CALL SITES ARE NOT YET WIRED (see ordering/README for the plan).
 * Wiring enqueue (router-edge) and report (delivery-edge + delivery-service)
 * MUST land together — an enqueued ordered event that is never reported would
 * stall its key. Nothing reaches this DO until that wiring ships and a source
 * sets `ordering_enabled`, so it is inert.
 */

import { OrderingQueueCore, type DestinationQueueMessage, type OrderingOutcome } from "@axel/shared";

/** What the DO stores per pending delivery: the queue message + a cheap id for gap logging. */
export interface OrderingLeaf {
  event_id: string;
  message: DestinationQueueMessage;
}

export interface OrderingDoEnv {
  DELIVERY_QUEUE: Queue<DestinationQueueMessage>;
}

interface EnqueueOp {
  op: "enqueue";
  leaf: OrderingLeaf;
}
interface ReportOp {
  op: "report";
  seq: number;
  outcome: OrderingOutcome;
}
interface SnapshotOp {
  op: "snapshot";
}
type OrderingOp = EnqueueOp | ReportOp | SnapshotOp;

export class OrderingDurableObject {
  private readonly core: OrderingQueueCore<OrderingLeaf>;

  constructor(
    private readonly state: DurableObjectState,
    env: OrderingDoEnv,
  ) {
    this.core = new OrderingQueueCore<OrderingLeaf>(this.state.storage, async (entry) => {
      // Dispatch the head delivery to the existing edge delivery queue, stamped
      // with the ordering token the delivery worker echoes back via `report`.
      const ordering_token = `${this.state.id.toString()}:${entry.seq}`;
      await env.DELIVERY_QUEUE.send({ ...entry.leaf.message, ordering_token }, { contentType: "json" });
    });
  }

  async fetch(request: Request): Promise<Response> {
    let body: OrderingOp;
    try {
      body = (await request.json()) as OrderingOp;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    switch (body.op) {
      case "enqueue": {
        const seq = await this.core.enqueue(body.leaf);
        return jsonResponse({ seq });
      }
      case "report": {
        await this.core.report(body.seq, body.outcome);
        return jsonResponse({ ok: true });
      }
      case "snapshot": {
        return jsonResponse(await this.core.snapshot());
      }
      default:
        return jsonResponse({ error: "unknown_op" }, 400);
    }
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
