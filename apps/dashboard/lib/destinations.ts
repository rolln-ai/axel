import "server-only";
import type pg from "pg";
import { withTransaction } from "./db";
import { credentialAad, encryptCredential } from "./credentials";
import {
  schemaFor,
  type DestinationField,
  type DestinationType,
} from "./destination-defaults";
import { prefixedId } from "./ids";
import { entityNameError } from "./entity-name";

export interface DestinationRow {
  id: string;
  workspace_id: string;
  name: string | null;
  type: DestinationType;
  config: Record<string, unknown>;
  credentials_ref: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  /** Joined from destination_credentials, null if no credential exists. */
  fingerprint_last4: string | null;
  fingerprint_sha256_prefix: string | null;
}

export interface CreateDestinationInput {
  workspaceId: string;
  type: DestinationType;
  name: string;
  /** Form values keyed by field.key. Both config + secret fields. */
  values: Record<string, string>;
}

export interface CreateDestinationResult {
  destinationId: string;
  fingerprint: { last4: string; sha256_prefix: string } | null;
}

export interface ListDestinationsRow extends DestinationRow {
  routes_attached: number;
}

function validateDestinationInput(input: CreateDestinationInput): string | null {
  // Destination names are display labels — same relaxed rule as sources and
  // pipelines (spaces + mixed case allowed). See lib/entity-name.ts.
  const nameErr = entityNameError(input.name ?? "");
  if (nameErr) return nameErr;
  const schema = schemaFor(input.type);
  for (const field of schema.fields) {
    if (field.required === false) continue;
    const v = input.values[field.key];
    if (typeof v !== "string" || v.trim().length === 0) {
      return `Missing required field: ${field.label}.`;
    }
  }
  return null;
}

function splitFieldsByKind(
  schema: { fields: DestinationField[] },
  values: Record<string, string>,
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const field of schema.fields) {
    const raw = values[field.key];
    if (typeof raw !== "string" || raw.length === 0) continue;
    const value = raw.trim();
    if (field.kind === "secret") {
      secrets[field.key] = value;
    } else {
      // Config values: try to coerce numerics that look like numbers, leave the rest as strings.
      if (field.inputType === "number" && /^-?\d+$/.test(value)) {
        config[field.key] = Number.parseInt(value, 10);
      } else {
        config[field.key] = value;
      }
    }
  }
  return { config, secrets };
}

/**
 * Combine all secret fields into ONE encrypted blob (JSON-encoded). The
 * delivery-side decrypt returns the same JSON, which the connectors merge
 * into the destination config before dispatch.
 *
 * Why one blob (not one row per secret): a single secret per destination
 * keeps the credentials_ref → row lookup one query, and ciphertexts are
 * cheap to encrypt/decrypt vs the round-trip cost of fetching multiple
 * rows. AWS access_key_id + secret_access_key are *one credential pair*,
 * not two independent secrets — encoding both in one blob captures that.
 */
function packSecrets(secrets: Record<string, string>): string {
  return JSON.stringify(secrets);
}

