"use server";

/**
 * AI-powered dead letter explainer (AXE-54).
 *
 * Given a dead letter, load enough context to ask Claude what went
 * wrong and what the operator should do — then cache the response on
 * the dead_letters row so repeat clicks cost nothing.
 *
 * Distinct from `lib/data-contracts/explain.ts` (which proposes a patched
 * declarative DSL when a Data Contract is active). This explainer is the
 * generic case: any dead letter, regardless of routing setup, should
 * be able to surface a "Why?" answer in plain English.
 *
 * Privacy:
 *   - The prompt is built from the raw payload + the destination
 *     response. Both go through `redactObvious()` first to scrub the
 *     usual suspects (email addresses, phone numbers, card numbers,
 *     bearer tokens, URLs with secrets in the query string).
 *   - Cached output is plain text → safe to render unescaped through
 *     a styled container.
 */

import type { ActionState as ActionStateBase } from "./action-state";
import { appBaseUrl } from "./app-url";
import { db } from "./db";
import { fetchPayloadForR2Key } from "./sample-payload";
import { requireSession } from "./session";

export type ActionState = ActionStateBase<{
  summary?: string;
  suggested_action?: string;
  cached?: boolean;
}>;

interface DeadLetterRow {
  id: string;
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string | null;
  destination_id: string | null;
  r2_key: string;
  reason: string;
  message: string;
  ai_summary: string | null;
  ai_suggested_action: string | null;
  ai_summarized_at: string | null;
}

interface DestinationRow {
  type: string;
  name: string | null;
}

interface RouteRow {
  filter_expression: string | null;
  transform_script: string | null;
}

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROMPT_VERSION = "axe-54:v1";

const SYSTEM_PROMPT = `You are helping an Axel operator understand why a webhook delivery failed.

Inputs you'll receive:
- The raw event payload (truncated, PII redacted).
- The destination's HTTP response (status + body excerpt) and/or the connector's structured failure reason.
- The destination type (postgres, mongodb, http, webhook, s3, r2, …).
- The route's filter/transform DSL, if any.

Return ONLY a JSON object:
{
  "summary": "<one or two sentences in plain English. Lead with the root cause, not the symptom>",
  "suggested_action": "<one or two sentences with the next thing the operator should try. Be specific. Reference field names from the payload if relevant>"
}

Some failures are Axel-internal backpressure, NOT errors returned by the destination. Recognise these from the failure message and DO NOT blame the destination service:
- "delivery_service_503" with "delivery_overloaded": Axel's own delivery-service shed the request at its inbound concurrency cap (MAX_DELIVER_INFLIGHT) BEFORE contacting the destination. The destination never returned anything. Root cause is Axel-side capacity, often back-pressure from a slow/backed-up destination. Suggest checking the destination's recent latency and/or raising delivery-service capacity — not that the destination "returned 503".
- "breaker_open_cooldown_active" or "breaker_half_open_test_failed": Axel's circuit breaker for that destination is open after repeated failures, so deliveries are paused during cooldown. Point the operator at the destination's recent failures and the breaker state; the current event was not actually attempted against the destination.

Rules:
- Don't speculate when the response/reason is unambiguous; say what it says.
- If the cause is a transform mismatch (camelCase vs snake_case, missing field, wrong type), say so AND name the fields.
- If the cause is on the destination side (auth failure, schema not found, table missing), say so without proposing a transform change.
- For the Axel-internal backpressure cases above, lead with "Axel shed this before reaching the destination" so the operator doesn't chase a non-existent destination error.
- No markdown, no fences, no explanations outside the JSON object.`;

