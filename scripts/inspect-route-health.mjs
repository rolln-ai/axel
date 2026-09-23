#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";

// Only codes defined by the engine may reach public workflow logs. Never
// print error_message, graph contents, event identifiers, or provider bodies.
const engineSource = readFileSync(new URL("../packages/shared/src/route-engine.ts", import.meta.url), "utf8");
const reasons = new Set([...engineSource.matchAll(/new RouteEngineError\(\s*"([a-z_]+)"/g)].map(match => match[1]));
for (const reason of ["declarative_engine_error", "engine_disabled", "max_retries_exceeded", "delivery_dead", "payload_missing", "raw_payload_missing", "router_processing_failed"]) reasons.add(reason);
const safeReason = value => value == null ? null : reasons.has(value) ? value : "unrecognized_code";

export function validateRouteScope(workspaceId, routeId) {
  if (!/^ws_[A-Za-z0-9_-]{1,100}$/.test(workspaceId ?? "") || !/^rt_[A-Za-z0-9_-]{1,100}$/.test(routeId ?? "")) {
    throw new Error("route_health_invalid_scope");
  }
}

export async function inspectRouteHealth(client, workspaceId, routeId) {
  validateRouteScope(workspaceId, routeId);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const route = (await client.query(`SELECT r.status, r.engine, r.error_reason, r.updated_at, r.source_id
      FROM routes r JOIN sources s ON s.id = r.source_id AND s.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, routeId])).rows[0];
    if (!route) return { route_found: false };
    const destinations = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE d.delivery_paused)::int AS paused,
      count(*) FILTER (WHERE d.status = 'disabled')::int AS disabled,
      count(*) FILTER (WHERE d.circuit_state IN ('open','disabled'))::int AS circuit_blocked
      FROM routes r JOIN route_destinations rd ON rd.route_id = r.id
      JOIN destinations d ON d.id = rd.destination_id AND d.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, routeId])).rows[0];
    const failures = (await client.query(`SELECT dl.reason, count(*)::int AS count, max(dl.errored_at) AS latest
      FROM dead_letters dl JOIN routes r ON r.id = dl.route_id AND r.workspace_id = dl.workspace_id AND r.source_id = dl.source_id
      WHERE dl.workspace_id = $1 AND dl.route_id = $2 AND dl.resolved_at IS NULL
      GROUP BY dl.reason ORDER BY max(dl.errored_at) DESC LIMIT 20`, [workspaceId, routeId])).rows;
    const sourceFailures = (await client.query(`SELECT reason, count(*)::int AS count, max(errored_at) AS latest
      FROM dead_letters WHERE workspace_id=$1 AND source_id=$2 AND route_id='' AND resolved_at IS NULL
      GROUP BY reason ORDER BY max(errored_at) DESC LIMIT 20`, [workspaceId, route.source_id])).rows;
    const incidents = (await client.query(`SELECT
      count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
      count(*) FILTER (WHERE resolved_at IS NULL AND healthy_since IS NOT NULL)::int AS recovering,
      max(observed_at) AS last_observed_at, max(resolved_at) AS last_resolved_at
      FROM pipeline_incidents WHERE workspace_id=$1 AND source_id=$2 AND kind='delivery_blocked'
        AND (NULLIF(snapshot->>'routeId','') IS NULL OR snapshot->>'routeId'=$3)`,
      [workspaceId, route.source_id, routeId])).rows[0];
    return {
      route_found: true,
      status: ["active", "disabled", "errored"].includes(route.status) ? route.status : "unknown",
      engine: ["declarative", "legacy_js"].includes(route.engine) ? route.engine : "unknown",
      error_reason: safeReason(route.error_reason),
      updated_at: route.updated_at.toISOString(),
      destinations,
      delivery_incidents: incidents,
      source_failures_before_routing: sourceFailures.map(row => ({ reason: safeReason(row.reason), count: row.count, latest: row.latest.toISOString() })),
      failures: failures.map(row => ({ reason: safeReason(row.reason), count: row.count, latest: row.latest.toISOString() })),
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main() {
  const { DATABASE_URL, DATABASE_TLS_VERIFY, ROUTE_HEALTH_WORKSPACE_ID, ROUTE_HEALTH_ROUTE_ID } = process.env;
  validateRouteScope(ROUTE_HEALTH_WORKSPACE_ID, ROUTE_HEALTH_ROUTE_ID);
  if (!DATABASE_URL) throw new Error("route_health_database_unavailable");
  const client = new pg.Client({ connectionString: DATABASE_URL,
    ssl: controlPlanePgSslOption(DATABASE_URL, DATABASE_TLS_VERIFY), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    console.log(JSON.stringify(await inspectRouteHealth(client, ROUTE_HEALTH_WORKSPACE_ID, ROUTE_HEALTH_ROUTE_ID), null, 2));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("route_health_inspection_failed"); process.exitCode = 1; });
}
