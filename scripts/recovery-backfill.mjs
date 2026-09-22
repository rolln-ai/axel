#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { writeAudit } from "../apps/dashboard/lib/audit.ts";
import { recoveryRouteReady, recoveryDeliveryState } from "../apps/delivery-service/src/recovery-backfill.ts";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { validateRouteScope } from "./inspect-route-health.mjs";

const fail = () => { throw new Error("recovery_backfill_precondition_failed"); };
export function safeRecoveryError(value) {
  if (/^(?:r2_(?:get|put|delete)|queue_enqueue|http_error)_[1-5][0-9]{2}$/.test(value ?? "")) return value;
  if (["recovery_delivery_failed", "recovery_route_unavailable_or_changed", "raw_payload_key_mismatch",
    "replay_payload_key_mismatch", "fetch failed", "rate_limited", "operation_timeout", "operation_failed", "connection_failed", "not_found", "authorization_failed", "payload_too_large", "queue_overloaded", "invalid_payload", "delivery_failed"].includes(value)) return value;
  if(value === "Replay produced no delivery attempts.") return "no_delivery_attempts";
  return value == null ? null : "unrecognized_error";
}
export async function inspectRecoveryBackfill(client, workspaceId, routeId) {
  validateRouteScope(workspaceId, routeId);
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    const jobs=(await client.query(`SELECT b.id,b.state,b.error_message,b.since,b.until,b.total_estimated,b.enqueued,b.skipped,
      b.cursor_received_at,b.started_at,b.finished_at,
      count(*) FILTER (WHERE rr.state='pending')::int AS pending,
      count(*) FILTER (WHERE rr.state='in_progress')::int AS in_progress,
      count(*) FILTER (WHERE rr.state='done')::int AS delivered,
      count(*) FILTER (WHERE rr.state='failed')::int AS failed
      FROM backfill_jobs b LEFT JOIN replay_requests rr ON rr.backfill_job_id=b.id
      WHERE b.workspace_id=$1 AND b.route_id=$2 AND b.recovery_destination_id IS NOT NULL
      GROUP BY b.id ORDER BY b.requested_at DESC LIMIT 5`, [workspaceId, routeId])).rows;
    for(const job of jobs) {
      job.error_message=safeRecoveryError(job.error_message);
      const failures=(await client.query(`SELECT error_message,count(*)::int AS count FROM replay_requests
        WHERE workspace_id=$1 AND route_id=$2 AND backfill_job_id=$3 AND state='failed'
        GROUP BY error_message`,[workspaceId,routeId,job.id])).rows;
      const counts=new Map();
      for(const row of failures) {const code=safeRecoveryError(row.error_message);counts.set(code,(counts.get(code)??0)+row.count);}
      job.failure_codes=[...counts].map(([code,count])=>({code,count}));
    }
    return jobs;
  } finally { await client.query("ROLLBACK"); }
}

