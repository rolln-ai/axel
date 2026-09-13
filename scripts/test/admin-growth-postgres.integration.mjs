import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GROWTH_WORKSPACES_SQL } from "../../apps/dashboard/lib/admin-growth-queries.ts";
import { connectDisposablePostgres } from "./postgres-integration-test-helpers.mjs";

test("adoption selects new external workspaces and their first signup audit only", { timeout: 120_000 }, async (t) => {
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const image = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").match(/image: (postgres:16@sha256:[a-f0-9]{64})/)[1];
  const password = randomBytes(24).toString("hex");
  const container = docker("run", "--rm", "--detach", "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, image);
  let client;
  t.after(async () => { await client?.end(); docker("rm", "--force", container); });
  const port = docker("port", container, "5432/tcp").split(":").at(-1);
  client = await connectDisposablePostgres(`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`);
  await client.query(readFileSync(new URL("../../infra/postgres/schema.sql", import.meta.url), "utf8"));
  await client.query(`INSERT INTO workspaces (id,name,created_at,billing_exempt,status) VALUES
    ('github','GitHub','2026-09-01',false,'active'), ('unknown','Unknown','2026-09-02',false,'active'),
    ('internal','Internal','2026-09-03',true,'active'), ('deleted','Deleted','2026-09-03',false,'deleted'),
    ('old','Old','2026-08-01',false,'active'), ('future','Future','2026-10-01',false,'active')`);
  await client.query(`INSERT INTO audit_log (workspace_id,action,target_type,target_id,metadata,created_at) VALUES
    ('github','workspace.created','workspace','github','{"signup_source":"github"}','2026-09-01'),
    ('github','workspace.created','workspace','github','{"signup_source":"website"}','2026-09-02'),
    ('unknown','member.joined','user','user','{"signup_source":"github"}','2026-09-02')`);
  const result = await client.query(GROWTH_WORKSPACES_SQL, ["2026-08-16T00:00:00Z", "2026-09-13T00:00:00Z"]);
  assert.deepEqual(result.rows.map(({ id, signup_source }) => ({ id, signup_source })), [
    { id: "unknown", signup_source: "unknown" }, { id: "github", signup_source: "github" },
  ]);
});
