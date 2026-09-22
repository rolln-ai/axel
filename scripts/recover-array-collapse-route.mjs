#!/usr/bin/env node
// Run only after deploying the reviewed engine to live and replay routers.
// Payloads stay in memory; stdout contains counts and fixed status codes only.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { cloudflareR2ObjectUrl, executeGraph, isCanonicalRawPayloadKey, parsePipelineGraph } from "../packages/shared/dist/index.js";
import { readResponseBytesLimited } from "../apps/delivery-service/src/cli-bounded-io.ts";
import { enqueueReplays } from "../apps/dashboard/lib/replay-enqueue.ts";
import { writeAudit } from "../apps/dashboard/lib/audit.ts";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { validateRouteScope } from "./inspect-route-health.mjs";

const REASON = "transform_collapse_array_expected_array";
const fail = (code = "precondition_failed") => { throw new Error(`route_recovery_${code}`); };
// These fixed stages and allowlisted codes are safe in public workflow logs.
const safeCodes = new Set(["precondition_failed", "route_state_changed", "destination_unavailable", "failure_set_invalid", "stale_timestamp", "payload_key_mismatch", "unexpected_delivery_count", "concurrent_state_change", "muted_failure"].map(code => `route_recovery_${code}`));
export function recoveryErrorCode(error) {
  if (safeCodes.has(error?.message)) return error.message;
  if (/^[0-9A-Z]{5}$/.test(error?.code ?? "")) return `postgres_${error.code}`;
  return "operation_failed";
}

async function loadState(client, workspaceId, routeId, lock = false) {
  const route = (await client.query(`SELECT r.source_id, r.status, r.error_reason,
      r.pipeline_graph::text AS graph, r.updated_at::text AS updated_at
    FROM routes r JOIN sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
    JOIN workspaces w ON w.id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND s.status='active' AND w.status='active'
    ${lock ? "FOR UPDATE OF r FOR SHARE OF s,w" : ""}`, [workspaceId, routeId])).rows[0];
  if (!route || route.status !== "errored" || route.error_reason !== REASON || !route.graph) fail("route_state_changed");
  const destinations = (await client.query(`SELECT d.id, d.status, d.delivery_paused, d.circuit_state
    FROM route_destinations rd JOIN destinations d ON d.id=rd.destination_id
    WHERE rd.route_id=$1 AND d.workspace_id=$2 ${lock ? "FOR SHARE OF d" : ""}`, [routeId, workspaceId])).rows;
  // This recovery is intentionally restricted to a single destination.
  if (destinations.length !== 1 || destinations.some(d => d.status !== "active" || d.delivery_paused || d.circuit_state !== "closed")) fail("destination_unavailable");
  const graph = parsePipelineGraph(route.graph, { attached_destination_ids: new Set(destinations.map(d => d.id)) });
  const failures = (await client.query(`SELECT id::text, event_id, source_id, r2_key, destination_id
    FROM dead_letters WHERE workspace_id=$1 AND route_id=$2 AND source_id=$3 AND resolved_at IS NULL
    ORDER BY id LIMIT 21 ${lock ? "FOR UPDATE" : ""}`, [workspaceId, routeId, route.source_id])).rows;
  if (failures.length === 0 || failures.length > 20 || failures.some(f => f.destination_id && f.destination_id !== destinations[0].id)) fail("failure_set_invalid");
  return { route, destinations, graph, failures };
}

