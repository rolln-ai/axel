import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectRouteHealth, validateRouteScope } from "../inspect-route-health.mjs";
import { connectDisposablePostgres } from "./postgres-integration-test-helpers.mjs";

test("route diagnostic rejects unscoped and injected input", () => {
  for (const args of [["", "rt_a"], ["ws_a", ""], ["ws_a' OR true--", "rt_a"], ["ws_a", "rt_a\n"]]) {
    assert.throws(() => validateRouteScope(...args), /route_health_invalid_scope/);
  }
});

test("route diagnostic is read only, isolated, and never exports raw error text", { timeout: 120_000 }, async t => {
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const image = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
  const password = randomBytes(24).toString("hex");
  const container = docker("run", "--rm", "--detach", "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, image);
  let client;
  t.after(async () => { await client?.end(); docker("rm", "--force", container); });
  const port = docker("port", container, "5432/tcp").split(":").at(-1);
  client = await connectDisposablePostgres(`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`);
  await client.query(readFileSync(new URL("../../infra/postgres/schema.sql", import.meta.url), "utf8"));
  await client.query("INSERT INTO workspaces (id,name) VALUES ('ws_a','Synthetic A'),('ws_b','Synthetic B')");
  await client.query(`INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES
    ('src_a','ws_a','Synthetic source','synthetic','active'),('src_b','ws_b','Synthetic source','synthetic','active')`);
  await client.query(`INSERT INTO routes (id,workspace_id,source_id,status,error_reason,error_message) VALUES
    ('rt_a','ws_a','src_a','errored','transform_coerce_failed','PRIVATE PROVIDER RESPONSE'),
    ('rt_b','ws_b','src_b','errored','PRIVATE UNKNOWN CODE','PRIVATE PROVIDER RESPONSE')`);
  await client.query(`INSERT INTO destinations (id,workspace_id,name,type,config,delivery_paused,circuit_state) VALUES
    ('dst_a','ws_a','Synthetic destination','bigquery','{}',false,'closed'),
    ('dst_b','ws_b','Synthetic destination','bigquery','{}',true,'open')`);
  await client.query("INSERT INTO route_destinations (route_id,destination_id) VALUES ('rt_a','dst_a'),('rt_a','dst_b')");
  await client.query(`INSERT INTO dead_letters (workspace_id,event_id,source_id,route_id,r2_key,reason,message,errored_at) VALUES
    ('ws_a','private_event','src_a','rt_a','private_key','transform_coerce_failed','PRIVATE',now()),
    ('ws_b','private_event','src_b','rt_a','private_key','PRIVATE UNKNOWN CODE','PRIVATE',now())`);
  await client.query(`INSERT INTO dead_letters (workspace_id,event_id,source_id,route_id,r2_key,reason,message,errored_at) VALUES
    ('ws_a','private_event','src_a','','private_key','max_retries_exceeded','PRIVATE',now()),
    ('ws_a','private_event','src_other','','private_key','PRIVATE UNKNOWN CODE','PRIVATE',now()),
    ('ws_b','private_event','src_a','','private_key','PRIVATE UNKNOWN CODE','PRIVATE',now())`);
  const original = (await client.query("SELECT status,error_reason,updated_at FROM routes ORDER BY id")).rows;
  let sawReadOnly = false;
  const wrappedClient = { query: async (...args) => {
    if (args[0].startsWith("SELECT r.status")) {
      sawReadOnly = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
    }
    return client.query(...args);
  } };
  const report = await inspectRouteHealth(wrappedClient, "ws_a", "rt_a");
  assert.equal(sawReadOnly, true);
  assert.equal(report.status, "errored");
  assert.equal(report.error_reason, "transform_coerce_failed");
  assert.deepEqual(report.destinations, { total: 1, paused: 0, disabled: 0, circuit_blocked: 0 });
  assert.equal(report.source_failures_before_routing.length, 1);
  assert.equal(report.source_failures_before_routing[0].reason, 'max_retries_exceeded');
  assert.equal(report.source_failures_before_routing[0].count, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].count, 1);
  assert.equal(/PRIVATE|private_|src_|dst_/.test(JSON.stringify(report)), false);
  assert.deepEqual(await inspectRouteHealth(client, "ws_b", "rt_a"), { route_found: false });
  assert.equal((await inspectRouteHealth(client, "ws_b", "rt_b")).error_reason, "unrecognized_code");
  assert.deepEqual((await client.query("SELECT status,error_reason,updated_at FROM routes ORDER BY id")).rows, original);
});
