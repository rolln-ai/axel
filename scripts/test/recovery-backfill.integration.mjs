import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { startRecoveryBackfill, inspectRecoveryBackfill, safeRecoveryError, resumeRecoveryBackfill, reconcileRecoveryBackfill } from "../recovery-backfill.mjs";
import { advanceJob } from "../../apps/delivery-service/src/backfill-job-worker.ts";
import { databaseServiceAccessProfile } from "../database-service-access-profiles.mjs";
import { connectDisposablePostgres } from "./postgres-integration-test-helpers.mjs";

test("recovery backfill skips confirmed deliveries, waits for ambiguous work and stops on new failures", {timeout:120_000}, async t=>{
  const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const password=randomBytes(24).toString("hex");
  const container=docker("run","--rm","--detach","--publish","127.0.0.1::5432","--env",`POSTGRES_PASSWORD=${password}`,
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73");
  let client,pool;
  t.after(async()=>{await pool?.end();await client?.end();docker("rm","--force",container);});
  const port=docker("port",container,"5432/tcp").split(":").at(-1);
  const connectionString=`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
  client=await connectDisposablePostgres(connectionString);
  await client.query(readFileSync(new URL("../../infra/postgres/schema.sql",import.meta.url),"utf8"));
  // Exercise append-only migrations on an existing schema as well.
  for(const name of ["0081_recovery_backfill.sql","0082_recovery_delivery_lookup.sql","0083_recovery_replay_lookup.sql","0084_backfill_outcome_lookup.sql"])
  {
    const sql=readFileSync(new URL(`../../infra/postgres/migrations/${name}`,import.meta.url),"utf8");
    const split=sql.indexOf("DO $$");
    if(split<0) await client.query(sql);
    else { await client.query(sql.slice(0,split)); await client.query(sql.slice(split)); }
  }
  for(const [role,profileName] of [["synthetic_dashboard","dashboard"],["synthetic_workers","delivery-workers"]]) {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    const profile=databaseServiceAccessProfile(profileName);
    for(const [table,privileges] of Object.entries(profile.tables))
      await client.query(`GRANT ${privileges.join(",")} ON TABLE ${table} TO ${role}`);
    for(const [sequence,privileges] of Object.entries(profile.sequences))
      await client.query(`GRANT ${privileges.join(",")} ON SEQUENCE ${sequence} TO ${role}`);
  }
  pool=new pg.Pool({connectionString,options:"-c role=synthetic_workers"});
  const startAsDashboard=async options=>{
    await client.query("SET ROLE synthetic_dashboard");
    try { return await startRecoveryBackfill(client,options); }
    finally { await client.query("RESET ROLE"); }
  };
  await client.query("INSERT INTO workspaces(id,name) VALUES ('ws_a','Synthetic A'),('ws_b','Synthetic B')");
  await client.query("INSERT INTO sources(id,workspace_id,name,secret_token_hash,status) VALUES('src_a','ws_a','Synthetic','synthetic','active')");
  await client.query("INSERT INTO routes(id,workspace_id,source_id,status,updated_at) VALUES('rt_a','ws_a','src_a','active','2026-09-22T10:00:00Z')");
  await client.query("INSERT INTO destinations(id,workspace_id,name,type,config) VALUES('dst_a','ws_a','Synthetic','bigquery','{}')");
  await client.query("INSERT INTO route_destinations(route_id,destination_id) VALUES('rt_a','dst_a')");
  const options={workspaceId:'ws_a',routeId:'rt_a',expectedUpdatedAt:'2026-09-22T10:00:00Z',since:'2026-09-17T01:33:00Z',until:'2026-09-22T10:10:00Z',
    now:new Date('2026-09-22T11:00:00Z'),countEvents:async()=>7,runUrl:'https://github.com/rolln-ai/axel/actions/runs/123'};
  await assert.rejects(startAsDashboard({...options,workspaceId:'ws_b'}));
  await assert.rejects(startAsDashboard({...options,expectedUpdatedAt:'2026-09-22T09:00:00Z'}));
  await assert.rejects(startAsDashboard({...options,since:'2026-09-01T00:00:00Z'}));
  await assert.rejects(startAsDashboard({...options,until:'2026-09-22T11:00:00Z'}));
  await client.query("UPDATE destinations SET delivery_paused=true");
  await assert.rejects(startAsDashboard(options));
  await client.query("UPDATE destinations SET delivery_paused=false");
  assert.equal((await client.query('SELECT count(*)::int n FROM backfill_jobs')).rows[0].n,0);
  const created=await startAsDashboard(options);
  assert.equal(created.total_estimated,7);
  assert.equal((await startAsDashboard(options)).already_exists,true);
  await assert.rejects(startAsDashboard({...options,since:'2026-09-17T01:32:00Z'}));
  assert.equal((await client.query('SELECT count(*)::int n FROM audit_log')).rows[0].n,1);
  for(const [event,state,ws]of [['evt_delivered#rpy_old','completed','ws_a'],['evt_replayed#rpl_old','completed','ws_a'],['evt_failed','failed','ws_a'],['evt_busy','in_flight','ws_a'],['evt_foreign','completed','ws_b']]) {
    await client.query(`INSERT INTO delivery_idempotency(idempotency_key,workspace_id,event_id,route_id,destination_id,state,expires_at)
      VALUES($1,$2,$1,'rt_a','dst_a',$3,now()+interval '1 day')`,[event,ws,state]);
  }
  await client.query(`INSERT INTO replay_requests(id,workspace_id,event_id,source_id,r2_key,scope,route_id,state)
    VALUES('rpy_old','ws_a','evt_unconfirmed','src_a','events/ws_a/2026-09-17/evt_unconfirmed','all',NULL,'done')`);
  const events=['evt_delivered','evt_replayed','evt_missing','evt_failed','evt_foreign','evt_busy','evt_unconfirmed'].map((event_id,i)=>({event_id,
    r2_key:`events/ws_a/2026-09-17/${event_id}`,received_at_text:`2026-09-17 01:33:0${i}.000`}));
  const loadJob=async()=>(await client.query(`SELECT *,since::text,until::text,cursor_received_at::text,recovery_route_updated_at::text FROM backfill_jobs WHERE id=$1`,[created.id])).rows[0];
  const deps={pool,clickhouse:{url:'https://synthetic.example'},fetchImpl:async()=>new Response(JSON.stringify({data:events}))};
  assert.equal(await advanceJob(deps,await loadJob()),'throttled');
  assert.equal((await loadJob()).cursor_event_id,null);
  await client.query("UPDATE delivery_idempotency SET state='failed' WHERE event_id='evt_busy'");
  // A concurrent route edit during ClickHouse IO must prevent any enqueue.
  assert.equal(await advanceJob({...deps,fetchImpl:async()=>{
    await client.query("UPDATE routes SET updated_at='2026-09-22T10:01:00Z'");return deps.fetchImpl();
  }},await loadJob()),'failed');
  assert.equal((await loadJob()).enqueued,'0');
  await client.query("UPDATE routes SET updated_at='2026-09-22T10:00:00Z'");
  await client.query("UPDATE backfill_jobs SET state='pending',error_message=NULL,finished_at=NULL");
  assert.equal(await advanceJob(deps,await loadJob()),'advanced');
  const job=await loadJob();
  assert.equal(job.skipped,'2');assert.equal(job.enqueued,'5');assert.equal(job.cursor_event_id,'evt_unconfirmed');
  const replayRows=(await client.query('SELECT id,event_id,state FROM replay_requests WHERE backfill_job_id=$1 ORDER BY event_id',[created.id])).rows;
  assert.deepEqual(replayRows.map(r=>r.event_id),['evt_busy','evt_failed','evt_foreign','evt_missing','evt_unconfirmed']);
  assert.ok(replayRows.every(r=>r.id.startsWith('rpy_')));
  // An exhausted source is not done while destination delivery is outstanding.
  await client.query("UPDATE replay_requests SET state='in_progress' WHERE backfill_job_id=$1",[created.id]);
  const empty={...deps,fetchImpl:async()=>new Response(JSON.stringify({data:[]}))};
  assert.equal(await advanceJob(empty,await loadJob()),'throttled');
  await client.query("UPDATE replay_requests SET state='failed' WHERE id=$1",[replayRows[0].id]);
  assert.equal(await advanceJob(empty,await loadJob()),'failed');
  assert.equal((await loadJob()).error_message,'recovery_delivery_failed');
  await client.query("UPDATE replay_requests SET error_message='r2_get_429' WHERE id=$1",[replayRows[0].id]);
  const failedSummary=(await inspectRecoveryBackfill(client,'ws_a','rt_a'))[0];
  assert.equal(failedSummary.error_message,'recovery_delivery_failed');
  assert.deepEqual(failedSummary.failure_codes,[{code:'r2_get_429',count:1}]);
  const resumeOptions={workspaceId:'ws_a',routeId:'rt_a',jobId:created.id,expectedUpdatedAt:options.expectedUpdatedAt,runUrl:options.runUrl};
  const resumeAsDashboard=async input=>{
    await client.query('SET ROLE synthetic_dashboard');
    try{return await resumeRecoveryBackfill(client,input);}finally{await client.query('RESET ROLE');}
  };
  await assert.rejects(resumeAsDashboard(resumeOptions)); // other requests still in progress
  await client.query("UPDATE replay_requests SET state='done' WHERE backfill_job_id=$1 AND state='in_progress'",[created.id]);
  await client.query("UPDATE replay_requests SET error_message='rate_limited',finished_at=now()-interval '10 minutes' WHERE state='failed'");
  await assert.rejects(resumeAsDashboard({...resumeOptions,workspaceId:'ws_b'}));
  await assert.rejects(resumeAsDashboard({...resumeOptions,expectedUpdatedAt:'2026-09-22T11:00:00Z'}));
  await client.query("UPDATE routes SET updated_at='2026-09-22T10:01:00Z'");
  await assert.rejects(resumeAsDashboard(resumeOptions));
  await client.query("UPDATE routes SET updated_at='2026-09-22T10:00:00Z'");
  await client.query("UPDATE delivery_idempotency SET state='in_flight' WHERE event_id='evt_busy'");
  await assert.rejects(resumeAsDashboard(resumeOptions));
  await client.query("UPDATE delivery_idempotency SET state='completed' WHERE event_id='evt_busy'");
  await assert.rejects(resumeAsDashboard(resumeOptions));
  await client.query("UPDATE delivery_idempotency SET state='failed' WHERE event_id='evt_busy'");
  // Keep Postgres microseconds across the readiness fence; JavaScript Date
  // would truncate them and incorrectly reject the unchanged route.
  await client.query("UPDATE routes SET updated_at='2026-09-22T10:00:00.123456Z'");
  await client.query("UPDATE backfill_jobs SET recovery_route_updated_at='2026-09-22T10:00:00.123456Z'");
  resumeOptions.expectedUpdatedAt='2026-09-22T10:00:00.123Z';
  const beforeResume=await loadJob();
  assert.equal((await resumeAsDashboard(resumeOptions)).retried,1);
  const afterResume=await loadJob();
  assert.equal(afterResume.state,'running');assert.equal(afterResume.cursor_event_id,beforeResume.cursor_event_id);
  assert.equal(afterResume.enqueued,beforeResume.enqueued);assert.equal(afterResume.finished_at,null);
  assert.equal((await client.query('SELECT state FROM replay_requests WHERE id=$1',[replayRows[0].id])).rows[0].state,'pending');
  assert.equal((await client.query('SELECT count(*)::int n FROM replay_requests WHERE backfill_job_id=$1',[created.id])).rows[0].n,5);
  await assert.rejects(resumeAsDashboard(resumeOptions)); // cannot resume a running job twice
  await client.query("UPDATE replay_requests SET state='done' WHERE backfill_job_id=$1",[created.id]);
  await client.query("UPDATE backfill_jobs SET state='running',error_message=NULL,finished_at=NULL");
  await client.query("UPDATE destinations SET delivery_paused=true");
  assert.equal(await advanceJob(empty,await loadJob()),'failed');
  await client.query("UPDATE destinations SET delivery_paused=false");
  await client.query("UPDATE backfill_jobs SET state='running',error_message=NULL,finished_at=NULL");
  assert.equal(await advanceJob(empty,await loadJob()),'done');
  const summary=(await inspectRecoveryBackfill(client,'ws_a','rt_a'))[0];
  assert.equal(summary.delivered,5);assert.equal(summary.skipped,'2');assert.equal(summary.state,'done');
  assert.deepEqual(await inspectRecoveryBackfill(client,'ws_b','rt_a'),[]);

  const reconcileAsDashboard=async input=>{
    await client.query('SET ROLE synthetic_dashboard');
    try{return await reconcileRecoveryBackfill(client,input);}finally{await client.query('RESET ROLE');}
  };
  await assert.rejects(reconcileAsDashboard({...resumeOptions,workspaceId:'ws_b'}));
  await assert.rejects(reconcileAsDashboard({...resumeOptions,expectedUpdatedAt:'2026-09-22T11:00:00Z'}));
  await client.query("UPDATE backfill_jobs SET state='running' WHERE id=$1",[created.id]);
  await assert.rejects(reconcileAsDashboard(resumeOptions));
  await client.query("UPDATE backfill_jobs SET state='done' WHERE id=$1",[created.id]);
  await client.query("INSERT INTO routes(id,workspace_id,source_id,status) VALUES('rt_extra','ws_a','src_a','disabled')");
  await assert.rejects(reconcileAsDashboard(resumeOptions));
  await client.query("DELETE FROM routes WHERE id='rt_extra'");
  const replay=replayRows.find(row=>row.event_id==='evt_missing');
  const payload='events/ws_a/2026-09-17/evt_missing';
  const insertFailure=async (ws,source,route,key,reason='max_retries_exceeded',destination=null,when="now()-interval '2 minutes'",isTest=false)=>
    (await client.query(`INSERT INTO dead_letters(workspace_id,event_id,source_id,route_id,r2_key,reason,message,errored_at,destination_id,is_test)
      VALUES($1,'evt_missing',$2,$3,$4,$5,'PRIVATE',${when},$6,$7) RETURNING id::text`,
      [ws,source,route,key,reason,destination,isTest])).rows[0].id;
  const valid=await insertFailure('ws_a','src_a','',payload);
  const excluded=[];
  excluded.push(await insertFailure('ws_b','src_a','',payload));
  excluded.push(await insertFailure('ws_a','src_wrong','',payload));
  excluded.push(await insertFailure('ws_a','src_a','rt_a',payload));
  excluded.push(await insertFailure('ws_a','src_a','',payload+'-different'));
  excluded.push(await insertFailure('ws_a','src_a','',payload,'unknown_reason'));
  excluded.push(await insertFailure('ws_a','src_a','',payload,'max_retries_exceeded','dst_a'));
  excluded.push(await insertFailure('ws_a','src_a','',payload,'max_retries_exceeded',null,"now()+interval '2 minutes'"));
  excluded.push(await insertFailure('ws_a','src_a','',payload,'max_retries_exceeded',null,"now()-interval '2 minutes'",true));
  await client.query("UPDATE replay_requests SET finished_at=now(),state='done' WHERE id=$1",[replay.id]);
  // A replay marked done is insufficient: require the actual completed claim.
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  const deliveryEvent=`evt_missing#${replay.id}`;
  await client.query(`INSERT INTO delivery_idempotency(idempotency_key,workspace_id,event_id,route_id,destination_id,state,expires_at)
    VALUES('synthetic-reconcile','ws_a',$1,'rt_a','dst_a','in_flight',now()+interval '1 day')`,[deliveryEvent]);
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  await client.query("UPDATE delivery_idempotency SET state='completed',destination_id='dst_other' WHERE idempotency_key='synthetic-reconcile'");
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  await client.query("UPDATE delivery_idempotency SET destination_id='dst_a',workspace_id='ws_b' WHERE idempotency_key='synthetic-reconcile'");
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  await client.query("UPDATE delivery_idempotency SET workspace_id='ws_a',updated_at=now()-interval '1 day' WHERE idempotency_key='synthetic-reconcile'");
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  await client.query("UPDATE delivery_idempotency SET updated_at=now() WHERE idempotency_key='synthetic-reconcile'");
  await client.query("UPDATE replay_requests SET state='failed' WHERE id=$1",[replay.id]);
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);
  await client.query("UPDATE replay_requests SET state='done' WHERE id=$1",[replay.id]);
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,1);
  const resolved=(await client.query('SELECT resolved_by_replay_id FROM dead_letters WHERE id=$1',[valid])).rows[0];
  assert.equal(resolved.resolved_by_replay_id,replay.id);
  assert.equal((await client.query('SELECT count(*)::int n FROM dead_letters WHERE id=ANY($1::bigint[]) AND resolved_at IS NOT NULL',[excluded])).rows[0].n,0);
  assert.equal((await reconcileAsDashboard(resumeOptions)).confirmed_source_failures_resolved,0);

});


test("recovery diagnostics expose fixed codes without provider responses or customer values",()=>{
  assert.equal(safeRecoveryError('r2_get_429'),'r2_get_429');
  assert.equal(safeRecoveryError('rate_limited'),'rate_limited');
  assert.equal(safeRecoveryError('http_error_503'),'http_error_503');
  assert.equal(safeRecoveryError('queue_enqueue_503'),'queue_enqueue_503');
  assert.equal(safeRecoveryError('Replay produced no delivery attempts.'),'no_delivery_attempts');
  assert.equal(safeRecoveryError('r2_get_429 private payload'),'unrecognized_error');
  assert.equal(safeRecoveryError('private token or provider response'),'unrecognized_error');
});