export async function startRecoveryBackfill(client, options) {
  const { workspaceId, routeId, expectedUpdatedAt, since, until, countEvents, runUrl, now = new Date() } = options;
  validateRouteScope(workspaceId, routeId);
  const start = Date.parse(since), end = Date.parse(until), current = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(Date.parse(expectedUpdatedAt))
      || start >= end || start < current - 7 * 86400_000 || end > current - 300_000
      || !/^https:\/\/github\.com\/rolln-ai\/axel\/actions\/runs\/\d+$/.test(runUrl)) fail();
  const id = `bfj_${createHash("sha256").update(JSON.stringify([workspaceId, routeId, new Date(start).toISOString(), new Date(end).toISOString()])).digest("hex").slice(0,24)}`;
  // Counting is read only; hold no control-plane locks during network IO.
  const route = (await client.query(`SELECT source_id FROM routes WHERE workspace_id=$1 AND id=$2`, [workspaceId,routeId])).rows[0];
  if (!route) fail();
  const total = await countEvents(route.source_id, new Date(start), new Date(end));
  if (!Number.isSafeInteger(total) || total < 1 || total > 2_000_000) fail();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const currentRoute = (await client.query(`SELECT source_id,updated_at::text AS updated_at
      FROM routes WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId,routeId])).rows[0];
    if (!currentRoute || route.source_id !== currentRoute.source_id || Date.parse(currentRoute.updated_at) !== Date.parse(expectedUpdatedAt)) fail();
    const existing = (await client.query("SELECT id,state FROM backfill_jobs WHERE id=$1 AND workspace_id=$2", [id,workspaceId])).rows[0];
    if (existing) { await client.query("COMMIT"); return { ...existing, already_exists: true }; }
    const destinations = (await client.query(`SELECT destination_id FROM route_destinations WHERE route_id=$1`, [routeId])).rows;
    if (destinations.length !== 1) fail();
    const scope = { workspace_id: workspaceId, route_id: routeId, source_id: route.source_id,
      recovery_destination_id: destinations[0].destination_id, recovery_route_updated_at: currentRoute.updated_at };
    if (!await recoveryRouteReady(client, scope, true)) fail();
    const blocked = await client.query(`SELECT 1 FROM dead_letters WHERE workspace_id=$1 AND route_id=$2 AND resolved_at IS NULL
      UNION ALL SELECT 1 FROM backfill_jobs WHERE workspace_id=$1 AND route_id=$2 AND since<$4::timestamptz AND until>$3::timestamptz LIMIT 1`,
    [workspaceId,routeId,new Date(start),new Date(end)]);
    if (blocked.rows.length) fail();
    await client.query(`INSERT INTO backfill_jobs(id,workspace_id,route_id,source_id,since,until,state,total_estimated,
      max_inflight_replays,recovery_destination_id,recovery_route_updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,500,$8,$9::timestamptz)`,
    [id,workspaceId,routeId,route.source_id,new Date(start),new Date(end),total,scope.recovery_destination_id,currentRoute.updated_at]);
    await writeAudit(client, { workspaceId, actorUserId:null, action:"route.recovery_backfill_started",targetType:"backfill_job",targetId:id,
      metadata:{ since:new Date(start).toISOString(),until:new Date(end).toISOString(),total_estimated:total,max_inflight_replays:500,run_url:runUrl } });
    await client.query("COMMIT");
    return { id,state:"pending",total_estimated:total,max_inflight_replays:500 };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
}

// Resume the exact failed job and replay identities after a reviewed transient
// failure. Never reset its cursor or create a second delivery identity.
export async function resumeRecoveryBackfill(client, options) {
  const {workspaceId,routeId,jobId,expectedUpdatedAt,runUrl}=options;
  validateRouteScope(workspaceId,routeId);
  if(!/^bfj_[a-f0-9]{24}$/.test(jobId??'') || !Number.isFinite(Date.parse(expectedUpdatedAt))
    || !/^https:\/\/github\.com\/rolln-ai\/axel\/actions\/runs\/\d+$/.test(runUrl)) fail();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const job=(await client.query(`SELECT *,recovery_route_updated_at::text AS recovery_route_updated_at FROM backfill_jobs
      WHERE id=$1 AND workspace_id=$2 AND route_id=$3 FOR UPDATE`,[jobId,workspaceId,routeId])).rows[0];
    if(!job || job.state!=='failed' || job.error_message!=='recovery_delivery_failed'
      || Date.parse(job.recovery_route_updated_at)!==Date.parse(expectedUpdatedAt) || !await recoveryRouteReady(client,job,true)) fail();
    if((await client.query(`SELECT 1 FROM dead_letters WHERE workspace_id=$1 AND route_id=$2 AND resolved_at IS NULL LIMIT 1`,[workspaceId,routeId])).rows.length) fail();
    const unfinished=(await client.query(`SELECT id,workspace_id,event_id,source_id,scope,route_id,destination_id,state,error_message,
      finished_at <= now()-interval '5 minutes' AS cooled
      FROM replay_requests WHERE backfill_job_id=$1 AND state<>'done' FOR UPDATE`,[jobId])).rows;
    if(!unfinished.length || unfinished.length>500 || unfinished.some(row=>row.state!=='failed' || !row.cooled
      || row.workspace_id!==workspaceId || row.source_id!==job.source_id || row.scope!=='route' || row.route_id!==routeId || row.destination_id!==null
      || !['rate_limited','operation_timeout','connection_failed','http_error_500','http_error_502','http_error_503','http_error_504'].includes(row.error_message))) fail();
    const delivery=await recoveryDeliveryState(client,job,unfinished.map(row=>row.event_id));
    if(delivery.busy || delivery.completed.size) fail();
    await client.query(`UPDATE replay_requests SET state='pending',started_at=NULL,finished_at=NULL,error_message=NULL
      WHERE backfill_job_id=$1 AND state='failed'`,[jobId]);
    await client.query(`UPDATE backfill_jobs SET state='running',finished_at=NULL,error_message=NULL WHERE id=$1`,[jobId]);
    await writeAudit(client,{workspaceId,actorUserId:null,action:'route.recovery_backfill_resumed',targetType:'backfill_job',targetId:jobId,
      metadata:{retried:unfinished.length,run_url:runUrl}});
    await client.query('COMMIT');
    return {id:jobId,state:'running',retried:unfinished.length};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
}

async function main() {
  const e=process.env;
  if (!e.DATABASE_URL || !["inspect","start","resume"].includes(e.RECOVERY_BACKFILL_ACTION)) fail();
  const client=new pg.Client({connectionString:e.DATABASE_URL,ssl:controlPlanePgSslOption(e.DATABASE_URL,e.DATABASE_TLS_VERIFY),connectionTimeoutMillis:10_000});
  try {
    await client.connect();
    if(e.RECOVERY_BACKFILL_ACTION==='inspect') {
      console.log(JSON.stringify(await inspectRecoveryBackfill(client,e.ROUTE_HEALTH_WORKSPACE_ID,e.ROUTE_HEALTH_ROUTE_ID)));
      return;
    }
    if(e.RECOVERY_BACKFILL_ACTION==='resume') {
      if(e.RECOVERY_BACKFILL_CONFIRM!=="resume-reviewed-backfill") fail();
      console.log(JSON.stringify(await resumeRecoveryBackfill(client,{workspaceId:e.ROUTE_HEALTH_WORKSPACE_ID,
        routeId:e.ROUTE_HEALTH_ROUTE_ID,jobId:e.RECOVERY_BACKFILL_JOB_ID,expectedUpdatedAt:e.RECOVERY_BACKFILL_EXPECTED_UPDATED_AT,
        runUrl:`https://github.com/rolln-ai/axel/actions/runs/${e.GITHUB_RUN_ID}`})));
      return;
    }
    if(e.RECOVERY_BACKFILL_CONFIRM!=="start-reviewed-backfill" || !e.CLICKHOUSE_URL) fail();
    console.log(JSON.stringify(await startRecoveryBackfill(client,{
      workspaceId:e.ROUTE_HEALTH_WORKSPACE_ID,routeId:e.ROUTE_HEALTH_ROUTE_ID,expectedUpdatedAt:e.RECOVERY_BACKFILL_EXPECTED_UPDATED_AT,
      since:e.RECOVERY_BACKFILL_SINCE,until:e.RECOVERY_BACKFILL_UNTIL,runUrl:`https://github.com/rolln-ai/axel/actions/runs/${e.GITHUB_RUN_ID}`,
      countEvents:async(sourceId,since,until)=>{
        const url=new URL(e.CLICKHOUSE_URL);
        for(const [key,value] of Object.entries({readonly:'1',default_format:'JSON',max_execution_time:'20',max_threads:'2',
          param_workspace:e.ROUTE_HEALTH_WORKSPACE_ID,param_source:sourceId,param_since:since.toISOString(),param_until:until.toISOString()})) url.searchParams.set(key,value);
        const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25_000),
          headers:{'X-ClickHouse-User':e.CLICKHOUSE_USER??'default','X-ClickHouse-Key':e.CLICKHOUSE_PASSWORD??''},
          body:`SELECT count() AS n FROM events WHERE workspace_id={workspace:String} AND source_id={source:String}
            AND received_at>=parseDateTime64BestEffort({since:String},3) AND received_at<parseDateTime64BestEffort({until:String},3) AND is_test=0`});
        if(!response.ok) fail();
        return Number((await response.json()).data?.[0]?.n);
      },
    })));
  } finally { await client.end(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error("recovery_backfill_failed_inspect_before_retry");process.exitCode=1;});
}
