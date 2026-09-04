/**
 * `GET /v1/cli/events?source_id=<id>&since=<iso>` — the polling
 * backbone for `axel listen` (AXE-26 Phase 2).
 *
 * The CLI polls this endpoint once per second, asking "anything new
 * for source_id since <last_seen>?". We answer with up to 50 events
 * (event_id, received_at, content_type, headers, body_base64) so the
 * CLI can forward each to the operator's localhost handler.
 *
 * Why polling instead of a WebSocket tunnel:
 *   - The full WebSocket story needs a per-source listener registry
 *     in delivery-service + ingest-worker fanout when an event lands
 *     for a registered source. That's a lot of moving parts for a
 *     dev-loop feature.
 *   - At ~1s p99 lag, polling is indistinguishable from "live" for
 *     a developer typing into a terminal. We can add WS later as a
 *     `--ws` flag without breaking the polling path.
 *
 * Cost guard: the ClickHouse query is bounded by `LIMIT 50` and the
 * `since` timestamp is required (no "give me everything" path). A
 * misconfigured CLI can't burn the analytics DB.
 */

import { Buffer } from "node:buffer";
import http from "node:http";
import {
  cloudflareR2ObjectUrl,
  isCanonicalRawPayloadKey,
} from "@axel/shared";
import type { CliApiDeps } from "./cli-api.js";
import {
  readResponseBytesLimited,
  readResponseTextLimited,
} from "./cli-bounded-io.js";

interface EventRow {
  event_id: string;
  source_id: string;
  // Aliased to *_text (not `received_at`) so the stringified value can't
  // shadow the typed column in the WHERE comparison — see
  // scripts/check-clickhouse-aliases.mjs. Remapped to `received_at` in the
  // response so the CLI wire contract is unchanged.
  received_at_text: string;
  content_type: string;
  r2_key: string;
}

const MAX_EVENTS_PER_POLL = 50;
const MAX_LISTEN_CLICKHOUSE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LISTEN_EVENT_PAYLOAD_BYTES = 5 * 1024 * 1024;

export async function handleListenStream(
  res: http.ServerResponse,
  ctx: { workspace_id: string },
  deps: CliApiDeps,
  url: URL,
): Promise<void> {
  const sourceId = url.searchParams.get("source_id")?.trim() ?? "";
  const since = url.searchParams.get("since")?.trim() ?? "";
  if (!sourceId) {
    return jsonResponse(res, 400, { error: "missing_source_id", message: "source_id query param is required." });
  }
  if (!since) {
    return jsonResponse(res, 400, { error: "missing_since", message: "since query param (ISO-8601 ms) is required." });
  }
  if (!deps.clickhouseUrl) {
    return jsonResponse(res, 503, { error: "clickhouse_unconfigured", message: "delivery-service has no CLICKHOUSE_URL." });
  }

  // Confirm the source belongs to the caller's workspace before
  // streaming its events. Same defence-in-depth check the trigger
  // endpoint uses.
  const sourceCheck = await deps.pool.query<{ id: string }>(
    "SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1",
    [sourceId, ctx.workspace_id],
  );
  if (!sourceCheck.rowCount) {
    return jsonResponse(res, 404, {
      error: "source_not_found",
      message: "Source not found in this workspace.",
    });
  }

  const chHeaders: Record<string, string> = { accept: "application/json" };
  if (deps.clickhouseUser) chHeaders["x-clickhouse-user"] = deps.clickhouseUser;
  if (deps.clickhousePassword) chHeaders["x-clickhouse-key"] = deps.clickhousePassword;
  const query = `SELECT event_id, source_id,
                        toString(received_at) AS received_at_text,
                        content_type, r2_key
                   FROM events
                  WHERE workspace_id = {workspace_id:String}
                    AND source_id = {source_id:String}
                    AND received_at > parseDateTime64BestEffort({since:String})
                  ORDER BY received_at ASC
                  LIMIT ${MAX_EVENTS_PER_POLL}
                  FORMAT JSON`;
  const chUrl = new URL(deps.clickhouseUrl);
  chUrl.searchParams.set("query", query);
  chUrl.searchParams.set("param_workspace_id", ctx.workspace_id);
  chUrl.searchParams.set("param_source_id", sourceId);
  chUrl.searchParams.set("param_since", since);

  let chRes: Response;
  try {
    chRes = await (deps.fetchImpl ?? fetch)(chUrl, { headers: chHeaders, redirect: "manual" });
  } catch {
    console.error("[/v1/cli/events] clickhouse fetch failed");
    return jsonResponse(res, 502, {
      error: "clickhouse_unreachable",
      message: "Upstream ClickHouse request failed.",
    });
  }
  if (!chRes.ok) {
    await chRes.body?.cancel().catch(() => undefined);
    return jsonResponse(res, 502, {
      error: `clickhouse_${chRes.status}`,
      message: "ClickHouse request failed.",
    });
  }
  let json: { data?: EventRow[] };
  try {
    const parsed = JSON.parse(await readResponseTextLimited(
      chRes,
      MAX_LISTEN_CLICKHOUSE_RESPONSE_BYTES,
    )) as unknown;
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || (
        "data" in parsed
        && !Array.isArray((parsed as { data?: unknown }).data)
      )
    ) {
      throw new Error("clickhouse_response_contract_invalid");
    }
    json = parsed as typeof json;
  } catch {
    return jsonResponse(res, 502, {
      error: "clickhouse_invalid_response",
      message: "ClickHouse returned an invalid response.",
    });
  }
  const rows = json.data ?? [];

  // Fetch raw bytes from R2 in parallel — bounded at MAX_EVENTS_PER_POLL.
  // Skip events whose R2 fetch fails so we don't stall the entire poll
  // on one bad object; the CLI will see them on the next tick.
  const events = await Promise.all(
    rows.map(async (row) => {
      if (
        !isEventRow(row)
        || row.source_id !== sourceId
        || !isCanonicalRawPayloadKey(row.r2_key, {
          workspaceId: ctx.workspace_id,
          eventId: row.event_id,
          sourceId,
        })
      ) {
        return null;
      }
      const r2Url = cloudflareR2ObjectUrl(
        deps.cloudflareAccountId,
        deps.rawPayloadBucket,
        row.r2_key,
      );
      try {
        const r2Res = await (deps.fetchImpl ?? fetch)(r2Url, {
          redirect: "manual",
          headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
        });
        if (!r2Res.ok) {
          await r2Res.body?.cancel().catch(() => undefined);
          return null;
        }
        const buf = Buffer.from(await readResponseBytesLimited(
          r2Res,
          MAX_LISTEN_EVENT_PAYLOAD_BYTES,
        ));
        return {
          event_id: row.event_id,
          source_id: row.source_id,
          received_at: row.received_at_text,
          content_type: row.content_type,
          // Request metadata values never cross the CLI export boundary.
          headers: {},
          body_base64: buf.toString("base64"),
        };
      } catch {
        return null;
      }
    }),
  );

  return jsonResponse(res, 200, {
    events: events.filter((e): e is NonNullable<typeof e> => e !== null),
    truncated: rows.length === MAX_EVENTS_PER_POLL,
  });
}

function isEventRow(value: unknown): value is EventRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Partial<EventRow>;
  return typeof row.event_id === "string"
    && typeof row.source_id === "string"
    && typeof row.received_at_text === "string"
    && typeof row.content_type === "string"
    && typeof row.r2_key === "string";
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
