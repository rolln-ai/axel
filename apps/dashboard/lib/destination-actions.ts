"use server";

// Destination lifecycle server actions: create/update/delete, credentials, circuit breaker, delivery controls.

import { db } from "./db";
import { createDestinationWithCredential, rotateDestinationCredentialBlob } from "./destinations";
import {
  schemaFor,
  destinationSelectOptionsError,
  isDestinationFieldVisible,
  type DestinationType,
} from "./destination-defaults";
import { generateWebhookSecret } from "./webhook-secret";
import { entityNameError, isUniqueViolation } from "./entity-name";
import { withMongoTlsNoVerify, withNoVerifySslMode } from "@axel/shared";
import { withWorkspaceMutation } from "./with-mutation";
import { writeAudit } from "./audit";
import { formValue } from "./form";
import {
  isCreatableDestinationType,
  readDestinationValues,
  validateDestinationType,
  validateDestinationValues,
} from "./destination-validation";
import type { ActionState } from "./action-data";

// --- Destination lifecycle ------------------------------------------------ //

export async function createDestination(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const type = formValue(formData, "type");
    if (!isCreatableDestinationType(type)) return { error: "Pick a supported destination type." };

    const name = formValue(formData, "name");
    const values = readDestinationValues(formData, type);

    const validationError = validateDestinationValues(type, values);
    if (validationError) return { error: validationError };

    // AXE-33 — reject select values outside the schema's allow-list. The form's
    // dropdowns can't produce these, but a crafted POST could, and downstream
    // connectors treat unknown enum values as silent fallbacks (e.g. the webhook
    // signer runs SHA-256 for any algorithm string it doesn't recognize).
    const optionsError = destinationSelectOptionsError(type, values);
    if (optionsError) return { error: optionsError };

    // "Connect without certificate verification" toggle — bake the no-verify TLS
    // option into the stored connection string so delivery (which only ever sees
    // the persisted string) inherits the same posture the operator confirmed at
    // test time. Runs after validation so the shape checks see the original value.
    if (type === "postgres" && formValue(formData, "pg_ssl_no_verify") === "true" && values.connection_string) {
      values.connection_string = withNoVerifySslMode(values.connection_string);
    }
    if (type === "mongodb" && formValue(formData, "mongo_tls_no_verify") === "true" && values.connection_string) {
      values.connection_string = withMongoTlsNoVerify(values.connection_string);
    }

    // Webhook destinations: if the customer didn't paste their own signing
    // secret, generate one server-side and surface it to the dashboard exactly
    // once. The plaintext lives in the response only — the database row stores
    // it encrypted just like every other secret.
    let generatedWebhookSecret: string | undefined;
    if (type === "webhook" && (!values.signing_secret || values.signing_secret.trim().length === 0)) {
      const secret = generateWebhookSecret();
      generatedWebhookSecret = secret;
      values.signing_secret = secret;
    }

    try {
      const result = await createDestinationWithCredential({
        workspaceId,
        type,
        name,
        values,
      });

      await audit({
        action: "destination.created",
        targetType: "destination",
        targetId: result.destinationId,
        metadata: {
          type,
          name,
          fingerprint: result.fingerprint,
          // Audit log NEVER stores the secret values themselves; only that
          // a credential was attached and what its fingerprint is.
          has_credential: result.fingerprint !== null,
        },
      });

      const fingerprintNote = result.fingerprint
        ? ` Credential ends in ${result.fingerprint.last4} (sha256: ${result.fingerprint.sha256_prefix}).`
        : "";
      tags("destinations");
      // Spread `data` only when present — `exactOptionalPropertyTypes` rejects
      // an explicit `data: undefined`, so the field has to be absent entirely
      // for the non-secret path.
      return {
        notice: generatedWebhookSecret
          ? `Webhook destination created (${result.destinationId}). Copy the signing secret below — it won't be shown again.`
          : `Destination created (${result.destinationId}).${fingerprintNote}`,
        ...(generatedWebhookSecret
          ? { data: { webhookSigningSecret: generatedWebhookSecret, destinationId: result.destinationId } }
          : {}),
      };
    } catch (err) {
      if (isUniqueViolation(err, "destinations")) {
        return { error: "A destination with that name already exists in this workspace." };
      }
      if (err instanceof Error) {
        if (err.message === "CREDENTIALS_MASTER_KEY is not set" || err.message.startsWith("CREDENTIALS_MASTER_KEY")) {
          return { error: "Server is missing the credentials master key. Ask the operator to set CREDENTIALS_MASTER_KEY." };
        }
        // Validation errors propagate their human message.
        return { error: err.message };
      }
      return { error: "Could not create the destination. Try again." };
    }
  });
}

