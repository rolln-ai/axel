#!/usr/bin/env node
// Protected operator repair. Customer payloads and credential material stay in
// memory; public output contains counts, types and a review hash only.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { cloudflareR2ObjectUrl, compareBigQuerySchemas, executeGraph, expectedBigQuerySchema,
  isCanonicalRawPayloadKey, parseCanonicalRawPayloadKey, parsePipelineGraph } from "../packages/shared/dist/index.js";
import { addRepairToPipeline, repairProposalFromIssue, synthesizeLegacyPipeline } from "../apps/dashboard/lib/inbox-repair.ts";
import { bigQueryModeForBinding } from "../apps/dashboard/lib/pipeline-binding.ts";
import { introspectBigQueryDestination } from "../apps/dashboard/lib/destination-inspect.ts";
import { db } from "../apps/dashboard/lib/db.ts";
import { enqueueReplays } from "../apps/dashboard/lib/replay-enqueue.ts";
import { writeAudit } from "../apps/dashboard/lib/audit.ts";
import { readResponseBytesLimited } from "../apps/delivery-service/src/cli-bounded-io.ts";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";
import { validateRouteScope } from "./inspect-route-health.mjs";

const fail = () => { throw new Error("bigquery_route_repair_precondition_failed"); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};

export function retainedBaseEvent(row, workspaceId) {
  const parsed=parseCanonicalRawPayloadKey(row.r2_key);
  if(!parsed || parsed.eventId.includes('#') || !isCanonicalRawPayloadKey(row.r2_key,{workspaceId,sourceId:row.source_id,eventId:parsed.eventId})) fail();
  const suffix=row.event_id.slice(parsed.eventId.length);
  if(!row.event_id.startsWith(parsed.eventId) || (suffix!==''&&!/^(?:#rp[yl]_[A-Za-z0-9_-]+)+$/.test(suffix))) fail();
  return parsed.eventId;
}

async function loadState(client, workspaceId, routeId, lock = false) {
  const route=(await client.query(`SELECT r.source_id,r.pipeline_graph::text AS graph,r.filter_expression,r.transform_script,r.updated_at::text AS updated_at
    FROM routes r JOIN sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
    JOIN workspaces w ON w.id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.status='active' AND s.status='active' AND w.status='active'
    ${lock?"FOR UPDATE OF r FOR SHARE OF s,w":""}`,[workspaceId,routeId])).rows[0];
  if(!route) fail();
  const destinations=(await client.query(`SELECT d.id,d.config,rd.binding
    FROM route_destinations rd JOIN destinations d ON d.id=rd.destination_id AND d.workspace_id=$2
    WHERE rd.route_id=$1 AND d.type='bigquery' AND d.status='active' AND NOT d.delivery_paused AND d.circuit_state='closed'
      AND (SELECT count(*) FROM route_destinations WHERE route_id=$1)=1
    ${lock?"FOR SHARE OF d":""}`,[routeId,workspaceId])).rows;
  if(destinations.length!==1) fail();
  const destination=destinations[0];
  return {route,destination};
}

function outgoing(payload, graph, destinationId) {
  const result=executeGraph(payload,graph).deliveries;
  if(result.length!==1 || result[0].destination_id!==destinationId) fail();
  return result[0].payload;
}

export async function prepareBigQueryRouteRepair(client, options) {
  const {workspaceId,routeId,expectedUpdatedAt,readPayload,readSchema,onStage=()=>{}}=options;
  validateRouteScope(workspaceId,routeId);
  onStage('read_route');
  const state=await loadState(client,workspaceId,routeId);
  if(Date.parse(state.route.updated_at)!==Date.parse(expectedUpdatedAt)) fail();
  const attached=new Set([state.destination.id]);
  const graph=state.route.graph ? parsePipelineGraph(state.route.graph,{attached_destination_ids:attached})
    : synthesizeLegacyPipeline({filterExpression:state.route.filter_expression,transformScript:state.route.transform_script,destinationIds:[state.destination.id]});
  const target={...object(state.destination.config),...object(state.destination.binding)};
  if(typeof target.dataset!=='string'||typeof target.table!=='string') fail();
  const mode=bigQueryModeForBinding(state.destination.binding===null?null:target);
  const payloadColumn=typeof target.payload_column==='string'?target.payload_column:'payload';
  const failures=(await client.query(`SELECT DISTINCT ON(event_id) id::text,event_id,source_id,r2_key
    FROM dead_letters WHERE workspace_id=$1 AND route_id=$2 AND source_id=$3 AND destination_id=$4
      AND resolved_at IS NULL ORDER BY event_id,id LIMIT 100`,[workspaceId,routeId,state.route.source_id,state.destination.id])).rows;
  if(!failures.length) fail();
  onStage('read_live_schema');
  const schema=await readSchema(state.destination.id,{dataset:target.dataset,table:target.table});
  if(schema.kind!=='schema') fail();
  const payloads=[];
  const issues=new Map();
  const additions=new Set();
  onStage('validate_retained_payloads');
  for(const row of failures) {
    row.base_event_id=retainedBaseEvent(row,workspaceId);
    const payload=await readPayload(row.r2_key);
    payloads.push(payload);
    const compatibility=compareBigQuerySchemas(expectedBigQuerySchema([outgoing(payload,graph,state.destination.id)],mode,payloadColumn),schema.fields);
    for(const path of compatibility.additions) additions.add(path);
    for(const issue of compatibility.conflicts)
      issues.set(JSON.stringify([issue.path,issue.kind,issue.expected,issue.existing]),issue);
  }
  const ordered=[...issues.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  let candidate=graph;
  let supported=true;
  const repairs=[];
  for(const issue of ordered) {
    const proposal=repairProposalFromIssue(issue);
    // Only lossless serialization into an existing scalar STRING column.
    // Numeric rounding and record/scalar rewrites are excluded. Missing
    // columns require an explicit opt-in to the existing route policy.
    const repair=proposal?.repair;
    const scalarString=issue.kind==='type_conflict' && issue.existing==='STRING'
      && ['BOOL','INT64','FLOAT64'].includes(issue.expected) && repair?.kind==='coerce' && repair.to==='string';
    const arrayString=issue.kind==='mode_conflict' && ['NULLABLE STRING','REQUIRED STRING'].includes(issue.existing)
      && issue.expected.startsWith('REPEATED ') && repair?.kind==='collapse_array';
    if(!scalarString&&!arrayString) {supported=false;continue;}
    repairs.push(repair);
    candidate=addRepairToPipeline({graph:candidate,destinationId:state.destination.id,repair,
      nodeIdSeed:`fix_${hash(repair).slice(0,20)}`,attachedDestinationIds:attached}).graph;
  }
  if(supported) for(const payload of payloads) {
    if(compareBigQuerySchemas(expectedBigQuerySchema([outgoing(payload,candidate,state.destination.id)],mode,payloadColumn),schema.fields).conflicts.length) supported=false;
  }
  const requiresNewFields=additions.size>0 && target.schema_evolution!=='add_columns';
  if(requiresNewFields && (!state.destination.binding || additions.size>200)) supported=false;
  const planHash=hash({state,additions:[...additions].sort(),requiresNewFields,schema:schema.fields,issues:ordered.map(({path,kind,expected,existing})=>({path,kind,expected,existing})),candidate});
  return {state,schema,candidate,failures,repairs,supported,planHash,target,requiresNewFields,
    summary:{plan_hash:planHash,supported,validated_failures:failures.length,
      schema_policy:target.schema_evolution==='add_columns'?'add_columns':'manual',additional_fields:additions.size,requires_new_fields:requiresNewFields,
      conflicts:ordered.map(issue=>({field_hash:hash(issue.path).slice(0,12),kind:issue.kind,
        expected:/^(REPEATED )?[A-Z0-9_]+$/.test(issue.expected)?issue.expected:'unknown',
        existing:/^(REPEATED )?[A-Z0-9_]+$/.test(issue.existing)?issue.existing:'unknown'}))}};
}

export async function applyBigQueryRouteRepair(client, options, plan) {
  const {workspaceId,routeId,expectedPlanHash,readSchema,runUrl,onStage=()=>{}}=options;
  if(!plan.supported || (plan.requiresNewFields && options.allowNewFields!==true) || expectedPlanHash!==plan.planHash || !/^https:\/\/github\.com\/rolln-ai\/axel\/actions\/runs\/\d+$/.test(runUrl)) fail();
  onStage('recheck_schema');
  const schema=await readSchema(plan.state.destination.id,{dataset:plan.target.dataset,table:plan.target.table});
  if(schema.kind!=='schema'||hash(schema.fields)!==hash(plan.schema.fields)) fail();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    onStage('lock_route');
    const state=await loadState(client,workspaceId,routeId,true);
    if(JSON.stringify(state)!==JSON.stringify(plan.state)) fail();
    if(plan.requiresNewFields) {
      // Same delete/insert pattern as the dashboard; its role intentionally
      // cannot UPDATE binding rows. The route lock fences binding edits.
      await client.query('DELETE FROM route_destinations WHERE route_id=$1 AND destination_id=$2',[routeId,state.destination.id]);
      await client.query('INSERT INTO route_destinations(route_id,destination_id,binding) VALUES($1,$2,$3::jsonb)',
        [routeId,state.destination.id,JSON.stringify({...state.destination.binding,schema_evolution:'add_columns'})]);
    }
    if(plan.repairs.length>0 || plan.requiresNewFields) await client.query(`UPDATE routes SET pipeline_graph=$1::jsonb,filter_expression=NULL,transform_script=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3`,[JSON.stringify(plan.candidate),workspaceId,routeId]);
    onStage('queue_replays');
    const replay=await enqueueReplays(client,{workspaceId,actorUserId:null,reason:'reviewed_lossless_bigquery_repair',
      candidates:{sql:`SELECT DISTINCT ON(split_part(event_id,'#',1)) split_part(event_id,'#',1) AS event_id,source_id,r2_key,'route'::text AS scope,route_id,
        NULL::text AS destination_id,reason AS failure_reason,fingerprint FROM dead_letters
        WHERE workspace_id=$1 AND route_id=$2 AND source_id=$3 AND destination_id=$4 AND resolved_at IS NULL AND id=ANY($5::bigint[])
        ORDER BY split_part(event_id,'#',1),id`,params:[workspaceId,routeId,state.route.source_id,state.destination.id,plan.failures.map(row=>row.id)]}});
    if(replay.mutedSkipped>0) fail();
    await writeAudit(client,{workspaceId,actorUserId:null,action:'route.lossless_bigquery_repair',targetType:'route',targetId:routeId,
      metadata:{plan_hash:plan.planHash,repairs:plan.repairs,enabled_new_fields:plan.requiresNewFields,queued:replay.queued,run_url:runUrl}});
    await client.query('COMMIT');
    return {status:'repaired',replays_queued:replay.queued,already_in_flight:replay.inFlightSkipped,fields_repaired:plan.repairs.length,enabled_new_fields:plan.requiresNewFields};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
}

export async function reconcileBigQueryReplays(client,options) {
  const {workspaceId,routeId,runUrl}=options;
  validateRouteScope(workspaceId,routeId);
  if(!/^https:\/\/github\.com\/rolln-ai\/axel\/actions\/runs\/\d+$/.test(runUrl)) fail();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    const state=await loadState(client,workspaceId,routeId,true);
    const failures=(await client.query(`SELECT id::text,event_id,source_id,r2_key FROM dead_letters
      WHERE workspace_id=$1 AND route_id=$2 AND source_id=$3 AND destination_id=$4 AND resolved_at IS NULL LIMIT 1000 FOR UPDATE`,
      [workspaceId,routeId,state.route.source_id,state.destination.id])).rows;
    const candidates=failures.map(row=>({id:row.id,base_event_id:retainedBaseEvent(row,workspaceId)}));
    const resolved=await client.query(`WITH candidates AS (
      SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(id bigint,base_event_id text)
    ), confirmed AS (
      SELECT DISTINCT ON(c.id) c.id,rr.id AS replay_id FROM candidates c
      JOIN dead_letters failure ON failure.id=c.id
      JOIN delivery_idempotency di ON di.workspace_id=$1 AND di.route_id=$2 AND di.destination_id=$3
        AND split_part(di.event_id,'#',1)=c.base_event_id AND di.state='completed' AND di.updated_at>=failure.errored_at
      JOIN replay_requests rr ON rr.id=split_part(di.event_id,'#',2) AND rr.workspace_id=$1
        AND rr.source_id=$4 AND rr.route_id=$2 AND rr.event_id=c.base_event_id AND rr.state='done' AND rr.finished_at>=failure.errored_at
        AND di.event_id=rr.event_id||'#'||rr.id
      ORDER BY c.id,rr.finished_at DESC
    ) UPDATE dead_letters dl SET resolved_at=now(),resolved_by_replay_id=c.replay_id FROM confirmed c
      WHERE dl.id=c.id AND dl.workspace_id=$1 AND dl.route_id=$2 AND dl.destination_id=$3 AND dl.source_id=$4 AND dl.resolved_at IS NULL`,
      [workspaceId,routeId,state.destination.id,state.route.source_id,JSON.stringify(candidates)]);
    await writeAudit(client,{workspaceId,actorUserId:null,action:'route.confirmed_replays_reconciled',targetType:'route',targetId:routeId,
      metadata:{resolved:resolved.rowCount,run_url:runUrl}});
    await client.query('COMMIT');return {confirmed_failures_resolved:resolved.rowCount};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}

let stage='configuration';
async function main() {
  const e=process.env;
  if(!e.DATABASE_URL||!e.CREDENTIALS_MASTER_KEY||!e.CLOUDFLARE_API_TOKEN||!e.CLOUDFLARE_ACCOUNT_ID||!['inspect','apply','reconcile'].includes(e.BQ_REPAIR_ACTION)) fail();
  const client=new pg.Client({connectionString:e.DATABASE_URL,ssl:controlPlanePgSslOption(e.DATABASE_URL,e.DATABASE_TLS_VERIFY),connectionTimeoutMillis:10_000});
  try {
    stage='connect_database';await client.connect();
    const options={workspaceId:e.ROUTE_HEALTH_WORKSPACE_ID,routeId:e.ROUTE_HEALTH_ROUTE_ID,expectedUpdatedAt:e.BQ_REPAIR_EXPECTED_UPDATED_AT,
      allowNewFields:e.BQ_REPAIR_ALLOW_NEW_FIELDS==='true',expectedPlanHash:e.BQ_REPAIR_PLAN_HASH,runUrl:`https://github.com/rolln-ai/axel/actions/runs/${e.GITHUB_RUN_ID}`,
      onStage:value=>{stage=value;},
      readSchema:(destinationId,target)=>introspectBigQueryDestination(destinationId,e.ROUTE_HEALTH_WORKSPACE_ID,target),
      readPayload:async key=>{
        const response=await fetch(cloudflareR2ObjectUrl(e.CLOUDFLARE_ACCOUNT_ID,'axel-events-raw',key),{
          headers:{authorization:`Bearer ${e.CLOUDFLARE_API_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(15_000)});
        if(!response.ok) fail();
        return JSON.parse(new TextDecoder().decode(await readResponseBytesLimited(response,6*1024*1024)));
      }};
    if(e.BQ_REPAIR_ACTION==='reconcile') {
      if(e.BQ_REPAIR_CONFIRM!=='reconcile-confirmed-deliveries') fail();
      console.log(JSON.stringify(await reconcileBigQueryReplays(client,options)));return;
    }
    const plan=await prepareBigQueryRouteRepair(client,options);
    console.log(JSON.stringify(plan.summary));
    if(e.BQ_REPAIR_ACTION==='apply') {
      if(e.BQ_REPAIR_CONFIRM!=='apply-reviewed-lossless-repair') fail();
      console.log(JSON.stringify(await applyBigQueryRouteRepair(client,options,plan)));
    }
  } finally {await client.end();if(globalThis.__axelDashboardPoolV2) await db().end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(JSON.stringify({status:'bigquery_route_repair_failed_inspect_before_retry',stage,
    code:/^[0-9A-Z]{5}$/.test(error?.code??'')?`postgres_${error.code}`:'operation_failed'}));process.exitCode=1;});
}
