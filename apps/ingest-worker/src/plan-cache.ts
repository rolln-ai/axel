import type { WorkspacePlanState } from "@axel/shared";
import type { KVNamespaceLike } from "./source-cache.js";

/**
 * Edge cache for per-workspace billing gates.
 *
 * The hot path of the ingest worker needs to know whether a
 * workspace is currently allowed to ingest (and whether it would
 * incur overage billing on Pro, or be hard-blocked on Free). That
 * answer lives in Postgres in the control plane — querying it on
 * every accepted webhook would pin the DB.
 *
 * Same pattern as source-cache.ts but with a SHORTER positive TTL
 * (default 5 min) because plan state changes more often than source
 * config: every hourly billing rollup, every Stripe subscription
 * webhook, every operator suspend/unsuspend. The dashboard pushes
 * the fresh state to /admin/workspace-plan/put after each of those
 * events so the edge converges within seconds — the TTL is the
 * safety net for any missed push.
 *
 * The cache is permissive on miss: if KV is down or the entry
 * hasn't been written yet, the worker treats the workspace as
 * `accept` rather than blocking it. Refusing legitimate traffic
 * because the plan cache is empty would be worse than letting an
 * over-cap workspace ingest a few extra events until the next push.
 */

export interface PlanCache {
  get(workspaceId: string): Promise<WorkspacePlanState | null>;
  put(workspaceId: string, state: WorkspacePlanState, ttlSeconds: number): Promise<void>;
  invalidate(workspaceId: string): Promise<void>;
}

const KV_KEY_PREFIX = "ws-plan:";

export function kvPlanCache(kv: KVNamespaceLike): PlanCache {
  return {
    async get(workspaceId) {
      try {
        const raw = await kv.get(`${KV_KEY_PREFIX}${workspaceId}`, "text");
        if (typeof raw !== "string") return null;
        const parsed = JSON.parse(raw) as WorkspacePlanState;
        if (
          !parsed
          || typeof parsed.workspace_id !== "string"
          || (parsed.plan !== "free" && parsed.plan !== "pro" && parsed.plan !== "enterprise")
          || (parsed.gate !== "accept" && parsed.gate !== "reject_quota" && parsed.gate !== "reject_suspended")
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    async put(workspaceId, state, ttlSeconds) {
      try {
        await kv.put(`${KV_KEY_PREFIX}${workspaceId}`, JSON.stringify(state), {
          // KV minimum TTL is 60s.
          expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
        });
      } catch {
        // Best-effort write. The dashboard's next push will fill the gap.
      }
    },
    async invalidate(workspaceId) {
      try {
        await kv.delete(`${KV_KEY_PREFIX}${workspaceId}`);
      } catch {
        // TTL will sweep it within `ttlSeconds` worst-case.
      }
    },
  };
}

/** In-memory cache for tests + local dev. Honours TTL via an injectable clock. */
export function inMemoryPlanCache(now: () => number = Date.now): PlanCache & {
  size(): number;
} {
  const store = new Map<string, { state: WorkspacePlanState; expiresAt: number }>();
  return {
    async get(workspaceId) {
      const entry = store.get(workspaceId);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(workspaceId);
        return null;
      }
      return entry.state;
    },
    async put(workspaceId, state, ttlSeconds) {
      store.set(workspaceId, {
        state,
        expiresAt: now() + ttlSeconds * 1000,
      });
    },
    async invalidate(workspaceId) {
      store.delete(workspaceId);
    },
    size() {
      return store.size;
    },
  };
}