export async function setDestinationStatus(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const destinationId = formValue(formData, "destination_id");
    const status = formValue(formData, "status");
    if (!destinationId || (status !== "active" && status !== "disabled")) {
      return { error: "Pick a valid destination and a valid status." };
    }

    const result = await db().query(
      `UPDATE destinations
          SET status = $1, updated_at = now()
        WHERE id = $2 AND workspace_id = $3`,
      [status, destinationId, workspaceId],
    );
    if (!result.rowCount) return { error: "Destination not found in this workspace." };

    await audit({
      action: "destination.status_changed",
      targetType: "destination",
      targetId: destinationId,
      metadata: { status },
    });

    tags("destinations");

    return { notice: `Destination ${status === "active" ? "enabled" : "disabled"}.` };
  });
}

export async function rotateDestinationCredentials(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const destinationId = formValue(formData, "destination_id");
    const type = formValue(formData, "type");
    if (!destinationId || !validateDestinationType(type)) {
      return { error: "Pick a destination and provide its type to rotate." };
    }
    const values = readDestinationValues(formData, type);

    const validationError = validateDestinationValues(type, values);
    if (validationError) return { error: validationError };

    // "Connect without certificate verification" toggle — bake the no-verify TLS
    // option into the rotated connection string, same as createDestination, so a
    // self-signed / private-CA customer DB (e.g. a Railway proxy) rotates to a
    // working credential in one step instead of needing a hand-edited DSN.
    if (type === "postgres" && formValue(formData, "pg_ssl_no_verify") === "true" && values.connection_string) {
      values.connection_string = withNoVerifySslMode(values.connection_string);
    }
    if (type === "mongodb" && formValue(formData, "mongo_tls_no_verify") === "true" && values.connection_string) {
      values.connection_string = withMongoTlsNoVerify(values.connection_string);
    }

    try {
      const fp = await rotateDestinationCredentialBlob(
        destinationId,
        workspaceId,
        values,
      );
      await audit({
        action: "destination.credential_rotated",
        targetType: "destination",
        targetId: destinationId,
        metadata: { fingerprint: fp },
      });
      tags("destinations");
      return { notice: `Credential rotated. New fingerprint ends in ${fp.last4} (sha256: ${fp.sha256_prefix}).` };
    } catch (err) {
      if (err instanceof Error && err.message === "destination_not_found") {
        return { error: "Destination not found in this workspace." };
      }
      if (err instanceof Error && err.message === "no_secrets_to_rotate") {
        return { error: "This destination type doesn't have any rotatable credentials." };
      }
      return { error: err instanceof Error ? err.message : "Could not rotate the credential." };
    }
  });
}

/**
 * Update a destination's name and / or its non-secret config fields.
 *
 * Secret fields (kind: "secret") are deliberately ignored here — they go
 * through `rotateDestinationCredentials` which writes a new encrypted blob.
 * That split keeps the dashboard's edit form honest: an operator can tweak
 * a table name without re-entering an AWS secret access key.
 */