export async function recoverArrayCollapseRoute(client, options) {
  const { workspaceId, routeId, expectedUpdatedAt, readPayload, runUrl, onStage = () => {} } = options;
  onStage("validate_scope");
  validateRouteScope(workspaceId, routeId);
  if (!Number.isFinite(Date.parse(expectedUpdatedAt)) || !/^https:\/\/github\.com\/rolln-ai\/axel\/actions\/runs\/\d+$/.test(runUrl)) fail();
  onStage("read_current_state");
  let before;
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    before = await loadState(client, workspaceId, routeId);
  } finally { await client.query("ROLLBACK"); }
  if (Date.parse(before.route.updated_at) !== Date.parse(expectedUpdatedAt)) fail("stale_timestamp");
  for (const row of before.failures) {
    onStage("validate_payload_key");
    if (!isCanonicalRawPayloadKey(row.r2_key, { workspaceId, sourceId: row.source_id, eventId: row.event_id })) fail("payload_key_mismatch");
    onStage("read_retained_payload");
    const payload = await readPayload(row.r2_key);
    onStage("validate_retained_transform");
    if (executeGraph(payload, before.graph).deliveries.length !== 1) fail("unexpected_delivery_count");
  }
  onStage("lock_current_state");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const current = await loadState(client, workspaceId, routeId, true);
    // Re-read after network IO: changed graphs, control state, or failure sets
    // invalidate this review. No blind enabling after a concurrent mutation.
    if (JSON.stringify(current) !== JSON.stringify(before)) fail("concurrent_state_change");
    onStage("resume_route");
    const result = await client.query(`UPDATE routes SET status='active', error_reason=NULL, error_message=NULL, updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND updated_at=$3::timestamptz AND status='errored'`,
    [workspaceId, routeId, before.route.updated_at]);
    if (result.rowCount !== 1) fail();
    onStage("enqueue_replays");
    const replay = await enqueueReplays(client, {
      workspaceId, actorUserId: null, reason: "array_collapse_route_recovery",
      candidates: { sql: `SELECT DISTINCT ON (event_id) event_id,source_id,r2_key,'route'::text AS scope,route_id,
        NULL::text AS destination_id, reason AS failure_reason, fingerprint
        FROM dead_letters WHERE workspace_id=$1 AND route_id=$2 AND id=ANY($3::bigint[]) AND resolved_at IS NULL ORDER BY event_id,id`,
      params: [workspaceId, routeId, before.failures.map(f => f.id)] },
      audit: { action: "route.recovery_replays_queued", targetType: "route", targetId: routeId, metadata: { run_url: runUrl } },
    });
    if (replay.mutedSkipped > 0) fail("muted_failure");
    await writeAudit(client, { workspaceId, actorUserId: null, action: "route.status_changed", targetType: "route", targetId: routeId,
      metadata: { status: "active", recovery_reason: REASON, run_url: runUrl, validated_failures: before.failures.length } });
    onStage("commit_recovery");
    await client.query("COMMIT");
    return { status: "resumed", validated_failures: before.failures.length, replays_queued: replay.queued, already_in_flight: replay.inFlightSkipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

let currentStage = "connect_database";
async function main() {
  const env = process.env;
  if (env.ROUTE_RECOVERY_CONFIRM !== "resume-reviewed-route" || !env.DATABASE_URL || !env.CLOUDFLARE_API_TOKEN
      || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) fail();
  const client = new pg.Client({ connectionString: env.DATABASE_URL,
    ssl: controlPlanePgSslOption(env.DATABASE_URL, env.DATABASE_TLS_VERIFY), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await recoverArrayCollapseRoute(client, {
      onStage: stage => { currentStage = stage; },
      workspaceId: env.ROUTE_HEALTH_WORKSPACE_ID, routeId: env.ROUTE_HEALTH_ROUTE_ID,
      expectedUpdatedAt: env.ROUTE_RECOVERY_EXPECTED_UPDATED_AT,
      runUrl: `https://github.com/rolln-ai/axel/actions/runs/${env.GITHUB_RUN_ID}`,
      readPayload: async key => {
        const response = await fetch(cloudflareR2ObjectUrl(env.CLOUDFLARE_ACCOUNT_ID, "axel-events-raw", key), {
          headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) fail();
        return JSON.parse(new TextDecoder().decode(await readResponseBytesLimited(response, 6 * 1024 * 1024)));
      },
    });
    console.log(JSON.stringify(result));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ status: "route_recovery_failed_inspect_current_state_before_retry", stage: currentStage, code: recoveryErrorCode(error) })); process.exitCode = 1; });
}
