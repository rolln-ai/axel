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
 *   - A shared structured redactor removes secret-bearing fields and common
 *     credential formats before prompt construction. The final prompt passes
 *     through the text redactor again at the OpenRouter boundary.
 *   - Cached output is plain text → safe to render unescaped through
 *     a styled container.
 */

import type { ActionState as ActionStateBase } from "./action-state";
import {
  redactAiPrompt,
  redactSecretLikeText,
  redactWebhookDataForAi,
} from "@axel/shared";
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
const PROMPT_VERSION = "axe-54:v2";

const SYSTEM_PROMPT = `You are helping an Axel operator understand why a webhook delivery failed.

Inputs you'll receive:
- The event payload (truncated, with secret-like values and common PII redacted).
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
    payload,
    destination,
    route,
  });

  let summary: string;
  let suggestedAction: string;
  try {
    const result = await callDeadLetterOpenRouter(userPrompt);
    summary = result.summary;
    suggestedAction = result.suggested_action;
  } catch (err: unknown) {
    const message = redactSecretLikeText(err instanceof Error ? err.message : String(err));
    return {
      error: `Couldn't reach the AI service: ${message}`,
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
  lines.push(`Failure reason (Axel-side): ${redactSecretLikeText(p.reason)}`);
  if (p.message) {
    lines.push(`Failure message: ${truncate(redactSecretLikeText(p.message), 800)}`);
  }
  if (p.destination) {
    lines.push(`Destination type: ${redactSecretLikeText(p.destination.type)}`);
    if (p.destination.name) {
      lines.push(`Destination name: ${redactSecretLikeText(p.destination.name)}`);
    }
  }
  if (p.route) {
    lines.push(
      `Route filter (DSL JSON): ${redactSecretLikeText(p.route.filter_expression ?? "(none)")}`,
    );
    lines.push(
      `Route transform (DSL JSON): ${redactSecretLikeText(p.route.transform_script ?? "(none — passthrough)")}`,
    );
  }
  if (p.payload !== null) {
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(redactWebhookDataForAi(p.payload));
    } catch {
      payloadJson = "[unavailable]";
    }
    lines.push(`Event payload (PII redacted, truncated):\n${truncate(payloadJson, 1500)}`);
  }
  return redactAiPrompt(lines.join("\n\n"));
}

async function callDeadLetterOpenRouter(userPrompt: string): Promise<{
  summary: string;
  suggested_action: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    redirect: "manual",
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
        { role: "user", content: redactAiPrompt(userPrompt) },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${redactSecretLikeText(body).slice(0, 200)}`);
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}
