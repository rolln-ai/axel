import { FLOW_ACTIVITY_SQL, DELIVERY_ACTIVITY_SQL, UNATTEMPTED_SQL } from "../../apps/dashboard/lib/impact-alert-queries.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  latestOutcomesCTE,
  SUCCESS_PREDICATE,
  TERMINAL_FAILURE_PREDICATE,
} from "../../apps/dashboard/lib/clickhouse-fragments.ts";

// Always create our own disposable database. Never accept a ClickHouse URL or
// credentials from the operator environment. Use the production image version.
const image = readFileSync(new URL("../../infra/clickhouse/Dockerfile", import.meta.url), "utf8")
  .match(/^FROM (\S+)/m)?.[1];
assert.ok(image?.includes("@sha256:"), "ClickHouse image must be pinned");
const schema = readFileSync(new URL("../../infra/clickhouse/schema.sql", import.meta.url), "utf8");
const rollupDdl = schema.match(/CREATE TABLE IF NOT EXISTS delivery_base_latest_outcomes\b[\s\S]*?;/)?.[0];
assert.ok(rollupDdl);

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("delivery rollup preserves outcomes before background merges", { timeout: 120_000 }, async (t) => {
  const container = docker("run", "--detach", "--rm", "--publish", "127.0.0.1::8123",
    "--env", "CLICKHOUSE_SKIP_USER_SETUP=1", image);
  t.after(() => docker("rm", "--force", container));
  const port = docker("port", container, "8123/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const response = await fetch(`${origin}/ping`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) break;
    } catch { /* The container is still starting. */ }
    assert.ok(Date.now() < deadline, "Disposable ClickHouse did not start");
    await delay(250);
  }

  async function query(sql, params = {}) {
    const url = new URL(origin);
    url.searchParams.set("default_format", "JSON");
    url.searchParams.set("max_execution_time", "15");
    url.searchParams.set("max_threads", "2");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(`param_${key}`, value);
    const response = await fetch(url, { method: "POST", body: sql, signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    assert.equal(response.status, 200, `Synthetic ClickHouse query failed: ${body}`);
    return body.trim() ? JSON.parse(body) : { data: [] };
  }

  await query(rollupDdl);
  await query("SYSTEM STOP MERGES delivery_base_latest_outcomes");
  const now = Date.now();
  const at = (offset) => new Date(now + offset * 86_400_000).toISOString().replace("T", " ").replace("Z", "");
  const rows = [
    ["ws_a", "evt_retry", "route_a", "dst_a", "retry", "{}", at(-3)],
    ["ws_a", "evt_retry", "route_a", "dst_a", "success", "{}", at(-2)],
    ["ws_a", "evt_replay", "route_a", "dst_a", "dead", '{"error":"timeout"}', at(-3)],
    ["ws_a", "evt_replay", "route_a", "dst_a", "success", "{}", at(-1)],
    ["ws_a", "evt_duplicate", "route_a", "dst_a", "dead", '{"error":"already_delivered"}', at(-2)],
    ["ws_a", "evt_retry", "route_a", "dst_b", "dead", '{"error":"http_400"}', at(-2)],
    ["ws_a", "evt_retry", "route_b", "dst_a", "retry", "{}", at(-2)],
    ["ws_b", "evt_retry", "route_a", "dst_a", "dead", "{}", at(-2)],
    ["ws_a", "evt_old", "route_a", "dst_a", "success", "{}", at(-12)],
    // Latest activity after the report window must exclude the old failure.
    ["ws_a", "evt_after", "route_a", "dst_a", "dead", "{}", at(-3)],
    ["ws_a", "evt_after", "route_a", "dst_a", "success", "{}", at(1)],
  ];
  // Separate inserts force different parts. FINAL must work before merges run.
  for (const row of rows) await query(`INSERT INTO delivery_base_latest_outcomes FORMAT JSONCompactEachRow\n${JSON.stringify(row)}`);
  await query(schema.match(/CREATE TABLE IF NOT EXISTS events\b[\s\S]*?;/)[0]);
  await t.test("impact monitoring uses accepted traffic, current retries and tenant-scoped missing deliveries", async () => {
    const received = (minutes) => new Date(now - minutes * 60000).toISOString().replace("T", " ").replace("Z", "");
    const eventRows = Array.from({length: 25}, (_, i) => ({workspace_id: "ws_monitor", source_id: "src_monitor", event_id: `event_${i}`, received_at: received(60 + i * 2)}));
    eventRows.push({workspace_id: "ws_monitor", source_id: "src_monitor", event_id: "test", received_at: received(0), is_test: true});
    eventRows.push({workspace_id: "ws_other", source_id: "src_monitor", event_id: "other", received_at: received(0)});
    await query(`INSERT INTO events FORMAT JSONEachRow\n${eventRows.map(r => JSON.stringify(r)).join("\n")}`);
    const flow = (await query(FLOW_ACTIVITY_SQL, {workspace_id: "ws_monitor"})).data;
    assert.equal(flow.length, 1);
    assert.equal(Number(flow[0].samples), 25);
    assert.equal(Number(flow[0].typical_gap_seconds), 120);
    assert.equal(Date.parse(flow[0].last_received.replace(" ", "T") + "Z"), now - 60 * 60000);
    await query(`INSERT INTO delivery_base_latest_outcomes FORMAT JSONEachRow\n${[
      {workspace_id: "ws_monitor", base_event_id: "event_0", route_id: "route_monitor", destination_id: "dst_monitor", latest_status: "retry", latest_response: "{}", latest_at: received(1)},
      {workspace_id: "ws_monitor", base_event_id: "event_1", route_id: "route_monitor", destination_id: "dst_monitor", latest_status: "dead", latest_response: '{"error":"bigquery_schema_mismatch"}', latest_at: received(1)},
      {workspace_id: "ws_monitor", base_event_id: "test", route_id: "route_monitor", destination_id: "dst_monitor", latest_status: "retry", latest_response: "{}", latest_at: received(60)},
    ].map(r => JSON.stringify(r)).join("\n")}`);
    const delivery = (await query(DELIVERY_ACTIVITY_SQL, {workspace_id: "ws_monitor"})).data[0];
    assert.equal(Number(delivery.waiting_count), 1, "recent retry of an old event is still overdue; test events are excluded");
    assert.equal(Number(delivery.schema_failures), 1);
    const missing = (await query(UNATTEMPTED_SQL, {workspace_id: "ws_monitor", source_id: "src_monitor", route_id: "route_monitor", destination_id: "dst_monitor", route_created: received(300)})).data[0];
    assert.equal(Number(missing.waiting_count), 23);
  });
  const params = { workspace_id: "ws_a", start: at(-7), end: at(0), destination_id: "dst_a" };
  const candidate = latestOutcomesCTE({ source: "rollup" });
  const reference = `SELECT base_event_id, route_id, destination_id,
    argMax(latest_status, latest_at) AS outcome_status,
    argMax(latest_response, latest_at) AS outcome_response, max(latest_at) AS outcome_at
    FROM delivery_base_latest_outcomes WHERE workspace_id = {workspace_id:String}
    AND latest_at >= parseDateTime64BestEffort({start:String}, 3)
    GROUP BY base_event_id, route_id, destination_id`;
  const totals = (cte) => `SELECT count() AS total, countIf(${SUCCESS_PREDICATE}) AS success,
    countIf(outcome_status = 'retry') AS retry, countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead
    FROM (${cte}) WHERE outcome_at < parseDateTime64BestEffort({end:String}, 3)`;

  await t.test("deduplicates retries, scopes workspaces, and counts already-delivered as success", async () => {
    const result = await query(totals(candidate), params);
    assert.deepEqual(result.data, [{ total: "5", success: "3", retry: "1", dead: "1" }]);
    assert.deepEqual(result.data, (await query(totals(reference), params)).data);
  });
  await t.test("applies destination scope without collapsing route fan-out", async () => {
    const scoped = latestOutcomesCTE({ source: "rollup", scope: { destination: true } });
    assert.deepEqual((await query(totals(scoped), params)).data,
      [{ total: "4", success: "3", retry: "1", dead: "0" }]);
  });
  await t.test("applies the report end after selecting the latest outcome", async () => {
    const result = await query(`SELECT base_event_id FROM (${candidate})
      WHERE outcome_at < parseDateTime64BestEffort({end:String},3) ORDER BY base_event_id`, params);
    assert.equal(result.data.some((row) => row.base_event_id === "evt_after"), false);
    assert.equal(result.data.some((row) => row.base_event_id === "evt_old"), false);
    assert.equal(result.data.length, 5);
  });

  const benchmarkRows = Number(process.env.AXEL_ANALYTICS_BENCHMARK_ROWS ?? "0");
  assert.ok(Number.isInteger(benchmarkRows) && benchmarkRows >= 0 && benchmarkRows <= 1_000_000,
    "AXEL_ANALYTICS_BENCHMARK_ROWS must be 0..1000000");
  if (benchmarkRows > 0) {
    await query(`INSERT INTO delivery_base_latest_outcomes
      SELECT 'ws_benchmark', toString(number), 'route_a', 'dst_a', 'success', '{}', now64(3)
      FROM numbers(${benchmarkRows})`);
    const timings = {};
    let expected;
    const benchParams = { workspace_id: "ws_benchmark", start: at(-7), end: at(2) };
    for (const [name, cte] of [["reference", reference], ["candidate", candidate]]) {
      const result = await query(totals(cte), benchParams);
      expected ??= result.data;
      assert.deepEqual(result.data, expected);
      timings[name] = result.statistics.elapsed;
    }
    t.diagnostic(`Synthetic benchmark, ${benchmarkRows} rows, seconds: ${JSON.stringify(timings)}`);
  }
});
