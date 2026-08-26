"use server";

// First-run / wizard server actions: create source + pipeline, connect first destination.

import { db, withTransaction } from "./db";
import { prefixedId } from "./ids";
import { bustWorkspaceTags } from "./repositories";
import {
  PIPELINE_BINDING_REQUIRED,
  pipelineBindingForNewDestination,
  prepareBigQueryBindingForCreate,
  parseBindingFromForm,
} from "./pipeline-binding";
import { requireSession } from "./session";
import { DEFAULT_SOURCE_LIMITS, generateSourceToken } from "./source-tokens";
import { pushSourceToEdge, loadSourceForEdge, rowToEdgePayload } from "./edge-invalidation";
import { createDestinationWithCredential } from "./destinations";
import { preflightPipelineDestination } from "./test-destination";
import { CREATABLE_DESTINATION_SCHEMAS, type DestinationType } from "./destination-defaults";
import { generateWebhookSecret } from "./webhook-secret";
import { defaultPipelineName, entityNameError, isUniqueViolation } from "./entity-name";
import {
  deriveDestinationNameBase,
  firstRunDestination,
  parseDestinationUrl,
  uniqueDestinationName,
  validateDestinationTarget,
} from "./first-run-destinations";
import {
  resolveIngestBaseUrl,
  type SourceProvider,
  withMongoTlsNoVerify,
  withNoVerifySslMode,
} from "@axel/shared";
import {
  countBackfillOutcomes,
  createBackfillJob,
  getBackfillJobById,
  previewBackfillCount,
  type BackfillJobSummary,
} from "./backfill-jobs";
import { withWorkspaceMutation } from "./with-mutation";
import { encryptSourceSigningSecret } from "./source-secret";
import { formValue } from "./form";
import { validateDestinationValues } from "./destination-validation";
import type { ActionState } from "./action-data";

function labelForProvider(p: SourceProvider): string {
  switch (p) {
    case "stripe": return "Stripe";
    case "github": return "GitHub";
    case "shopify": return "Shopify";
    case "chargebee": return "Chargebee";
    case "custom": return "Custom HMAC";
  }
}

/* ------------------------------------------------------------------------ *
 * createSourceWithPipeline                                                 *
 *                                                                          *
 * Wizard-backed action that creates a source AND, optionally, a            *
 * destination (existing or new) AND a route in a single Postgres           *
 * transaction. If any step fails, the whole pipeline rolls back — no       *
 * orphaned source without its intended destination, etc.                   *
 * ------------------------------------------------------------------------ */

interface PipelineResult {
  sourceId: string;
  destinationId: string | null;
  routeId: string | null;
  plaintextToken: string | null;
}

