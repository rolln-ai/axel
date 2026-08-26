// Breach handler. When the declarative engine fails to evaluate a route
// (invalid JSON, unsafe path, unknown DSL kind, etc.), the router must:
//
//   1. mark the route `errored` in the control plane so subsequent
//      traffic skips it until an operator re-enables it
//   2. push the original event onto the dead-letter queue (carrying the
//      stable RouteEngineError reason so support can triage)
//   3. NEVER block ingest. The ingest worker has already returned 202
//      to the sender by the time the router sees the message.

export interface DeadLetterRecord {
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  r2_key: string;
  reason: string;
  message: string;
  errored_at: string;
}

export interface RouteStatusStore {
  markErrored(routeId: string, reason: string, message: string): Promise<void>;
}

export interface DeadLetterSink {
  push(record: DeadLetterRecord): Promise<void>;
}

export interface BreachContext {
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  r2_key: string;
}

export interface Breach {
  reason: string;
  message: string;
}

export interface BreachHandlerDeps {
  routes: RouteStatusStore;
  deadLetter: DeadLetterSink;
  now?: () => Date;
}

export async function handleBreach(
  deps: BreachHandlerDeps,
  ctx: BreachContext,
  breach: Breach,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let markError: unknown = null;
  try {
    await deps.routes.markErrored(ctx.route_id, breach.reason, breach.message);
  } catch (err) {
    markError = err;
  }
  // Always attempt the dead-letter push, even if marking errored failed —
  // losing the event is worse than leaving the route hot for one more message.
  await deps.deadLetter.push({
    workspace_id: ctx.workspace_id,
    event_id: ctx.event_id,
    source_id: ctx.source_id,
    route_id: ctx.route_id,
    r2_key: ctx.r2_key,
    reason: breach.reason,
    message: breach.message,
    errored_at: now,
  });
  if (markError) {
    throw markError;
  }
}

export function inMemoryRouteStatusStore(): RouteStatusStore & {
  errored: Map<string, { reason: string; message: string }>;
} {
  const errored = new Map<string, { reason: string; message: string }>();
  return {
    errored,
    async markErrored(routeId, reason, message) {
      errored.set(routeId, { reason, message });
    },
  };
}

export function inMemoryDeadLetterSink(): DeadLetterSink & { records: DeadLetterRecord[] } {
  const records: DeadLetterRecord[] = [];
  return {
    records,
    async push(record) {
      records.push(record);
    },
  };
}
