import "server-only";
import {
  redactAiPrompt,
  redactSecretLikeText,
  redactWebhookDataForAi,
} from "@axel/shared";
import {
  buildFixturesFromSamples,
  canActivate,
  generateRouteArtifacts,
  runFixtures,
  runTransform,
  type FixtureRunResult,
  type GeneratedFilter,
  type GeneratedTransform,
  type SyntheticFixture,
} from "./codegen";
import type { InferredDataContract } from "./inference";
import {
  appendDataContractVersion,
  insertDataContractFixture,
  resyncRouteToArtifacts,
  type DataContractVersionRow,
  type RouteResyncResult,
} from "./repository";
import type { SampledEvent } from "./sampler";
import { appBaseUrl } from "../app-url";
import { withTransaction } from "../db";
import { enqueueReplays } from "../replay-enqueue";
import type pg from "pg";

/**
 * Shape stored as `data_contract_versions.destination_mapping` is opaque to
 * this module — we only need the kind + the existing transform to ask the
 * model for a patch.
 */
export interface FailureContext {
  data_contract_id: string;
  data_contract_version_id: string;
  inferred_schema: InferredDataContract;
  current_transform: GeneratedTransform;
  current_filter: GeneratedFilter | null;
  /** Most recent failed deliveries we want the model to explain. */
  failed_events: SampledEvent[];
  /** Destination response: status, redacted body, headers. */
  response: {
    status: number;
    body_excerpt: string;
    headers?: Record<string, string>;
  };
  /** Free-text error message from the connector if any. */
  connector_message?: string | null;
}

export type PatchKind = "transform" | "filter" | "none";

export interface ProposedPatch {
  likely_cause: string;
  patch_kind: PatchKind;
  /** Replacement transform (when patch_kind='transform'). */
  patched_transform?: GeneratedTransform;
  /** Replacement filter (when patch_kind='filter'). */
  patched_filter?: GeneratedFilter;
  /** Model self-rated 0..1. */
  confidence: number;
  /** Free-form explanation shown to the operator. */
  rationale: string;
}

export interface ExplainLlmRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

export interface ExplainLlmResponse {
  /** Raw structured response after parsing. */
  patch: ProposedPatch;
  ms: number;
}

export interface ExplainOptions {
  callLlm?: (req: ExplainLlmRequest) => Promise<ExplainLlmResponse>;
  apiKey?: string;
  model?: string;
}

const PROMPT_VERSION = "axe-49:v2";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `You are helping an Axel operator understand why an event delivery failed and propose a safe code patch.

Inputs:
- The Data Contract's inferred schema.
- The current declarative transform.
- A small set of failed event payloads with secret-like values redacted.
- The destination's response status + body excerpt.
- An optional connector error message.

Return ONLY a JSON object:
{
  "likely_cause": "<short, one-sentence>",
  "patch_kind": "transform" | "filter" | "none",
  "patched_transform": <DSL object> | null,
  "patched_filter": <DSL object> | null,
  "confidence": <number 0..1>,
  "rationale": "<2-4 sentences>"
}

Rules:
- The DSL is the same one in the input — kinds: passthrough, select, envelope, jsonb_blob (transforms); always, event_type_in, and (filters).
- Don't invent kinds, paths, or values that aren't in the input.
- Prefer 'none' if you can't be 80%+ sure.
- Never embed code, eval, expressions, or template strings.
- No markdown, no fences. JSON only.`;

