import "server-only";
import { db } from "./db";
import { clickhouse, hasClickhouseUrl } from "./clickhouse";
import { GROWTH_ACTIVITY_SQL, GROWTH_WORKSPACES_SQL } from "./admin-growth-queries";
import { growthCohorts, type GrowthActivity, type GrowthWorkspace } from "./growth-cohorts";

/** Caller must pass requireSuperAdmin before starting these cross-workspace reads. */
export async function getGrowthReport() {
  const now = Date.now();
  const until = new Date(now).toISOString();
  const since = new Date(now - 28 * 86_400_000).toISOString();
  const { rows } = await db().query<GrowthWorkspace>(GROWTH_WORKSPACES_SQL, [since, until]);
  const workspaces = rows.slice(0, 1000);
  let activity: GrowthActivity[] = [];
  let available = hasClickhouseUrl();
  if (available && workspaces.length) {
    try {
      activity = (await clickhouse({ timeoutMs: 8000, retryTimeouts: false }).query<GrowthActivity>(GROWTH_ACTIVITY_SQL, {
        since, until,
        workspace_ids: JSON.stringify(workspaces.map((row) => row.id)),
        signup_times: JSON.stringify(workspaces.map((row) => row.created_at)),
      })).rows;
    } catch {
      available = false;
    }
  }
  return { since, until, available, truncated: rows.length > workspaces.length, cohorts: growthCohorts(workspaces, activity, now) };
}