export async function explainDeadLetter(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const rawId = formData.get("dead_letter_id");
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) return { error: "dead_letter_id is required." };
  // "Re-ask" sends force=1 — bypass the cached early-return below and
  // re-call the LLM, overwriting the cached row (the UPDATE at the end
  // is an UPSERT-by-overwrite already).
  const force = formData.get("force") === "1";

  const dlRes = await db().query<DeadLetterRow>(
    `SELECT id::text AS id,
            workspace_id, event_id, source_id,
            NULLIF(route_id, '') AS route_id,
            NULLIF(destination_id, '') AS destination_id,
            r2_key, reason, message,
            ai_summary, ai_suggested_action,
            ai_summarized_at::text AS ai_summarized_at
       FROM dead_letters
      WHERE id = $1::bigint AND workspace_id = $2
      LIMIT 1`,
    [id, session.activeWorkspace.workspace_id],
  );
  const dl = dlRes.rows[0];
  if (!dl) return { error: "Dead letter not found in this workspace." };

  if (dl.ai_summary && !force) {
    return {
      notice: `Cached explanation from ${dl.ai_summarized_at}.`,
      data: {
        summary: dl.ai_summary,
        suggested_action: dl.ai_suggested_action ?? "",
        cached: true,
      },
    };
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return {
      error: "AI features aren't configured: set OPENROUTER_API_KEY on the dashboard to enable failure explanations.",
    };
  }

  // Load adjacent context — one extra round-trip each, all bounded.
  // Per-delivery HTTP response bodies live in ClickHouse, not PG, so
  // we lean on the dead-letter `reason` + `message` slugs as the
  // structured failure signal here.
  const [payload, destination, route] = await Promise.all([
    fetchPayloadForR2Key(dl.r2_key).catch(() => null),
    loadExplainDestination(dl).catch(() => null),
    dl.route_id
      ? db()
          .query<RouteRow>(
            `SELECT filter_expression, transform_script
               FROM routes WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
            [dl.route_id, dl.workspace_id],
          )
          .then((r) => r.rows[0] ?? null)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const userPrompt = buildUserPrompt({
    reason: dl.reason,
    message: dl.message,
    payload: redactObvious(payload),
    destination,
    route,
  });

  let summary: string;
  let suggestedAction: string;
  try {
    const result = await callOpenRouter(userPrompt);
    summary = result.summary;
    suggestedAction = result.suggested_action;
  } catch (err: unknown) {
    return {
      error: `Couldn't reach the AI service: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await db().query(
    `UPDATE dead_letters
        SET ai_summary = $1,
            ai_suggested_action = $2,
            ai_summarized_at = now()
      WHERE id = $3::bigint AND workspace_id = $4`,
    [summary, suggestedAction, id, session.activeWorkspace.workspace_id],
  );

  return {
    notice: "Explanation generated.",
    data: { summary, suggested_action: suggestedAction, cached: false },
  };
}

// Resolve the destination type/name for LLM context. Prefer the exact
// destination the failure was for (dead_letters.destination_id, populated
// post-0049). Otherwise fall back to the route's first attached destination
// as a representative — a route can fan out to many, and for context we only
// need one type/name.
function loadExplainDestination(dl: DeadLetterRow): Promise<DestinationRow | null> {
  if (dl.destination_id) {
    return db()
      .query<DestinationRow>(
        `SELECT type, name FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
        [dl.destination_id, dl.workspace_id],
      )
      .then((r) => r.rows[0] ?? null);
  }
  if (dl.route_id) {
    return db()
      .query<DestinationRow>(
        `SELECT d.type, d.name
           FROM route_destinations rd
           JOIN destinations d ON d.id = rd.destination_id
          WHERE rd.route_id = $1 AND d.workspace_id = $2
          ORDER BY d.id
          LIMIT 1`,
        [dl.route_id, dl.workspace_id],
      )
      .then((r) => r.rows[0] ?? null);
  }
  return Promise.resolve(null);
}

interface PromptInputs {
  reason: string;
  message: string;
  payload: unknown;
  destination: DestinationRow | null;
  route: RouteRow | null;
}

function buildUserPrompt(p: PromptInputs): string {
  const lines: string[] = [];
  lines.push(`Failure reason (Axel-side): ${p.reason}`);
  if (p.message) lines.push(`Failure message: ${truncate(p.message, 800)}`);
  if (p.destination) {
    lines.push(`Destination type: ${p.destination.type}`);
    if (p.destination.name) lines.push(`Destination name: ${p.destination.name}`);
  }
  if (p.route) {
    lines.push(
      `Route filter (DSL JSON): ${p.route.filter_expression ?? "(none)"}`,
    );
    lines.push(
      `Route transform (DSL JSON): ${p.route.transform_script ?? "(none — passthrough)"}`,
    );
  }
  if (p.payload !== null) {
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(p.payload);
    } catch {
      payloadJson = String(p.payload);
    }
    lines.push(`Event payload (PII redacted, truncated):\n${truncate(payloadJson, 1500)}`);
  }
  return lines.join("\n\n");
}

async function callOpenRouter(userPrompt: string): Promise<{
  summary: string;
  suggested_action: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": appBaseUrl(),
      "X-Title": `Axel Dashboard - Dead Letter Explain (${PROMPT_VERSION})`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 600,
      response_format: { type: "json_object" },
      // Zero data retention: only route to providers that don't train on / store
      // the prompt (dead-letter payloads can carry residual PII even post-redact).
      provider: { data_collection: "deny" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? "";
  return parseExplanation(text);
}

function parseExplanation(text: string): { summary: string; suggested_action: string } {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Model returned something that wasn't JSON — fall back to using
    // the whole string as the summary so the operator at least gets
    // useful prose.
    return { summary: cleaned.slice(0, 600), suggested_action: "" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { summary: cleaned.slice(0, 600), suggested_action: "" };
  }
  const obj = parsed as { summary?: unknown; suggested_action?: unknown };
  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    suggested_action: typeof obj.suggested_action === "string" ? obj.suggested_action : "",
  };
}

/**
 * Strip the PII patterns we'd never want to ship to a third-party LLM
 * even with a zero-data-retention contract. Recursive, bounded depth.
 * The patterns are intentionally over-eager: better to redact a real
 * value than to leak it once.
 */
function redactObvious(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-capped]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactObvious(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (i++ > 100) break;
      // Field-name redactions: anything that looks secret-shaped goes
      // straight to a placeholder regardless of contents.
      if (/(token|secret|password|api[_-]?key|authorization|bearer)/i.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactObvious(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  if (s.length === 0) return s;
  // Truncate FIRST, then redact — long values (>5000) were returned RAW
  // (unredacted), leaking PII to the LLM (audit). Cap, then run every pattern.
  const capped = s.length > 5000 ? s.slice(0, 5000) : s;
  return capped
    // emails
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    // phone numbers (loose)
    .replace(/\b\+?\d{1,3}[\s\-.]?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}\b/g, "[phone]")
    // 13-19 digit number sequences (cards, account numbers)
    .replace(/\b\d{13,19}\b/g, "[long-digits]")
    // Bearer tokens / sk_/whsec_/api keys
    .replace(/\b(?:sk|pk|whsec|rk|api)_[A-Za-z0-9_-]{16,}/g, "[api-key]")
    // URLs with credentials
    .replace(/(https?:\/\/)([^\s/:@]+:[^\s/@]+)@/gi, "$1[creds]@");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}