export async function createDestinationWithCredential(
  input: CreateDestinationInput,
  externalClient?: pg.PoolClient,
): Promise<CreateDestinationResult> {
  const validationError = validateDestinationInput(input);
  if (validationError) throw new Error(validationError);

  const schema = schemaFor(input.type);
  const { config, secrets } = splitFieldsByKind(schema, input.values);

  const destinationId = prefixedId("dst");
  const credentialId = Object.keys(secrets).length > 0 ? prefixedId("cred") : null;

  // Encrypt OUTSIDE the transaction so we don't hold a connection while
  // crypto runs. The actual encryption is microseconds anyway.
  let encrypted: Awaited<ReturnType<typeof encryptCredential>> | null = null;
  if (credentialId) {
    // v2: bind the ciphertext to (workspace, destination) so a blob copied to
    // another row fails GCM auth on decrypt (audit: creds were transplantable).
    encrypted = await encryptCredential(packSecrets(secrets), credentialAad(input.workspaceId, destinationId));
  }

  const runWork = async (client: pg.PoolClient) => {
    // Duplicate-name check inside the transaction so a race can't insert two.
    const dupe = await client.query(
      `SELECT 1 FROM destinations WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [input.workspaceId, input.name],
    );
    if (dupe.rowCount) throw new Error("destination_name_taken");

    await client.query(
      `INSERT INTO destinations (id, workspace_id, name, type, config, credentials_ref, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'active')`,
      [destinationId, input.workspaceId, input.name, input.type, JSON.stringify(config), credentialId],
    );

    if (encrypted && credentialId) {
      await client.query(
        `INSERT INTO destination_credentials
           (id, destination_id, workspace_id, ciphertext, nonce, auth_tag,
            fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          credentialId,
          destinationId,
          input.workspaceId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.auth_tag,
          encrypted.fingerprint_last4,
          encrypted.fingerprint_sha256_prefix,
          encrypted.encryption_version,
        ],
      );
    }
  };

  if (externalClient) {
    await runWork(externalClient);
  } else {
    await withTransaction(runWork);
  }

  return {
    destinationId,
    fingerprint: encrypted
      ? {
          last4: encrypted.fingerprint_last4,
          sha256_prefix: encrypted.fingerprint_sha256_prefix,
        }
      : null,
  };
}

/**
 * Replace the credential blob for an existing destination. Old credential
 * row stays in place (audit-trail value); the new one becomes the
 * authoritative `credentials_ref`.
 */
export async function rotateDestinationCredentialBlob(
  destinationId: string,
  workspaceId: string,
  values: Record<string, string>,
): Promise<{ last4: string; sha256_prefix: string }> {
  // Fetch the destination so we know what type it is + which fields are secrets.
  const result = await (await import("./db")).db().query<{ type: DestinationType }>(
    `SELECT type FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [destinationId, workspaceId],
  );
  const type = result.rows[0]?.type;
  if (!type) throw new Error("destination_not_found");

  const schema = schemaFor(type);
  const { secrets } = splitFieldsByKind(schema, values);
  if (Object.keys(secrets).length === 0) throw new Error("no_secrets_to_rotate");

  const encrypted = await encryptCredential(packSecrets(secrets), credentialAad(workspaceId, destinationId));
  const newCredentialId = prefixedId("cred");

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO destination_credentials
         (id, destination_id, workspace_id, ciphertext, nonce, auth_tag,
          fingerprint_last4, fingerprint_sha256_prefix, encryption_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newCredentialId,
        destinationId,
        workspaceId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.auth_tag,
        encrypted.fingerprint_last4,
        encrypted.fingerprint_sha256_prefix,
        encrypted.encryption_version,
      ],
    );
    await client.query(
      `UPDATE destinations SET credentials_ref = $1, updated_at = now()
        WHERE id = $2 AND workspace_id = $3`,
      [newCredentialId, destinationId, workspaceId],
    );
  });

  return {
    last4: encrypted.fingerprint_last4,
    sha256_prefix: encrypted.fingerprint_sha256_prefix,
  };
}

export async function listDestinationsWithRouteCount(
  workspaceId: string,
  client: pg.Pool | pg.PoolClient,
): Promise<ListDestinationsRow[]> {
  const result = await client.query<ListDestinationsRow>(
    `SELECT d.id, d.workspace_id, d.name, d.type, d.config, d.credentials_ref,
            d.status, d.created_at::text, d.updated_at::text,
            dc.fingerprint_last4, dc.fingerprint_sha256_prefix,
            (SELECT count(*)::int FROM route_destinations rd WHERE rd.destination_id = d.id) AS routes_attached
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.workspace_id = $1
      ORDER BY d.created_at DESC
      LIMIT 200`,
    [workspaceId],
  );
  return result.rows;
}

