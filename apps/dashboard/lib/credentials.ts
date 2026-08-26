import "server-only";
import { createHash } from "node:crypto";
import {
  credentialAadString,
  decryptCredentialV2,
  encryptCredentialV2,
  parseHexMasterKey,
  pullSourceCredentialAadString,
} from "@axel/shared";

/**
 * AES-256-GCM credential encryption for destination secrets.
 *
 * The dashboard ENCRYPTS connection strings, AWS keys, signing tokens, and
 * any other secret that would otherwise live in `destinations.config` as
 * plaintext. The envelope itself (encrypt AND decrypt) lives in the shared
 * Web-Crypto core — @axel/shared credential-crypto, golden-vector pinned —
 * which is the same code the decrypt runtimes run:
 *
 *   - apps/delivery-edge   (CF Workers)
 *   - apps/delivery-service (Node, Render)
 *   - apps/pull-worker      (Node, pull-source credentials)
 *
 * # Algorithm
 *
 * - AES-256-GCM (authenticated encryption, prevents ciphertext tampering).
 * - 32-byte master key (= AES-256). Required env: `CREDENTIALS_MASTER_KEY`,
 *   hex-encoded (64 hex chars).
 * - 12-byte random nonce per encryption (best practice for GCM).
 * - 16-byte auth tag stored separately for clarity.
 *
 * # What ends up in Postgres
 *
 * `destination_credentials`:
 *   ciphertext, nonce, auth_tag — bytea
 *   fingerprint_last4, fingerprint_sha256_prefix — text (for UI display)
 *   encryption_version — int (1 = legacy no-AAD; 2 = AAD-bound)
 *
 * # Threat model
 *
 * Protects against: plaintext leakage in DB dumps, application logs, source.
 * Does NOT protect against: master-key compromise (anyone with
 * CREDENTIALS_MASTER_KEY can decrypt every credential — same threat model
 * as Cloudflare Worker secrets, Vercel env vars, etc).
 *
 * Future hardening: replace the env-var master key with a real KMS
 * (Cloudflare's KMS, AWS KMS, etc) using envelope encryption per row.
 */

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  fingerprint_last4: string;
  fingerprint_sha256_prefix: string;
  encryption_version: number;
}

function loadMasterKey(): Uint8Array {
  const hex = process.env.CREDENTIALS_MASTER_KEY;
  if (!hex) {
    throw new Error(
      "CREDENTIALS_MASTER_KEY is not set. Generate one with `openssl rand -hex 32` and store it as a secret on every service that handles destination credentials.",
    );
  }
  // Strict 64-hex acceptance, unchanged — shared parse throws the same way.
  return parseHexMasterKey(hex);
}

/**
 * Encrypt `plaintext` for storage. The fingerprint columns let the UI
 * show "ending in •••3a4f" so operators can verify a rotation took
 * effect without ever fetching plaintext back.
 */
export async function encryptCredential(plaintext: string, aad?: Buffer): Promise<EncryptedCredential> {
  if (!plaintext || plaintext.length === 0) {
    throw new Error("encryptCredential: plaintext must be a non-empty string");
  }

  // AAD binds the ciphertext to its context (workspace + destination): a blob
  // copied to another row then fails GCM authentication on decrypt. With no AAD
  // we emit a legacy v1 blob (unchanged) for back-compat.
  const sealed = await encryptCredentialV2(plaintext, loadMasterKey(), aad);

  // Fingerprint: last 4 chars of plaintext (helps UI show "ending in …xyz4")
  // + first 8 chars of SHA-256 hex (lets two operators confirm "we have the
  // same secret" without revealing it).
  const last4 = plaintext.slice(-4);
  const sha256 = createHash("sha256").update(plaintext).digest("hex");

  return {
    ciphertext: Buffer.from(sealed.ciphertext),
    nonce: Buffer.from(sealed.nonce),
    auth_tag: Buffer.from(sealed.auth_tag),
    fingerprint_last4: last4,
    fingerprint_sha256_prefix: sha256.slice(0, 8),
    encryption_version: sealed.encryption_version,
  };
}

/**
 * Stable additional-authenticated-data for a destination credential. Binding
 * the ciphertext to (workspace, destination) means a row copied to another
 * workspace/destination fails GCM authentication on decrypt. The matching
 * pull-source context uses (workspace, source) — keep the two distinct.
 */
export function credentialAad(workspaceId: string, destinationId: string): Buffer {
  return Buffer.from(credentialAadString(workspaceId, destinationId), "utf8");
}

/**
 * Pull-source credential AAD — binds the ciphertext to (workspace, source).
 * Distinct from the destination context above so a destination blob can't be
 * transplanted onto a pull source (and vice-versa). Must match the decrypt
 * side (pull-worker uses pullSourceCredentialAadString).
 */
export function pullSourceCredentialAad(workspaceId: string, sourceId: string): Buffer {
  return Buffer.from(pullSourceCredentialAadString(workspaceId, sourceId), "utf8");
}

/**
 * Quick self-check the dashboard can run at boot to surface a misconfigured
 * master key BEFORE the operator tries to create a destination.
 */
export function isCredentialsMasterKeyConfigured(): boolean {
  try {
    loadMasterKey();
    return true;
  } catch {
    return false;
  }
}

export interface CredentialBlob {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  /** Defaults to 1 (legacy, no AAD). 2 = AAD-bound; decrypt requires the AAD. */
  encryption_version?: number;
}

/**
 * Decrypt a stored credential blob — used by the dashboard's destination
 * detail page (data viewer / edit form pre-fill) and by the future
 * "test connection" action. Runs the SAME shared core as delivery-edge and
 * delivery-service, so a dashboard-side decrypt always agrees.
 *
 * Returns the original `packSecrets()` JSON string, which the caller is
 * expected to JSON-parse. Don't keep plaintext around any longer than
 * needed — this is intentionally a function (not a cache).
 */
export function decryptCredentialBlob(blob: CredentialBlob, aad?: Buffer): Promise<string> {
  // v2 blobs were sealed with AAD and must be opened with the same AAD; v1
  // (legacy) blobs have none. A mismatched (or missing) AAD fails the auth tag.
  return decryptCredentialV2(blob, loadMasterKey(), aad);
}