export async function createSourceWithPipeline(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    let ingestBase: string;
    try {
      ingestBase = resolveIngestBaseUrl(process.env);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "The ingest endpoint is not configured.",
      };
    }

    // --- source params ---
    // Pull-source creation (chargebee/stripe/shopify/postgres/mongodb/bigquery)
    // is retired: every UI entry point hard-codes source_kind=webhook, and the
    // owner decision is that webhook-only creation stays. Existing pull-source
    // ROWS keep syncing (pull-sync.ts / triggerPullSourceSync are untouched).
    const sourceKind = formValue(formData, "source_kind");
    if (sourceKind !== "webhook") {
      return { error: "Unknown source kind." };
    }
    const sourceName = formValue(formData, "source_name");
    if (!sourceName) return { error: "Source name is required." };
    const sourceNameErr = entityNameError(sourceName);
    if (sourceNameErr) return { error: `Source name — ${sourceNameErr}` };

    // Pipeline name — only used when this submit actually creates a route (i.e.
    // not the "Just create source" skip path, handled by the destinationMode gate
    // below). Blank defaults to "<source>-pipeline" so a first-run user never has
    // to invent one. Validated up front so the error surfaces before any writes.
    let pipelineName = formValue(formData, "pipeline_name").trim();

    // The submit button on step 1 ("Just create source") sets action_intent=skip
    // via its own name/value pair; this is more robust than syncing client
    // state into a hidden input right before submit, where the React state
    // update may not be flushed to the DOM in time.
    const actionIntent = formValue(formData, "action_intent");
    const destinationMode: "skip" | "existing" | "new" =
      actionIntent === "skip"
        ? "skip"
        : (formValue(formData, "destination_mode") as "skip" | "existing" | "new");
    const existingDestinationId = formValue(formData, "existing_destination_id");
    const newDestinationType = formValue(formData, "new_destination_type");
    const newDestinationName = formValue(formData, "new_destination_name");

    // A route (pipeline) is only created when a destination is attached; the
    // "Just create source" skip path needs no name. Blank falls back to a name
    // derived from the (already-validated) source name.
    if (destinationMode !== "skip") {
      if (!pipelineName) pipelineName = defaultPipelineName(sourceName);
      const pipelineNameErr = entityNameError(pipelineName);
      if (pipelineNameErr) return { error: `Pipeline name — ${pipelineNameErr}` };
    }

    if (destinationMode === "existing" && !existingDestinationId) {
      return { error: "Pick an existing destination or switch to 'New'." };
    }
    if (destinationMode === "new") {
      if (!newDestinationName) return { error: "Destination name is required." };
      if (!newDestinationType) return { error: "Destination type is required." };
    }

    // --- webhook source params validated up front ---
    const webhookToken = generateSourceToken();
    const webhookLimits = {
      maxBodyBytes: DEFAULT_SOURCE_LIMITS.maxBodyBytes,
      maxBodyDepth: DEFAULT_SOURCE_LIMITS.maxBodyDepth,
      maxEventsPerMinute: DEFAULT_SOURCE_LIMITS.maxEventsPerMinute,
    };
    // AXE-23: optional per-provider signature verification on the
    // inbound webhook surface. Validate up-front so the operator gets
    // a clean error instead of a 500 from the DB CHECK.
    const rawProvider = formValue(formData, "inbound_provider") || "custom";
    if (rawProvider !== "custom" && rawProvider !== "stripe" && rawProvider !== "github" && rawProvider !== "shopify" && rawProvider !== "chargebee") {
      return { error: `Unknown inbound provider "${rawProvider}".` };
    }
    const inboundProvider: SourceProvider = rawProvider as SourceProvider;
    let inboundSigningSecret: string | null = null;
    const rawSecret = formValue(formData, "inbound_signing_secret");
    if (inboundProvider !== "custom" && (!rawSecret || rawSecret.length === 0)) {
      return { error: `${labelForProvider(inboundProvider)} requires a signing secret.` };
    }
    if (rawSecret && rawSecret.length > 0) {
      if (rawSecret.length > 1024) return { error: "Signing secret is too long." };
      inboundSigningSecret = rawSecret;
    }

    // --- destination fields collected by walking the schema, when 'new' ---
    // Values are kept RAW (untrimmed) so validateDestinationValues can detect
    // leading/trailing whitespace, which is almost always a paste error. The
    // downstream `splitFieldsByKind` does the trim before persistence.
    let destinationFieldValues: Record<string, string> = {};
    let destinationSchemaType: DestinationType | null = null;
    let generatedWebhookSecret: string | undefined;
    if (destinationMode === "new") {
      const matchedSchema = CREATABLE_DESTINATION_SCHEMAS.find((s) => s.type === newDestinationType);
      if (!matchedSchema) return { error: "Pick a supported destination type." };
      destinationSchemaType = matchedSchema.type;
      for (const field of matchedSchema.fields) {
        const raw = formData.get(`dest_field_${field.key}`);
        const value = typeof raw === "string" ? raw : "";
        if (value.trim().length === 0) {
          if (field.required === false) continue;
          return { error: `Missing required field: ${field.label}.` };
        }
        destinationFieldValues[field.key] = value;
      }
      // HTTP auth: the selected auth mode must carry its credential. These
      // fields are schema-optional (conditionally shown in the wizard), so the
      // required-field loop above won't catch e.g. auth_type=bearer with no
      // token — which would create a destination that 401s on every delivery.
      // Enforce the pairing here too (defense in depth behind the client check).
      if (destinationSchemaType === "http") {
        const authType = (destinationFieldValues.auth_type ?? "none").trim();
        const present = (key: string) => (destinationFieldValues[key] ?? "").trim().length > 0;
        if (authType === "bearer" && !present("bearer_token")) {
          return { error: "Bearer token is required for Bearer auth." };
        }
        if (authType === "basic" && (!present("basic_user") || !present("basic_password"))) {
          return { error: "Basic auth requires both a username and a password." };
        }
        if (authType === "api_key" && (!present("api_key_header") || !present("api_key_value"))) {
          return { error: "API key auth requires both a header name and a key value." };
        }
        if (authType === "custom_headers" && !present("custom_headers")) {
          return { error: "Custom-header auth requires at least one header line (KEY: VALUE)." };
        }
      }
      // Mirror createDestination(): for the webhook destination type the
      // signing_secret field is optional in the schema (auto-generate). If the
      // user left it blank we need to mint one server-side so the destination
      // row actually has a credential — otherwise outbound HMAC signing fails.
      // A typed but whitespace-only value falls through to the secrets validator
      // below, which surfaces the whitespace as a clear error.
      if (
        destinationSchemaType === "webhook" &&
        (destinationFieldValues.signing_secret === undefined ||
          destinationFieldValues.signing_secret.length === 0)
      ) {
        generatedWebhookSecret = generateWebhookSecret();
        destinationFieldValues.signing_secret = generatedWebhookSecret;
      }
      // Whitespace + connection-string shape checks. Same helper the non-pipeline
      // createDestination action uses, so the two paths fail the same way.
      const secretsError = validateDestinationValues(destinationSchemaType, destinationFieldValues);
      if (secretsError) return { error: secretsError };

      // "Connect without certificate verification" toggle — mirror
      // createDestination(): bake the no-verify TLS option into the persisted
      // connection string so delivery inherits the posture confirmed at test time.
      if (
        destinationSchemaType === "postgres" &&
        formValue(formData, "dest_field_pg_ssl_no_verify") === "true" &&
        destinationFieldValues.connection_string
      ) {
        destinationFieldValues.connection_string = withNoVerifySslMode(
          destinationFieldValues.connection_string,
        );
      }
      if (
        destinationSchemaType === "mongodb" &&
        formValue(formData, "dest_field_mongo_tls_no_verify") === "true" &&
        destinationFieldValues.connection_string
      ) {
        destinationFieldValues.connection_string = withMongoTlsNoVerify(
          destinationFieldValues.connection_string,
        );
      }
    }

    // Pre-flight the NEW destination before writing anything — a pipeline that
    // can't write to its destination is worse than no pipeline (it silently
    // dead-letters every event). Blocks only on a PROVABLE failure (auth denied,
    // missing write permission, missing dataset); an unverifiable result (a
    // brand-new BigQuery table, a receiver that rejects HEAD, a transient blip)
    // is allowed through. Existing destinations were validated at their own
    // create time, so preflightPipelineDestination passes them.
    if (destinationMode === "new") {
      const preflight = await preflightPipelineDestination(formData);
      // Block only on a provable failure ("fail"); "warn"/"pass" go through.
      if (preflight.severity === "fail") {
        return { error: `Destination check failed — ${preflight.message} No pipeline was created.` };
      }
    }

    let result: PipelineResult;
    try {
      result = await withTransaction(async (client) => {
        // ---------- 0. WORKSPACE LIVENESS ----------
        // Lock the workspaces row inside the transaction so that a concurrent
        // admin suspend can't slip in between our pre-transaction
        // requireActiveWorkspace() check and the INSERTs below. Without this,
        // a brand-new source could land in a freshly-suspended workspace and
        // miss the suspend action's `UPDATE sources SET status='disabled'`.
        const wsStatus = await client.query<{ status: string }>(
          "SELECT COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
          [workspaceId],
        );
        const wsRow = wsStatus.rows[0];
        if (!wsRow) throw new Error("workspace_not_found");
        if (wsRow.status !== "active") throw new Error("workspace_not_active");

        // ---------- 1. SOURCE ----------
        const dupSource = await client.query(
          "SELECT 1 FROM sources WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1",
          [workspaceId, sourceName],
        );
        if (dupSource.rowCount) throw new Error("source_name_taken");

        // Webhook-only (pull-source creation is retired; see the sourceKind
        // gate above).
        const sourceId = prefixedId("src");
        const encryptedSecret = inboundSigningSecret
          ? await encryptSourceSigningSecret(inboundSigningSecret, workspaceId, sourceId)
          : null;
        await client.query(
          `INSERT INTO sources (id, workspace_id, name, secret_token_hash, status,
                                max_body_bytes, max_body_depth, max_events_per_minute,
                                provider, signing_secret_ciphertext, signing_secret_fingerprint)
           VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10)`,
          [
            sourceId,
            workspaceId,
            sourceName,
            webhookToken.hash,
            webhookLimits.maxBodyBytes,
            webhookLimits.maxBodyDepth,
            webhookLimits.maxEventsPerMinute,
            inboundProvider,
            encryptedSecret?.ciphertext ?? null,
            encryptedSecret?.fingerprint ?? null,
          ],
        );
        await audit({
          action: "source.created",
          targetType: "source",
          targetId: sourceId,
          metadata: {
            name: sourceName,
            via: "pipeline",
            provider: inboundProvider,
            has_signing_secret: inboundSigningSecret !== null,
          },
        }, client);
        const plaintextToken: string | null = webhookToken.plaintext;

        // ---------- 2. DESTINATION ----------
        let destinationId: string | null = null;
        let existingDestType: string | null = null;
        if (destinationMode === "existing") {
          const check = await client.query<{ type: string }>(
            `SELECT type
               FROM destinations
              WHERE id = $1 AND workspace_id = $2
              LIMIT 1`,
            [existingDestinationId, workspaceId],
          );
          if (!check.rowCount) throw new Error("destination_not_found");
          destinationId = existingDestinationId;
          existingDestType = check.rows[0]!.type;
        } else if (destinationMode === "new" && destinationSchemaType) {
          const dupDest = await client.query(
            "SELECT 1 FROM destinations WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1",
            [workspaceId, newDestinationName],
          );
          if (dupDest.rowCount) throw new Error("destination_name_taken");
          const out = await createDestinationWithCredential(
            {
              workspaceId,
              type: destinationSchemaType,
              name: newDestinationName,
              values: destinationFieldValues,
            },
            client,
          );
          destinationId = out.destinationId;
          // The existing destination helper doesn't audit-log; mirror what
          // createDestination() does so the pipeline path leaves the same trail.
          await audit({
            action: "destination.created",
            targetType: "destination",
            targetId: destinationId,
            metadata: { name: newDestinationName, type: destinationSchemaType, via: "pipeline" },
          }, client);
        }

        // ---------- 3. ROUTE (only if destination set) ----------
        // Pipeline-created routes are passthrough by design: the dialog
        // optimizes for "source connected to destination in one click".
        // Filter/transform get added later via the Routes tab, where the
        // structured builder produces a validated declarative DSL.
        let routeId: string | null = null;
        if (destinationId) {
          // Per-destination binding (which table/collection/volume to write to).
          // A NEW destination has no id client-side, so the modal sends the target
          // name in `new_destination_target`; an EXISTING one uses the
          // DestinationBindingPicker's `binding:<id>` blob. Without this a
          // table-shaped destination has nowhere to land events and every
          // delivery fails — the bug this fixes.
          const newDestTarget = formValue(formData, "new_destination_target");
          const existingBinding =
            destinationMode === "existing" ? parseBindingFromForm(formData, destinationId) : null;
          // Binding guard for BOTH modes — a postgres/mongodb/databricks destination
          // wired with no target binding dead-letters every event. The 'new' mode
          // was already guarded; an EXISTING binding-required destination selected
          // without a binding slipped through (audit).
          if (
            (destinationMode === "new" &&
              PIPELINE_BINDING_REQUIRED.has(newDestinationType) &&
              !newDestTarget) ||
            (destinationMode === "existing" &&
              existingDestType !== null &&
              PIPELINE_BINDING_REQUIRED.has(existingDestType as DestinationType) &&
              !existingBinding)
          ) {
            throw new Error("missing_binding");
          }
          let pipelineBinding =
            destinationMode === "new"
              ? pipelineBindingForNewDestination(newDestinationType, newDestTarget)
              : existingBinding;
          const pipelineDestinationType =
            destinationMode === "new" ? newDestinationType : existingDestType;
          if (pipelineBinding && pipelineDestinationType === "bigquery") {
            const prepared = prepareBigQueryBindingForCreate(pipelineBinding);
            if ("error" in prepared) throw new Error(prepared.error);
            pipelineBinding = prepared.binding;
          }

          routeId = prefixedId("rt");
          await client.query(
            `INSERT INTO routes (id, workspace_id, source_id, name, status, engine)
             VALUES ($1, $2, $3, $4, 'active', 'declarative')`,
            [routeId, workspaceId, sourceId, pipelineName],
          );
          await client.query(
            `INSERT INTO route_destinations (route_id, destination_id, binding)
             VALUES ($1, $2, $3)`,
            [routeId, destinationId, pipelineBinding ? JSON.stringify(pipelineBinding) : null],
          );
          await audit({
            action: "route.created",
            targetType: "route",
            targetId: routeId,
            metadata: {
              source_id: sourceId,
              destination_count: 1,
              has_filter: false,
              has_binding: Boolean(pipelineBinding),
              via: "pipeline",
            },
          }, client);
        }

        return { sourceId, destinationId, routeId, plaintextToken };
      });
    } catch (err) {
      if (isUniqueViolation(err, "sources")) return { error: "A source with that name already exists in this workspace." };
      if (isUniqueViolation(err, "destinations")) return { error: "A destination with that name already exists in this workspace." };
      const msg = err instanceof Error ? err.message : "";
      if (msg === "workspace_not_found") return { error: "Workspace no longer exists." };
      if (msg === "workspace_not_active") return { error: "This workspace is suspended. Contact support to restore it." };
      if (msg === "destination_not_found") return { error: "Selected destination is no longer in this workspace." };
      if (msg === "missing_binding") return { error: "Name the table or collection this route should write to before continuing." };
      if (msg === "invalid_bigquery_table") {
        return { error: "Use a BigQuery target in dataset.table format (letters, numbers, underscores; table names may also contain hyphens)." };
      }
      if (msg === "invalid_bigquery_dataset") {
        return { error: "Use a BigQuery dataset containing only letters, numbers, or underscores (up to 1,024 characters)." };
      }
      if (msg === "missing_bigquery_dataset") {
        return { error: "Choose a BigQuery target in dataset.table format." };
      }
      if (msg === "CREDENTIALS_MASTER_KEY is not set" || msg.startsWith("CREDENTIALS_MASTER_KEY")) {
        return { error: "Server is missing the credentials master key. Ask the operator to set CREDENTIALS_MASTER_KEY." };
      }
      if (msg.startsWith("Unsupported") || msg.startsWith("Missing required") || msg.startsWith("Invalid")) {
        return { error: msg };
      }
      // Generic fallback used to swallow the underlying error completely,
      // which made one class of failure (AXE-150 — Postgres pull-source
      // create) opaque to the operator and the test harness. Forward the
      // real error message instead — pg errors don't include credential
      // values, just constraint/relation names and column types.
      console.error("[createSourceWithPipeline] failed:", err);
      const detail = msg ? msg.slice(0, 500) : (err && typeof err === "object" && "code" in err ? `pg ${(err as { code?: string }).code}` : "unknown");
      return { error: `Could not create pipeline (${detail}). No partial records were saved.` };
    }

    // ---------- post-commit side effects ----------
    // Re-read the fresh source row in all cases so the edge KV mirrors
    // exactly what's in Postgres — including the (decrypted) signing
    // secret for AXE-23 provider verification.
    const fresh = await loadSourceForEdge(result.sourceId, workspaceId);
    if (fresh) await pushSourceToEdge(await rowToEdgePayload(fresh));

    bustWorkspaceTags(workspaceId);

    const parts = [`Source "${sourceName}" created`];
    if (result.destinationId) parts.push("destination attached");
    if (result.routeId) parts.push("route active");
    const tailNotes: string[] = [];
    if (result.plaintextToken) tailNotes.push("Copy the ingest token now — it won't be shown again.");
    if (generatedWebhookSecret) tailNotes.push("Copy the destination signing secret now — it won't be shown again.");

    return {
      notice: `${parts.join(", ")}.${tailNotes.length ? " " + tailNotes.join(" ") : ""}`,
      data: {
        sourceId: result.sourceId,
        ...(result.destinationId ? { destinationId: result.destinationId } : {}),
        ...(result.plaintextToken ? { plaintextToken: result.plaintextToken } : {}),
        ...(generatedWebhookSecret ? { webhookSigningSecret: generatedWebhookSecret } : {}),
        ingestUrl: `${ingestBase}/in/${result.sourceId}`,
      },
    };
  });
}

