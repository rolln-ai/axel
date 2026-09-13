import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "../apps/dashboard/lib/passwords.ts";
import { origins, qaPortBase } from "../tests/visual/origins.ts";
import { dashboardFixture, qaPassword, qaProjects } from "../tests/dashboard/fixtures.mjs";
import { startDashboardQaIngest } from "./test/dashboard-qa-ingest.mjs";
import { startDashboardQaMailbox } from "./test/dashboard-qa-mailbox.mjs";
import { connectDisposablePostgres } from "./test/postgres-integration-test-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dashboard = `${root}apps/dashboard`;
const testMode = process.argv[2] === "--test";
assert.ok(testMode || process.argv.length === 2, "Use dashboard-qa.mjs [--test [Playwright options]]");

// Next loads these files itself. Never run synthetic QA with local production settings.
for (const dir of [root, dashboard]) {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    assert.ok(!existsSync(`${dir}/${name}`), `Use a clean worktree without ${name} for dashboard QA`);
  }
}

// Inherit tool locations, never application credentials or Node preload options.
const qaEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "PNPM_HOME", "COREPACK_HOME", "CI"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
Object.assign(qaEnv, {
  AXEL_QA_PORT_BASE: String(qaPortBase),
  AXEL_DISPOSABLE_DASHBOARD_QA: "1",
  AXEL_DEPLOYMENT_MODE: "self-hosted",
  AXEL_SELF_HOST_PROFILE: "small",
  NEXT_PUBLIC_AXEL_APP_URL: origins.dashboard,
  AXEL_INGEST_URL: origins.dashboard,
  RAW_PAYLOAD_BUCKET: "axel-local-qa",
  NEXT_TELEMETRY_DISABLED: "1",
  CREDENTIALS_MASTER_KEY: randomBytes(32).toString("hex"),
});

const children = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
}
function start(command, args, cwd = root) {
  assert.ok(!interrupted, "Dashboard QA interrupted");
  const child = spawn(command, args, { cwd, env: qaEnv, stdio: "inherit" });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}
