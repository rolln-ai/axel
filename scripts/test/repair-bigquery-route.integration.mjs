import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeGraph, parsePipelineGraph } from "../../packages/shared/dist/index.js";
import { prepareBigQueryRouteRepair, applyBigQueryRouteRepair } from "../repair-bigquery-route.mjs";
import { databaseServiceAccessProfile } from "../database-service-access-profiles.mjs";
import { connectDisposablePostgres } from "./postgres-integration-test-helpers.mjs";

test("reviewed BigQuery serialization is scoped, lossless, atomic and compatible with runtime grants",{timeout:120_000},async t=>{
  const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const password=randomBytes(24).toString('hex');
  const container=docker('run','--rm','--detach','--publish','127.0.0.1::5432','--env',`POSTGRES_PASSWORD=${password}`,
    'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73');
  let client;t.after(async()=>{await client?.end();docker('rm','--force',container);});
  const port=docker('port',container,'5432/tcp').split(':').at(-1);
  client=await connectDisposablePostgres(`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`);
  await client.query(readFileSync(new URL('../../infra/postgres/schema.sql',import.meta.url),'utf8'));
  await client.query("INSERT INTO workspaces(id,name) VALUES('ws_a','Synthetic A'),('ws_b','Synthetic B')");
  await client.query("INSERT INTO sources(id,workspace_id,name,secret_token_hash,status) VALUES('src_a','ws_a','Synthetic','synthetic','active')");
  const graph={version:1,nodes:[{id:'src',kind:'source'},{id:'dst',kind:'destination',destination_id:'dst_a'}],edges:[{from:'src',to:'dst'}]};
  await client.query(`INSERT INTO routes(id,workspace_id,source_id,status,pipeline_graph,updated_at)
    VALUES('rt_a','ws_a','src_a','active',$1::jsonb,'2026-09-22T15:42:31.031Z')`,[JSON.stringify(graph)]);
  await client.query("INSERT INTO destinations(id,workspace_id,name,type,config) VALUES('dst_a','ws_a','Synthetic','bigquery','{}')");
  await client.query(`INSERT INTO route_destinations(route_id,destination_id,binding) VALUES('rt_a','dst_a',$1::jsonb)`,
    [JSON.stringify({dataset:'synthetic',table:'events',mode:'typed_records'})]);
  await client.query(`INSERT INTO dead_letters(workspace_id,event_id,source_id,route_id,destination_id,r2_key,reason,message,errored_at,fingerprint)
    VALUES('ws_a','evt_a','src_a','rt_a','dst_a','events/ws_a/2026-09-22/evt_a','delivery_dead','private provider details',now(),'synthetic-fp')`);
  await client.query('CREATE ROLE synthetic_dashboard NOLOGIN');
  const profile=databaseServiceAccessProfile('dashboard');
  for(const [table,privileges]of Object.entries(profile.tables)) await client.query(`GRANT ${privileges.join(',')} ON TABLE ${table} TO synthetic_dashboard`);
  for(const [sequence,privileges]of Object.entries(profile.sequences)) await client.query(`GRANT ${privileges.join(',')} ON SEQUENCE ${sequence} TO synthetic_dashboard`);
  await client.query('SET ROLE synthetic_dashboard');
  const payload={total:12.5,tags:['private sample','retained exactly']};
  const fields=[{name:'total',type:'STRING',mode:'NULLABLE'},{name:'tags',type:'STRING',mode:'NULLABLE'}];
  const options={workspaceId:'ws_a',routeId:'rt_a',expectedUpdatedAt:'2026-09-22T15:42:31.031Z',
    readPayload:async()=>structuredClone(payload),readSchema:async()=>({kind:'schema',fields}),runUrl:'https://github.com/rolln-ai/axel/actions/runs/123'};
  await assert.rejects(prepareBigQueryRouteRepair(client,{...options,workspaceId:'ws_b'}));
  await assert.rejects(prepareBigQueryRouteRepair(client,{...options,expectedUpdatedAt:'2026-09-22T15:41:00Z'}));
  const plan=await prepareBigQueryRouteRepair(client,options);
  assert.equal(plan.supported,true);assert.equal(plan.repairs.length,2);
  assert.doesNotMatch(JSON.stringify(plan.summary),/private|retained exactly|total|tags|evt_a|src_a|dst_a/);
  await assert.rejects(applyBigQueryRouteRepair(client,{...options,expectedPlanHash:'wrong'},plan));
  await assert.rejects(applyBigQueryRouteRepair(client,{...options,expectedPlanHash:plan.planHash,readSchema:async()=>({kind:'schema',fields:[]})},plan));
  await client.query("UPDATE routes SET updated_at=now() WHERE id='rt_a'");
  await assert.rejects(applyBigQueryRouteRepair(client,{...options,expectedPlanHash:plan.planHash},plan));
  await client.query("UPDATE routes SET updated_at='2026-09-22T15:42:31.031Z' WHERE id='rt_a'");
  const numeric=await prepareBigQueryRouteRepair(client,{...options,readSchema:async()=>({kind:'schema',fields:[{name:'total',type:'INT64'},fields[1]]})});
  assert.equal(numeric.supported,false);
  await assert.rejects(applyBigQueryRouteRepair(client,{...options,expectedPlanHash:numeric.planHash},numeric));
  await client.query("INSERT INTO dead_letter_mutes(id,workspace_id,fingerprint) VALUES('mute_a','ws_a','synthetic-fp')");
  await assert.rejects(applyBigQueryRouteRepair(client,{...options,expectedPlanHash:plan.planHash},plan));
  assert.equal((await client.query('SELECT count(*)::int n FROM replay_requests')).rows[0].n,0);
  assert.equal((await client.query('SELECT count(*)::int n FROM audit_log')).rows[0].n,0);
  await client.query("UPDATE dead_letter_mutes SET until=now()-interval '1 second'");
  assert.deepEqual(await applyBigQueryRouteRepair(client,{...options,expectedPlanHash:plan.planHash},plan),
    {status:'repaired',replays_queued:1,already_in_flight:0,fields_repaired:2});
  const updated=(await client.query("SELECT pipeline_graph,updated_at::text FROM routes WHERE id='rt_a'")).rows[0];
  const repaired=parsePipelineGraph(JSON.stringify(updated.pipeline_graph),{attached_destination_ids:new Set(['dst_a'])});
  assert.deepEqual(JSON.parse(JSON.stringify(executeGraph(payload,repaired).deliveries[0].payload)),{total:'12.5',tags:JSON.stringify(payload.tags)});
  assert.equal((await client.query('SELECT resolved_at FROM dead_letters')).rows[0].resolved_at,null);
  // Already-compatible cache-period failures can retry without another edit.
  const retryOptions={...options,expectedUpdatedAt:updated.updated_at};
  const retryPlan=await prepareBigQueryRouteRepair(client,retryOptions);
  assert.equal(retryPlan.supported,true);assert.equal(retryPlan.repairs.length,0);
  const retried=await applyBigQueryRouteRepair(client,{...retryOptions,expectedPlanHash:retryPlan.planHash},retryPlan);
  assert.equal(retried.replays_queued,0);assert.equal(retried.already_in_flight,1);
  assert.equal((await client.query("SELECT updated_at::text FROM routes WHERE id='rt_a'")).rows[0].updated_at,updated.updated_at);
});