/* ------------------------------------------------------------------------ *
 * connectFirstDestination                                                  *
 *                                                                          *
 * First-run setup: wire an EXISTING source to a brand-new destination      *
 * through a passthrough route, from the shortened per-type form in         *
 * FIRST_RUN_DESTINATIONS (only the fields without which delivery can't     *
 * happen). Types outside that catalogue go to /destinations.               *
 *                                                                          *
 * Field names match the full wizard's (`dest_field_<key>`,                 *
 * `new_destination_target`), so the same pre-flight probe and binding      *
 * builder apply — a wrong connection string is caught here rather than     *
 * dead-lettering every event later.                                        *
 *                                                                          *
 * Destination + route are created in one transaction, so a failure can't   *
 * strand a destination with no route pointing at it.                       *
 * ------------------------------------------------------------------------ */
export async function connectFirstDestination(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, audit }) => {

    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source." };

    const destinationType = formValue(formData, "new_destination_type");
    const catalogEntry = firstRunDestination(destinationType);
    if (!catalogEntry) {
      return { error: "Pick a destination type." };
    }

    // Collect the shortened field set. Everything here is required — the
    // catalogue only lists fields delivery can't happen without.
    const values: Record<string, string> = {};
    for (const field of catalogEntry.fields) {
      const raw = formValue(formData, `dest_field_${field.key}`);
      if (!raw.trim()) return { error: `${field.label} is required.` };
      values[field.key] = raw;
    }

    // A signed webhook needs a URL we can actually POST to; check the shape
    // before the probe so the message names the real problem.
    if (catalogEntry.type === "webhook") {
      const urlResult = parseDestinationUrl(values.url ?? "");
      if ("error" in urlResult) return { error: urlResult.error };
    }

    // "Self-signed certificate" toggle — bake the relaxed verification into the
    // stored connection string, exactly as the full wizard does, so delivery
    // inherits the posture that was confirmed at test time. Without it a managed
    // Postgres (Railway, Heroku) fails every delivery with "self-signed
    // certificate in certificate chain".
    const tlsNoVerify =
      Boolean(catalogEntry.tlsToggle) &&
      formValue(formData, `dest_field_${catalogEntry.tlsToggle!.key}`) === "true";
    if (tlsNoVerify && values.connection_string) {
      values.connection_string =
        catalogEntry.type === "mongodb"
          ? withMongoTlsNoVerify(values.connection_string)
          : withNoVerifySslMode(values.connection_string);
    }

    const target = formValue(formData, "new_destination_target").trim();
    if (catalogEntry.target) {
      // Reject a target the delivery path can't quote. Without this the pipeline
      // saves cleanly and then dead-letters every event forever.
      const targetError = validateDestinationTarget(catalogEntry.type, target);
      if (targetError) return { error: targetError };
    }

    const sourceRow = await db().query<{ name: string; created_at: string }>(
      `SELECT name, created_at::text AS created_at
         FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [sourceId, workspaceId],
    );
    if (!sourceRow.rowCount) return { error: "Source not found in this workspace." };
    const sourceName = sourceRow.rows[0]!.name;
    const sourceCreatedAt = sourceRow.rows[0]!.created_at;

    // Auto-generate the signing secret when the type mints one (webhook), so the
    // user is never asked for a value we can produce.
    let generatedSecret: string | undefined;
    if (catalogEntry.type === "webhook") {
      generatedSecret = generateWebhookSecret();
      values.signing_secret = generatedSecret;
    }

    const secretsError = validateDestinationValues(
      catalogEntry.type as DestinationType,
      values,
    );
    if (secretsError) return { error: secretsError };

    // Same probe the full wizard runs: block only on a PROVABLE failure (auth
    // denied, missing permission), let unverifiable results through.
    const preflightForm = new FormData();
    preflightForm.set("destination_mode", "new");
    preflightForm.set("new_destination_type", catalogEntry.type);
    for (const [key, value] of Object.entries(values)) {
      preflightForm.set(`dest_field_${key}`, value);
    }
    if (target) preflightForm.set("new_destination_target", target);
    // The probe reads this flag directly as well as via the connection string,
    // so it tests the same TLS posture delivery will use.
    if (tlsNoVerify && catalogEntry.tlsToggle) {
      preflightForm.set(`dest_field_${catalogEntry.tlsToggle.key}`, "true");
    }
    const preflight = await preflightPipelineDestination(preflightForm);
    if (preflight.severity === "fail") {
      return { error: `Couldn't connect — ${preflight.message} Nothing was saved.` };
    }

    const taken = await db().query<{ name: string }>(
      `SELECT lower(name) AS name FROM destinations WHERE workspace_id = $1`,
      [workspaceId],
    );
    const destinationName = uniqueDestinationName(
      deriveDestinationNameBase(catalogEntry.type, values),
      new Set(taken.rows.map((r) => r.name)),
    );

    // Where each event is written (table / collection / dataset.table). Built by
    // the same helper the full wizard uses so the blob shape can't drift.
    let binding: Record<string, unknown> | null = null;
    if (catalogEntry.target) {
      binding = pipelineBindingForNewDestination(catalogEntry.type, target);
      if (binding && catalogEntry.type === "bigquery") {
        const prepared = prepareBigQueryBindingForCreate(binding);
        if ("error" in prepared) {
          return {
            error:
              prepared.error === "invalid_bigquery_dataset"
                ? "Use a BigQuery dataset of letters, numbers, or underscores."
                : "Use a BigQuery target in dataset.table format, e.g. analytics.events.",
          };
        }
        binding = prepared.binding;
      }
      if (!binding) {
        return { error: `${catalogEntry.target.label} isn't valid — ${catalogEntry.target.placeholder} is the expected shape.` };
      }
    }

    const routeName = defaultPipelineName(sourceName);

    let destinationId: string;
    let routeId: string;
    try {
      const out = await withTransaction(async (client) => {
        const created = await createDestinationWithCredential(
          {
            workspaceId,
            type: catalogEntry.type as DestinationType,
            name: destinationName,
            values,
          },
          client,
        );
        await audit({
          action: "destination.created",
          targetType: "destination",
          targetId: created.destinationId,
          metadata: {
            name: destinationName,
            type: catalogEntry.type,
            via: "first_run_setup",
          },
        }, client);

        const newRouteId = prefixedId("rt");
        await client.query(
          `INSERT INTO routes (id, workspace_id, source_id, name, status, engine)
           VALUES ($1, $2, $3, $4, 'active', 'declarative')`,
          [newRouteId, workspaceId, sourceId, routeName],
        );
        await client.query(
          `INSERT INTO route_destinations (route_id, destination_id, binding)
           VALUES ($1, $2, $3)`,
          [newRouteId, created.destinationId, binding ? JSON.stringify(binding) : null],
        );
        await audit({
          action: "route.created",
          targetType: "route",
          targetId: newRouteId,
          metadata: {
            source_id: sourceId,
            destination_count: 1,
            has_filter: false,
            has_binding: Boolean(binding),
            via: "first_run_setup",
          },
        }, client);
        return { destinationId: created.destinationId, routeId: newRouteId };
      });
      destinationId = out.destinationId;
      routeId = out.routeId;
    } catch (err) {
      if (isUniqueViolation(err, "destinations")) {
        return { error: "A destination with that name already exists — rename it on the Destinations page." };
      }
      const msg = err instanceof Error ? err.message : "";
      console.error("[connectFirstDestination] failed:", err);
      return { error: `Couldn't connect the destination${msg ? ` (${msg.slice(0, 200)})` : ""}. Nothing was saved.` };
    }

    bustWorkspaceTags(workspaceId);

    // Events that arrived between creating the source and connecting this
    // destination were ingested and stored, but had no route to deliver through.
    // Queue a backfill over exactly that window so the user's existing traffic
    // lands in their table rather than being stranded.
    //
    // Best-effort: the destination and route are already committed, so a backfill
    // failure must not turn a successful connect into an error. It also skips
    // test events — the worker filters is_test — so a user who only clicked
    // "Send test event" correctly gets nothing here.
    let backfillJobId: string | undefined;
    let backfillEstimated = 0;
    try {
      const since = new Date(sourceCreatedAt);
      const until = new Date();
      if (!Number.isNaN(since.getTime()) && until.getTime() > since.getTime()) {
        backfillEstimated = await previewBackfillCount(workspaceId, sourceId, since, until);
        if (backfillEstimated > 0) {
          const job = await createBackfillJob({
            workspaceId,
            routeId,
            sourceId,
            since,
            until,
            requestedByUserId: actorUserId,
          });
          backfillJobId = job.id;
        }
      }
    } catch (err) {
      console.error("[connectFirstDestination] backfill queue failed:", err);
    }

    const landing = target || destinationName;
    return {
      notice: `Connected — events from "${sourceName}" now deliver to ${landing}.`,
      data: {
        destinationId,
        routeId,
        ...(backfillJobId ? { backfillJobId } : {}),
        ...(backfillEstimated > 0 ? { backfillEstimated } : {}),
        ...(generatedSecret ? { webhookSigningSecret: generatedSecret } : {}),
      },
    };
  });
}