async function run(command, args) {
  const child = start(command, args);
  const [code] = await once(child, "close");
  assert.equal(code, 0, `${command} failed`);
}
function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let container;
let client;
let server;
let ingest;
let mailbox;
try {
  // Refuse a busy port before building; never test a neighboring worktree's server.
  const probe = createServer();
  probe.listen(qaPortBase + 1, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((resolve) => probe.close(resolve));
  await run("pnpm", ["--filter", "@axel/dashboard...", "build"]);

  const image = readFileSync(`${root}.github/workflows/ci.yml`, "utf8")
    .match(/image: (postgres:16@sha256:[a-f0-9]{64})/)?.[1];
  assert.ok(image, "Use the pinned Postgres image from CI");
  const password = randomBytes(24).toString("hex");
  container = docker("run", "--rm", "--detach", "--label", "com.axel.dashboard-qa=1", "--publish", "127.0.0.1::5432",
    "--env", `POSTGRES_PASSWORD=${password}`, image);
  const port = docker("port", container, "5432/tcp").split(":").at(-1);
  qaEnv.DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
  client = await connectDisposablePostgres(qaEnv.DATABASE_URL);
  await client.query(readFileSync(`${root}infra/postgres/schema.sql`, "utf8"));
  const passwordHash = hashPassword(qaPassword);
  for (const project of qaProjects) {
    const fixture = dashboardFixture(project);
    await client.query("INSERT INTO users (id,email,name,password_hash,email_verified_at,is_super_admin) VALUES ($1,$2,'QA administrator',$3,now(),true)",
      [`admin_${fixture.userId}`, `admin-${fixture.email}`, passwordHash]);
    await client.query("INSERT INTO users (id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())",
      [fixture.userId, fixture.email, "QA Operator", passwordHash]);
    await client.query("INSERT INTO workspaces (id,name,slug) VALUES ($1,$2,$3)",
      [fixture.workspaceId, fixture.workspaceName, project]);
    await client.query("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')",
      [fixture.workspaceId, fixture.userId]);
    await client.query("INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES ($1,$2,'Synthetic webhook',$3,'active')",
      [fixture.sourceId, fixture.workspaceId, randomBytes(32).toString("hex")]);
    await client.query(`INSERT INTO pipeline_incidents (id, workspace_id, source_id, incident_key, kind, snapshot)
      VALUES ($1,$2,$3,$4,'source_silent',$5::jsonb)`, [
      `inc_${fixture.sourceId}`, fixture.workspaceId, fixture.sourceId, `source:${fixture.sourceId}`,
      JSON.stringify({sourceId: fixture.sourceId, sourceName: "Synthetic webhook", destinationId: null, destinationName: null,
        routeId: null, lastReceived: new Date(Date.now() - 7200000).toISOString(), lastDelivered: null,
        failedCount: 0, waitingCount: 0, thresholdMinutes: 30, cause: "no_traffic"}),
    ]);
    const recoverySource = `${fixture.sourceId}_recovery`;
    const recoveryMap = `${fixture.sourceId}_contract`;
    const recoveryVersion = `${fixture.sourceId}_version`;
    await client.query("INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES ($1,$2,'Recovery fixture','synthetic','active')", [recoverySource, fixture.workspaceId]);
    await client.query("INSERT INTO data_contracts (id,workspace_id,source_id,name,status) VALUES ($1,$2,$3,'Saved contract summary','active')", [recoveryMap, fixture.workspaceId, recoverySource]);
    await client.query(`INSERT INTO data_contract_versions (id,data_contract_id,workspace_id,version_number,inferred_schema,generated_transform)
      VALUES ($1,$2,$3,1,'{"event_types":[],"fields":{}}','{"kind":"select","assignment_count":1}')`, [recoveryVersion,recoveryMap,fixture.workspaceId]);
    await client.query("UPDATE data_contracts SET current_version_id=$2 WHERE id=$1", [recoveryMap,recoveryVersion]);
    await client.query(`INSERT INTO dead_letters (id,workspace_id,event_id,source_id,route_id,r2_key,reason,message,errored_at,ai_summary,ai_suggested_action,ai_summarized_at)
      VALUES ($1,$2,'synthetic-failure',$3,'synthetic-route','events/synthetic/key','delivery_dead','bigquery_schema_mismatch',now(),'Synthetic diagnostic','Review synthetic schema',now())`, [fixture.investigationId,fixture.workspaceId,recoverySource]);
    const routeId = `${fixture.sourceId}_schema`;
    await client.query("INSERT INTO routes (id,workspace_id,source_id,name,status) VALUES ($1,$2,$3,'Synthetic schema policy','active')",
      [routeId, fixture.workspaceId, fixture.sourceId]);
    for (const [type, binding] of Object.entries({
      bigquery: { dataset: "synthetic", table: "events", mode: "typed_records" },
      postgres: { table: "events", mode: "dotted_columns" },
      databricks_sql: { table: "events", mode: "typed_columns" },
    })) {
      const destinationId = `${routeId}_${type}`;
      await client.query("INSERT INTO destinations (id,workspace_id,name,type,config) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
        [destinationId, fixture.workspaceId, `Synthetic ${type}`, type]);
      await client.query("INSERT INTO route_destinations (route_id,destination_id,binding) VALUES ($1,$2,$3::jsonb)",
        [routeId, destinationId, JSON.stringify(binding)]);
    }
  }
  await client.query("INSERT INTO workspaces (id,name,slug) VALUES ('ws_qa_foreign','Foreign workspace','foreign-workspace')");
  await client.query("INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES ('src_qa_foreign','ws_qa_foreign','Foreign source',$1,'active')",
    [randomBytes(32).toString("hex")]);
  await client.end();
  client = undefined;

  ingest = await startDashboardQaIngest(qaEnv.DATABASE_URL, qaEnv.CREDENTIALS_MASTER_KEY);
  qaEnv.AXEL_INGEST_URL = ingest.origin;
  qaEnv.INGEST_ADMIN_URL = ingest.origin;
  qaEnv.INGEST_ADMIN_TOKEN = ingest.adminToken;
  mailbox = await startDashboardQaMailbox();
  qaEnv.RESEND_BASE_URL = mailbox.origin;
  qaEnv.RESEND_API_KEY = mailbox.key;
  qaEnv.RESEND_FROM_EMAIL = "Axel QA <noreply@example.test>";

  server = start(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(qaPortBase + 1)], dashboard);
  const serverClosed = once(server, "close");
  const deadline = Date.now() + 30_000;
  while (true) {
    assert.ok(!interrupted && server.exitCode === null && server.signalCode === null, "Dashboard QA server stopped");
    try {
      const response = await fetch(`${origins.dashboard}/login`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) break;
    } catch { /* Wait for Next to listen. */ }
    assert.ok(Date.now() < deadline, "Dashboard QA server did not start");
    await delay(250);
  }
  if (testMode) {
    await run("pnpm", ["exec", "playwright", "test", "-c", "playwright.dashboard.config.ts", ...process.argv.slice(3)]);
  } else {
    console.log(`Disposable dashboard: ${origins.dashboard}/login\nEmail: ${dashboardFixture("desktop-light").email}\nSynthetic password: ${qaPassword}\nPress Ctrl-C to remove the QA database.`);
    const [code] = await serverClosed;
    assert.ok(interrupted || code === 0, "Dashboard QA server failed");
  }
} finally {
  await mailbox?.close();
  await ingest?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, "close");
    server.kill("SIGTERM");
    const forceStop = setTimeout(() => server.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(forceStop);
  }
  await client?.end();
  if (container) docker("rm", "--force", container);
}