export async function explainFailure(
  context: FailureContext,
  options: ExplainOptions = {},
): Promise<ProposedPatch & { ms: number | null; model: string | null; prompt_version: string }> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const caller = options.callLlm ?? (apiKey ? defaultLlmCaller(apiKey) : null);
  if (!caller) {
    return {
      likely_cause: "LLM unavailable (no OPENROUTER_API_KEY).",
      patch_kind: "none",
      confidence: 0,
      rationale:
        "The model wasn't called because the dashboard's OPENROUTER_API_KEY is not configured. Configure it to enable failure explanations.",
      ms: null,
      model: null,
      prompt_version: PROMPT_VERSION,
    };
  }

  const userPrompt = buildUserPrompt(context);
  try {
    const resp = await caller({ systemPrompt: SYSTEM_PROMPT, userPrompt, model });
    return {
      ...resp.patch,
      ms: resp.ms,
      model,
      prompt_version: PROMPT_VERSION,
    };
  } catch (err) {
    const message = redactSecretLikeText(err instanceof Error ? err.message : String(err));
    return {
      likely_cause: "LLM call failed.",
      patch_kind: "none",
      confidence: 0,
      rationale: `${message}. The patched transform can be edited and approved manually instead.`,
      ms: null,
      model,
      prompt_version: PROMPT_VERSION,
    };
  }
}

function buildUserPrompt(c: FailureContext): string {
  const sample = c.failed_events
    .slice(0, 3)
    .map((e) => truncateJson(redactWebhookDataForAi(e.payload), 1200))
    .join("\n---\n");
  const eventTypes = c.inferred_schema.event_types.slice(0, 5).map((eventType) => ({
    name: redactSecretLikeText(eventType.name),
    sample_count: eventType.sample_count,
  }));
  const userPrompt = [
    "Inferred schema (truncated):",
    JSON.stringify(
      {
        event_types: eventTypes,
        fields: Object.keys(c.inferred_schema.fields)
          .slice(0, 40)
          .map(redactSecretLikeText),
      },
      null,
      2,
    ),
    "",
    "Current transform:",
    JSON.stringify(c.current_transform, null, 2),
    "",
    "Current filter:",
    c.current_filter ? JSON.stringify(c.current_filter, null, 2) : "(none)",
    "",
    "Failed events (redacted):",
    sample,
    "",
    "Destination response:",
    `status=${c.response.status}\n${redactSecretLikeText(c.response.body_excerpt).slice(0, 600)}`,
    c.connector_message
      ? `\nConnector error: ${redactSecretLikeText(c.connector_message)}`
      : "",
  ].join("\n");
  return redactAiPrompt(userPrompt);
}

function truncateJson(value: unknown, maxLen: number): string {
  const text = JSON.stringify(value) ?? "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…[truncated]`;
}

function defaultLlmCaller(
  apiKey: string,
): (req: ExplainLlmRequest) => Promise<ExplainLlmResponse> {
  return async (req) => {
    const start = Date.now();
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": appBaseUrl(),
        "X-Title": "Axel Dashboard - Failure Explain",
      },
      body: JSON.stringify({
        model: req.model,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        // Payload excerpts can contain residual customer data after masking.
        // Restrict routing to providers that deny storage/training.
        provider: { data_collection: "deny" },
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: redactAiPrompt(req.userPrompt) },
        ],
      }),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${redactSecretLikeText(body).slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return { patch: parsePatchResponse(text), ms };
  };
}

export function parsePatchResponse(text: string): ProposedPatch {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      likely_cause: "Model returned malformed JSON.",
      patch_kind: "none",
      confidence: 0,
      rationale: "Re-run the explanation, or write the patch manually.",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      likely_cause: "Model returned non-object response.",
      patch_kind: "none",
      confidence: 0,
      rationale: "Re-run the explanation, or write the patch manually.",
    };
  }
  const o = parsed as Record<string, unknown>;
  const patch_kind: PatchKind =
    o.patch_kind === "transform" || o.patch_kind === "filter"
      ? o.patch_kind
      : "none";
  return {
    likely_cause: typeof o.likely_cause === "string" ? o.likely_cause : "Unknown cause.",
    patch_kind,
    patched_transform:
      patch_kind === "transform" && o.patched_transform && typeof o.patched_transform === "object"
        ? (o.patched_transform as GeneratedTransform)
        : undefined,
    patched_filter:
      patch_kind === "filter" && o.patched_filter && typeof o.patched_filter === "object"
        ? (o.patched_filter as GeneratedFilter)
        : undefined,
    confidence:
      typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1
        ? o.confidence
        : 0,
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}

// ---------------------------------------------------------------------------
// Patch preview
// ---------------------------------------------------------------------------