/**
 * Poll one first-run backfill job. Returns the terminal-ness plus what the job
 * actually moved, so setup can report "synced N events" rather than guessing.
 */
export async function getFirstRunBackfillStatus(jobId: string): Promise<
  | {
      state: BackfillJobSummary["state"];
      settled: boolean;
      enqueued: number;
      delivered: number;
      /** Replays that hit a terminal failure — a wrong table, an unreachable
       *  database. Without this the panel spins forever on a dead pipeline. */
      failed: number;
      totalEstimated: number | null;
      errorMessage: string | null;
    }
  | { error: string }
> {
  return withWorkspaceMutation({ role: "any" }, async ({ workspaceId }) => {
    if (typeof jobId !== "string" || !jobId) return { error: "Missing backfill job id." };

    try {
      const job = await getBackfillJobById(workspaceId, jobId);
      if (!job) return { error: "Backfill job not found." };
      const { delivered, failed, failureMessage } = await countBackfillOutcomes(jobId);
      return {
        state: job.state,
        // 'done' only means the job finished ENQUEUEING. Deliveries drain
        // afterwards, so the UI keeps counting until they catch up.
        settled: job.state === "done" || job.state === "failed" || job.state === "cancelled",
        enqueued: job.enqueued,
        delivered,
        failed,
        totalEstimated: job.total_estimated,
        errorMessage: job.error_message ?? failureMessage,
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Couldn't read backfill status.",
      };
    }
  });
}

/**
 * Read-only helper for the new-source wizard's destination picker. The page
 * passes destinations as a prop at render time, but if the user creates one
 * in another tab and then opens the wizard, that prop is stale. The wizard
 * calls this on dialog-open to refresh the list without a full page reload.
 *
 * Returns the same shape the page builds: id + display name + type, active
 * only. Stays inside the workspace just like every other workspace-scoped
 * repository call.
 */
export async function listActiveDestinationsForPicker(): Promise<
  Array<{ id: string; name: string; type: string }>
> {
  const session = await requireSession();
  if (session.activeWorkspace.workspace_status !== "active") return [];
  const result = await db().query<{ id: string; name: string | null; type: string }>(
    `SELECT id, name, type
       FROM destinations
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 200`,
    [session.activeWorkspace.workspace_id],
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name ?? "(unnamed)",
    type: r.type,
  }));
}
