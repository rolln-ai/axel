import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { recoverArrayCollapseRoute, recoveryErrorCode } from "../recover-array-collapse-route.mjs";
import { databaseServiceAccessProfile } from "../database-service-access-profiles.mjs";
import { connectDisposablePostgres } from "./postgres-integration-test-helpers.mjs";

test("route recovery validates retained payloads before an audited atomic resume and replay", { timeout: 120_000 }, async t => {
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const password = randomBytes(24).toString("hex");
  const container = docker("run", "--rm", "--detach", "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`,
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73");
  let client;
  t.after(async () => { await client?.end(); docker("rm", "--force", container); });
  const port = docker("port", container, "5432/tcp").split(":").at(-1);
  client = await connectDisposablePostgres(`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`);
  await client.query(readFileSync(new URL("../../infra/postgres/schema.sql", import.meta.url), "utf8"));
  await client.query("INSERT INTO workspaces (id,name) VALUES ('ws_a','Synthetic A'),('ws_b','Synthetic B')");
  await client.query("INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES ('src_a','ws_a','Synthetic source','synthetic','active')");
  const graph = { version: 1, nodes: [{ id: "src", kind: "source" },
    { id: "collapse", kind: "transform", transform: { kind: "collapse_arrays", fields: [{ path: "data.properties.tags", format: "json" }] } },
    { id: "dst", kind: "destination", destination_id: "dst_a" }], edges: [{ from: "src", to: "collapse" }, { from: "collapse", to: "dst" }] };
  await client.query(`INSERT INTO routes (id,workspace_id,source_id,status,error_reason,pipeline_graph,updated_at)
    VALUES ('rt_a','ws_a','src_a','errored','transform_collapse_array_expected_array',$1::jsonb,'2026-09-17T01:33:39.956Z')`, [JSON.stringify(graph)]);
  await client.query("INSERT INTO destinations (id,workspace_id,name,type,config) VALUES ('dst_a','ws_a','Synthetic destination','bigquery','{}')");
  await client.query("INSERT INTO route_destinations (route_id,destination_id) VALUES ('rt_a','dst_a')");
  await client.query(`INSERT INTO dead_letters (workspace_id,event_id,source_id,route_id,r2_key,reason,message,errored_at,fingerprint)
    VALUES ('ws_a','evt_a','src_a','rt_a','events/ws_a/2026-09-17/evt_a','transform_collapse_array_expected_array','operation_failed',now(),'synthetic-fingerprint')`);
  const options = { workspaceId: "ws_a", routeId: "rt_a", expectedUpdatedAt: "2026-09-17T01:33:39.956Z",
    runUrl: "https://github.com/rolln-ai/axel/actions/runs/123", readPayload: async () => ({ data: { properties: { tags: "already text" } } }) };
  const assertUnchanged = async () => {
    assert.equal((await client.query("SELECT status FROM routes WHERE id='rt_a'")).rows[0].status, "errored");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM replay_requests")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n, 0);
  };
  await assert.rejects(recoverArrayCollapseRoute(client, { ...options, workspaceId: "ws_b" }));
  await assert.rejects(recoverArrayCollapseRoute(client, { ...options, expectedUpdatedAt: "2026-09-18T00:00:00Z" }));
  await assert.rejects(recoverArrayCollapseRoute(client, { ...options, readPayload: async () => ({ data: { properties: { tags: 123 } } }) }));
  await assert.rejects(recoverArrayCollapseRoute(client, { ...options, readPayload: async () => { throw new Error("storage unavailable"); } }));
  await assertUnchanged();
  await client.query("UPDATE destinations SET delivery_paused=true WHERE id='dst_a'");
  await assert.rejects(recoverArrayCollapseRoute(client, options));
  await client.query("UPDATE destinations SET delivery_paused=false WHERE id='dst_a'");
  await client.query("INSERT INTO dead_letter_mutes(id,workspace_id,fingerprint) VALUES ('mute_a','ws_a','synthetic-fingerprint')");
  await assert.rejects(recoverArrayCollapseRoute(client, options));
  await assertUnchanged();
  await client.query("DELETE FROM dead_letter_mutes");
  await assert.rejects(recoverArrayCollapseRoute(client, { ...options, readPayload: async () => {
    await client.query("UPDATE routes SET updated_at=now() WHERE id='rt_a'");
    return options.readPayload();
  } }));
  await assertUnchanged();
  await client.query("UPDATE routes SET updated_at='2026-09-17T01:33:39.956Z' WHERE id='rt_a'");
  // Exercise the production dashboard role: route_destinations has no UPDATE
  // privilege, so SELECT FOR SHARE on that binding table is forbidden.
  await client.query("CREATE ROLE synthetic_dashboard NOLOGIN");
  const profile = databaseServiceAccessProfile("dashboard");
  for (const [table, privileges] of Object.entries(profile.tables))
    await client.query(`GRANT ${privileges.join(",")} ON TABLE ${table} TO synthetic_dashboard`);
  for (const [sequence, privileges] of Object.entries(profile.sequences))
    await client.query(`GRANT ${privileges.join(",")} ON SEQUENCE ${sequence} TO synthetic_dashboard`);
  await client.query("SET ROLE synthetic_dashboard");
  assert.deepEqual(await recoverArrayCollapseRoute(client, options), { status: "resumed", validated_failures: 1, replays_queued: 1, already_in_flight: 0 });
  await client.query("RESET ROLE");
  assert.equal((await client.query("SELECT status FROM routes WHERE id='rt_a'")).rows[0].status, "active");
  const replay = (await client.query("SELECT workspace_id,event_id,scope,route_id,state FROM replay_requests")).rows;
  assert.deepEqual(replay, [{ workspace_id: "ws_a", event_id: "evt_a", scope: "route", route_id: "rt_a", state: "pending" }]);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n, 2);
  assert.equal((await client.query("SELECT resolved_at FROM dead_letters")).rows[0].resolved_at, null);
  await assert.rejects(recoverArrayCollapseRoute(client, options));
  assert.equal((await client.query("SELECT count(*)::int AS n FROM replay_requests")).rows[0].n, 1);
});

 test("recovery diagnostics never expose provider bodies or customer values", () => {
  assert.equal(recoveryErrorCode(new Error("private provider response")), "operation_failed");
  assert.equal(recoveryErrorCode(Object.assign(new Error("private SQL detail"), { code: "42501" })), "postgres_42501");
  assert.equal(recoveryErrorCode(new Error("route_recovery_payload_key_mismatch")), "route_recovery_payload_key_mismatch");
});