export interface PatchPreview {
  per_event: Array<{ event_id: string; before: unknown; after: unknown }>;
  fixture_result: FixtureRunResult;
  can_activate: boolean;
}

/**
 * Run the proposed patch against the failed events + existing fixtures.
 * Returns per-event before/after diffs and the fixture pass/fail summary
 * that gates activation.
 */
export function previewPatch(
  patch: ProposedPatch,
  context: FailureContext,
  fixtures: SyntheticFixture[],
): PatchPreview {
  const transform = patch.patched_transform ?? context.current_transform;
  const per_event = context.failed_events.slice(0, 5).map((e) => ({
    event_id: e.event_id,
    before: runTransform(e.payload, context.current_transform),
    after: runTransform(e.payload, transform),
  }));
  const fixture_result = runFixtures(fixtures, transform);
  return { per_event, fixture_result, can_activate: canActivate(fixture_result) };
}

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

export interface ApprovalInput {
  workspaceId: string;
  userId: string;
  dataContractId: string;
  /** The model-proposed or operator-edited patch. */
  patch: ProposedPatch;
  /** Carried forward from the previous version. */
  currentVersion: DataContractVersionRow;
  /**
   * Untrusted replay selectors supplied by the browser. approvePatch resolves
   * every field back to an unresolved dead_letters row owned by workspaceId
   * before using any value for route mutation or replay enqueue.
   */
  failedDeliveries: Array<{
    event_id: string;
    source_id: string;
    route_id: string;
    r2_key: string;
  }>;
  /** Fresh samples for re-running fixtures + computing expected outputs. */
  samples: SampledEvent[];
}

export interface ApprovalResult {
  new_version_id: string;
  fixture_result: FixtureRunResult;
  replays_queued: number;
  /** Per-route outcome of pushing the patched transform/filter back into the
   *  live route(s). Empty when there were no replay-target routes. Optional so
   *  older callers that hand-build an ApprovalResult (e.g. test doubles) stay
   *  source-compatible; the real approvePatch always populates it. */
  routes_resynced?: RouteResyncResult[];
}

export interface ApprovalDeps {
  /** Inject for tests; production uses the real DB pool. */
  withTx?: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  versionAppender?: typeof appendDataContractVersion;
  fixtureInserter?: typeof insertDataContractFixture;
  routeResyncer?: typeof resyncRouteToArtifacts;
}

interface ResolvedApprovalReplayTarget {
  event_id: string;
  source_id: string;
  route_id: string;
  r2_key: string;
}

const MAX_APPROVAL_REPLAY_TARGETS = 100;

export class InvalidApprovalReplayTargetsError extends Error {
  constructor() {
    super(
      "One or more failed deliveries are unavailable or do not belong to this Data Contract. Refresh and try again.",
    );
    this.name = "InvalidApprovalReplayTargetsError";
  }
}

/**
 * Approval is atomic:
 *   1. Append a new data_contract_version with the patched transform/filter.
 *   2. Regenerate fixtures from samples and insert them.
 *   3. Run the fixture gate; abort the whole transaction if any fail.
 *   4. Re-materialize the patched transform/filter into the live route(s)
 *      the replay will run through (resyncRouteToArtifacts), so the route
 *      executes the corrected transform instead of the old one — otherwise
 *      the replay re-fails identically.
 *   5. Queue one replay_request per failed delivery.
 *
 * Steps 1-5 share one transaction, so version-append + route-resync +
 * replay-queue commit or roll back together.
 *
 * If the fixture gate fails we throw `FixturesFailedError` AFTER the
 * transaction has rolled back — the caller surfaces it as a user-visible
 * error and no version, fixtures, route changes, or replays are persisted.
 *
 * Route binding: the live route(s) are taken from `failedDeliveries[].route_id`
 * (scoped to the workspace). Those are *exactly* the routes the queued replays
 * re-execute against, so resyncing them is both necessary (else the replay
 * re-fails) and definitely-correct — we never guess at sibling routes from the
 * implicit (workspace, source, destination) codegen binding, which could match
 * routes the operator built by hand. A route whose pipeline_graph was edited
 * away from the codegen shape is skipped (recorded in `routes_resynced`) so a
 * patch never clobbers a bespoke pipeline.
 */