export async function updateDestination(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const destinationId = formValue(formData, "destination_id");
    if (!destinationId) return { error: "Missing destination id." };

    // Look up the type so we can validate / coerce the right fields.
    const lookup = await db().query<{ type: DestinationType; config: Record<string, unknown> }>(
      `SELECT type, config FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [destinationId, workspaceId],
    );
    const row = lookup.rows[0];
    if (!row) return { error: "Destination not found in this workspace." };

    const schema = schemaFor(row.type);
    const newName = formValue(formData, "name");

    // Build the new config object. We start from the existing config and
    // overwrite only the keys the form submitted, so untouched fields keep
    // their current value.
    const newConfig: Record<string, unknown> = { ...row.config };
    for (const field of schema.fields) {
      if (field.kind !== "config") continue;
      const raw = formData.get(field.key);
      if (typeof raw !== "string") continue;
      const value = raw.trim();
      if (value.length === 0) {
        // Empty submission for an optional field → drop it from config so the
        // worker falls back to default.
        if (field.required === false) delete newConfig[field.key];
        else return { error: `Missing required field: ${field.label}.` };
        continue;
      }
      if (field.inputType === "number" && /^-?\d+$/.test(value)) {
        newConfig[field.key] = Number.parseInt(value, 10);
      } else {
        newConfig[field.key] = value;
      }
    }

    // Parity with the create form's conditional rendering: a `showWhen` config
    // field whose controlling value no longer matches is dropped, so switching
    // e.g. the HTTP auth mode away from "api_key" doesn't leave a stale
    // api_key_header behind in config forever (the form never submits hidden
    // fields, and create never stores them).
    for (const field of schema.fields) {
      if (field.kind !== "config" || !field.showWhen) continue;
      if (!isDestinationFieldVisible(field, newConfig)) delete newConfig[field.key];
    }

    // AXE-33 — the edit form renders real dropdowns, but validate server-side
    // too: a typo'd enum submitted directly (e.g. "sha512" instead of
    // "hmac-sha512") would be silently signed as SHA-256 by the webhook
    // connector, breaking receiver verification with no error anywhere.
    const optionsError = destinationSelectOptionsError(row.type, newConfig);
    if (optionsError) return { error: optionsError };

    // SSRF pre-check on URL-shaped config fields — symmetric with createDestination
    // and rotateDestinationCredentials. The webhook/http `url` fields are
    // kind=config/inputType=url, so without this an admin could repoint a live
    // destination at a private/link-local/metadata host AFTER creation, bypassing
    // the create-time guard. (number fields stay numbers at runtime; the cast is
    // safe because validateDestinationValues only reads url/secret fields, and
    // secrets aren't present in newConfig.)
    const ssrfError = validateDestinationValues(row.type, newConfig as Record<string, string>);
    if (ssrfError) return { error: ssrfError };

    // Validate name if it changed.
    if (newName) {
      const nameErr = entityNameError(newName);
      if (nameErr) return { error: nameErr };
    }

    const result = await db().query(
      `UPDATE destinations
          SET name = COALESCE($1, name),
              config = $2::jsonb,
              updated_at = now()
        WHERE id = $3 AND workspace_id = $4`,
      [newName || null, JSON.stringify(newConfig), destinationId, workspaceId],
    );
    if (!result.rowCount) return { error: "Destination not found in this workspace." };

    await audit({
      action: "destination.config_updated",
      targetType: "destination",
      targetId: destinationId,
      metadata: { name: newName || null, config_keys: Object.keys(newConfig) },
    });

    tags("destinations");

    return { notice: "Destination updated. Caps apply on the next delivery (no edge cache for destinations)." };
  });
}

export async function deleteDestination(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit, tags }) => {
    if (session.activeWorkspace.role !== "owner") {
      return {
        error: "Only owners can delete destinations. Disable instead if you don't have owner access.",
      };
    }
    const destinationId = formValue(formData, "destination_id");
    if (!destinationId) return { error: "Pick a destination to delete." };

    // ON DELETE CASCADE on destination_credentials.destination_id ensures the
    // ciphertext goes with the destination row.
    const result = await db().query(
      `DELETE FROM destinations WHERE id = $1 AND workspace_id = $2`,
      [destinationId, workspaceId],
    );
    if (!result.rowCount) return { error: "Destination not found in this workspace." };

    await audit({
      action: "destination.deleted",
      targetType: "destination",
      targetId: destinationId,
      metadata: {},
    });

    tags("destinations", "routes");

    return { notice: "Destination deleted. Routes that pointed at it were detached." };
  });
}

/**
 * AXE-27 — operator controls for the destination circuit breaker.
 *
 * Three actions wrapped behind a single server entry point because
 * they all share the same auth + audit shape:
 *   - reset:   force-close the breaker, zero the failure counter.
 *   - disable: stop all deliveries to this destination until re-enabled.
 *              The breaker treats `disabled` as "skip + dead-letter" so
 *              the queue drains rather than backing up.
 *   - enable:  flip `disabled` back to `closed`.
 */
export async function destinationCircuitAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, tags }) => {
    const destinationId = formValue(formData, "destination_id");
    const action = formValue(formData, "action") as "reset" | "disable" | "enable";
    if (!destinationId) return { error: "Missing destination_id." };
    if (!["reset", "disable", "enable"].includes(action)) {
      return { error: "Unknown action." };
    }
    const pool = db();

    if (action === "reset") {
      const result = await pool.query<{ from_state: string }>(
        `UPDATE destinations
            SET circuit_state = 'closed',
                circuit_consecutive_failures = 0,
                circuit_opened_at = NULL,
                circuit_half_open_at = NULL,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND circuit_state <> 'disabled'
      RETURNING circuit_state AS from_state`,
        [destinationId, workspaceId],
      );
      if (result.rowCount === 0) {
        return { error: "Cannot reset: destination not found or is in 'disabled' state. Re-enable first." };
      }
    } else if (action === "disable") {
      // The `<> 'disabled'` guard makes a re-disable a detectable no-op so we
      // don't report success / write an audit row when nothing changed.
      const result = await pool.query(
        `UPDATE destinations
            SET circuit_state = 'disabled',
                circuit_opened_at = COALESCE(circuit_opened_at, now()),
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND circuit_state <> 'disabled'`,
        [destinationId, workspaceId],
      );
      if (result.rowCount === 0) {
        return { notice: "Destination is already disabled (or not found in this workspace)." };
      }
    } else {
      // enable
      const result = await pool.query(
        `UPDATE destinations
            SET circuit_state = 'closed',
                circuit_consecutive_failures = 0,
                circuit_opened_at = NULL,
                circuit_half_open_at = NULL,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND circuit_state = 'disabled'`,
        [destinationId, workspaceId],
      );
      if (result.rowCount === 0) {
        return { notice: "Destination is already enabled (or not found in this workspace)." };
      }
    }

    await writeAudit(pool, {
      workspaceId,
      actorUserId,
      action: "destination.circuit_breaker_manual",
      targetType: "destination",
      targetId: destinationId,
      metadata: { action },
    });
    if (action === "reset" || action === "enable") {
      // A manual reset resolves the breaker-open inbox row, same as an
      // automatic recovery — and frees its dedup slot for the next outage.
      await pool
        .query(
          `UPDATE notifications
              SET read_at = now()
            WHERE workspace_id = $1
              AND kind = 'destination_circuit_open'
              AND dedup_key = $2
              AND read_at IS NULL`,
          [workspaceId, `breaker_open:${destinationId}`],
        )
        .catch((err) => console.error("[circuit] notification resolve failed", err));
    }
    tags("destinations");
    return { notice: `Circuit breaker ${action} applied.` };
  });
}

/**
 * AXE-28 — operator pause/resume + delivery-control updates.
 *
 * Three flavors via the `action` field:
 *   - pause:           stop deliveries (queue retries the message
 *                      indefinitely until resumed).
 *   - resume:          clear the pause flag.
 *   - update_controls: set rate_limit_rps (or NULL to clear) and
 *                      request_timeout_ms (or NULL to clear).
 *
 * Distinct from the breaker's `disable` because pause is a soft
 * hold (retry queue grows, no events lost) while disable hard-drops
 * everything to the dead-letter table.
 */
export async function destinationDeliveryControlsAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, tags }) => {
    const destinationId = formValue(formData, "destination_id");
    const action = formValue(formData, "action") as "pause" | "resume" | "update_controls";
    if (!destinationId) return { error: "Missing destination_id." };
    if (!["pause", "resume", "update_controls"].includes(action)) {
      return { error: "Unknown action." };
    }
    const pool = db();

    if (action === "pause") {
      const reason = formValue(formData, "reason") || null;
      const result = await pool.query(
        `UPDATE destinations
            SET delivery_paused = TRUE,
                delivery_paused_at = now(),
                delivery_paused_reason = $3,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [destinationId, workspaceId, reason],
      );
      // Same rowCount honesty as setDestinationStatus/updateDestination: a
      // zero-row UPDATE (destination deleted between page load and submit) must
      // not read as "controls applied".
      if (result.rowCount === 0) return { error: "Destination not found in this workspace." };
    } else if (action === "resume") {
      const result = await pool.query(
        `UPDATE destinations
            SET delivery_paused = FALSE,
                delivery_paused_at = NULL,
                delivery_paused_reason = NULL,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [destinationId, workspaceId],
      );
      if (result.rowCount === 0) return { error: "Destination not found in this workspace." };
    } else {
      // update_controls
      const rpsRaw = formValue(formData, "rate_limit_rps");
      const timeoutRaw = formValue(formData, "request_timeout_ms");
      const rps = rpsRaw ? Number(rpsRaw) : null;
      const timeout = timeoutRaw ? Number(timeoutRaw) : null;
      // Number.isInteger rejects NaN/Infinity/floats in one check — the DB column
      // is INTEGER CHECK (>= 1), so a float like 1.5 would otherwise pass here and
      // blow up at the DB as an unhandled exception instead of a clean message.
      if (rps !== null && (!Number.isInteger(rps) || rps < 1)) {
        return { error: "rate_limit_rps must be a whole number ≥ 1, or empty." };
      }
      if (timeout !== null && (!Number.isInteger(timeout) || timeout < 100 || timeout > 300_000)) {
        return { error: "request_timeout_ms must be a whole number between 100 and 300000, or empty." };
      }
      const result = await pool.query(
        `UPDATE destinations
            SET rate_limit_rps = $3,
                -- Reset the token bucket so the new cap kicks in cleanly.
                rate_tokens = NULL,
                rate_tokens_updated_at = NULL,
                request_timeout_ms = $4,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [destinationId, workspaceId, rps, timeout],
      );
      if (result.rowCount === 0) return { error: "Destination not found in this workspace." };
    }

    await writeAudit(pool, {
      workspaceId,
      actorUserId,
      action: "destination.delivery_controls",
      targetType: "destination",
      targetId: destinationId,
      metadata: { action },
    });
    tags("destinations");
    return { notice: `Delivery controls ${action} applied.` };
  });
}