export class FixturesFailedError extends Error {
  constructor(public readonly result: FixtureRunResult) {
    super(
      `Activation gate refused: ${result.failed}/${result.total} fixtures failed.`,
    );
    this.name = "FixturesFailedError";
  }
}

export async function approvePatch(
  input: ApprovalInput,
  deps: ApprovalDeps = {},
): Promise<ApprovalResult> {
  const tx = deps.withTx ?? withTransaction;
  const versionAppender = deps.versionAppender ?? appendDataContractVersion;
  const fixtureInserter = deps.fixtureInserter ?? insertDataContractFixture;
  const routeResyncer = deps.routeResyncer ?? resyncRouteToArtifacts;

  return tx(async (client) => {
    // Serialize concurrent approvals of the SAME Data Contract. Without this a
    // double-fire (rapid double-click, or an auto-refresh racing a manual
    // approve) could have two transactions read the same pre-patch version and
    // each append a duplicate version + replay. The xact lock releases on
    // commit/rollback, so the second caller proceeds against post-patch state.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.dataContractId,
    ]);

    const failedDeliveries = await resolveApprovalReplayTargets(input, client);

    const nextTransform =
      input.patch.patched_transform ??
      (input.currentVersion.generated_transform
        ? (JSON.parse(input.currentVersion.generated_transform) as GeneratedTransform)
        : { kind: "passthrough" as const });
    const nextFilter =
      input.patch.patched_filter ??
      (input.currentVersion.generated_filter
        ? (JSON.parse(input.currentVersion.generated_filter) as GeneratedFilter)
        : { kind: "always" as const });

    const inferred = input.currentVersion.inferred_schema as InferredDataContract;

    const newVersion = await versionAppender(
      {
        dataContractId: input.dataContractId,
        workspaceId: input.workspaceId,
        inferredSchema: inferred,
        fieldAnnotations: input.currentVersion.field_annotations,
        generatedFilter: JSON.stringify(nextFilter),
        generatedTransform: JSON.stringify(nextTransform),
        transformLanguage: "jsonata",
        destinationMapping: input.currentVersion.destination_mapping,
        modelMetadata: {
          ...(input.currentVersion.model_metadata as Record<string, unknown>),
          patched_at: new Date().toISOString(),
          patched_by_user_id: input.userId,
          patch_confidence: input.patch.confidence,
          patch_likely_cause: input.patch.likely_cause,
        },
        createdByUserId: input.userId,
      },
      client,
    );

    // Build fixtures from fresh samples + run them against the new transform.
    const fixtures = buildFixturesFromSamples(input.samples, inferred, nextTransform);
    for (const fixture of fixtures) {
      await fixtureInserter(
        {
          dataContractVersionId: newVersion.id,
          workspaceId: input.workspaceId,
          sourceEventId: fixture.source_event_id,
          eventType: fixture.event_type,
          inputPayload: fixture.input_payload,
          expectedOutput: fixture.expected_output,
        },
        client,
      );
    }

    const result = runFixtures(fixtures, nextTransform);
    if (!canActivate(result)) {
      throw new FixturesFailedError(result);
    }

    // Re-materialize the patched filter + transform into the live route(s) the
    // replays will run through. Without this the route still executes the OLD
    // transform baked into its pipeline_graph/legacy columns and the replay
    // re-fails identically. We resync each DISTINCT route_id from the failed
    // deliveries. These identifiers came from the scoped dead-letter lookup
    // above, never from the browser tuple itself.
    const routes_resynced: RouteResyncResult[] = [];
    const seenRouteIds = new Set<string>();
    for (const dl of failedDeliveries) {
      if (seenRouteIds.has(dl.route_id)) continue;
      seenRouteIds.add(dl.route_id);
      routes_resynced.push(
        await routeResyncer(
          {
            routeId: dl.route_id,
            workspaceId: input.workspaceId,
            filter: nextFilter,
            transform: nextTransform,
          },
          client,
        ),
      );
    }

    // One set-based enqueue through the shared tail. This also gives the
    // patch-approval path the same in-flight dedupe guard as every other
    // replay entry point (a rapid double-approve used to queue duplicates).
    const enqueued = await enqueueReplays(client, {
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      reason: `data_contract_patch:${newVersion.id}`,
      candidates: {
        sql: `SELECT v.event_id, v.source_id, v.r2_key, 'route' AS scope, v.route_id,
                     NULL::text AS destination_id, NULL::text AS failure_reason, NULL::text AS fingerprint
                FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
                     AS v(event_id, source_id, r2_key, route_id)`,
        params: [
          failedDeliveries.map((dl) => dl.event_id),
          failedDeliveries.map((dl) => dl.source_id),
          failedDeliveries.map((dl) => dl.r2_key),
          failedDeliveries.map((dl) => dl.route_id),
        ],
      },
    });
    const replays = enqueued.queued;

    return {
      new_version_id: newVersion.id,
      fixture_result: result,
      replays_queued: replays,
      routes_resynced,
    };
  });
}

async function resolveApprovalReplayTargets(
  input: ApprovalInput,
  client: pg.PoolClient,
): Promise<ResolvedApprovalReplayTarget[]> {
  if (input.failedDeliveries.length === 0) return [];
  if (input.failedDeliveries.length > MAX_APPROVAL_REPLAY_TARGETS) {
    throw new InvalidApprovalReplayTargetsError();
  }

  const requested = input.failedDeliveries;
  const result = await client.query<ResolvedApprovalReplayTarget>(
    `WITH requested_replays AS (
       SELECT v.ordinality::int AS ordinal,
              v.event_id, v.source_id, v.route_id, v.r2_key
         FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[])
              WITH ORDINALITY AS v(event_id, source_id, route_id, r2_key, ordinality)
     )
     SELECT matched.event_id, matched.source_id, matched.route_id, matched.r2_key
       FROM requested_replays requested
       JOIN LATERAL (
         SELECT dl.event_id, dl.source_id, dl.route_id, dl.r2_key
           FROM dead_letters dl
           JOIN sources s
             ON s.id = dl.source_id
            AND s.workspace_id = $1
           JOIN routes r
             ON r.id = dl.route_id
            AND r.workspace_id = $1
            AND r.source_id = s.id
           JOIN data_contracts dc
             ON dc.id = $2
            AND dc.workspace_id = $1
            AND dc.source_id = s.id
            AND (dc.route_id IS NULL OR dc.route_id = r.id)
          WHERE dl.workspace_id = $1
            AND dl.resolved_at IS NULL
            AND dl.event_id = requested.event_id
            AND dl.source_id = requested.source_id
            AND dl.route_id = requested.route_id
            AND dl.r2_key = requested.r2_key
          ORDER BY dl.errored_at DESC, dl.id DESC
          LIMIT 1
          FOR SHARE OF dl
       ) matched ON TRUE
      ORDER BY requested.ordinal`,
    [
      input.workspaceId,
      input.dataContractId,
      requested.map((delivery) => delivery.event_id),
      requested.map((delivery) => delivery.source_id),
      requested.map((delivery) => delivery.route_id),
      requested.map((delivery) => delivery.r2_key),
    ],
  );

  // The lateral lookup yields exactly one durable row per requested ordinal.
  // A missing row means at least one selector was stale, altered, resolved, or
  // owned by another workspace/source/route. Reject before any patch write.
  if (result.rows.length !== requested.length) {
    throw new InvalidApprovalReplayTargetsError();
  }
  // A forged request can repeat one valid tuple many times. Keep the normal
  // one-row UI unchanged while preventing duplicate replay inserts from a
  // hand-crafted server-action payload.
  return [...new Map(result.rows.map((row) => [
    `${row.event_id}\0${row.source_id}\0${row.route_id}\0${row.r2_key}`,
    row,
  ])).values()];
}

// Re-export helpers callers want.
export { canActivate, generateRouteArtifacts };
export type { FixtureRunResult, GeneratedFilter, GeneratedTransform, SyntheticFixture };
