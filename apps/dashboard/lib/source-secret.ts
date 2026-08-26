import "server-only";

import { createHash } from "node:crypto";
import {
  decryptPackedCredential,
  deriveFlexibleMasterKey,
  encryptPackedCredential,
  sourceSigningSecretAadString,
} from "@axel/shared";

/**
 * Encryption / decryption helpers for inbound provider signing secrets
 * (AXE-23). Symmetric AES-256-GCM under the same CREDENTIALS_MASTER_KEY
 * the destinations subsystem uses, with a per-record 12-byte nonce.
 * The envelope itself lives in the shared Web-Crypto core
 * (@axel/shared credential-crypto — golden-vector pinned), which is the
 * same code the ingest edge and delivery-service run on decrypt.
 *
 * Storage format (bytea column on `sources.signing_secret_ciphertext`):
 *   v2 (current): [0x02 version][12-byte nonce][N-byte ciphertext][16-byte tag]
 *                 AAD-bound to (workspace, source) — a blob copied to another
 *                 source row fails GCM authentication.
 *   v1 (legacy):  [12-byte nonce][N-byte ciphertext][16-byte tag], no AAD.
 *                 Still decrypts (rows written before the AAD binding shipped).
 *
 * This is intentionally a different module from packages/credentials —
 * that package targets envelope-wrapped destination credentials with
 * KMS round-trips and per-decryption audit rows. Inbound signing
 * secrets are simpler: read every webhook (millions of events), no
 * per-read audit, no per-record key wrapping, just symmetric crypto
 * with a single master key.
 */

function masterKey(env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
  const raw = env.CREDENTIALS_MASTER_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      "CREDENTIALS_MASTER_KEY is not set — required to encrypt source signing secrets",
    );
  }
  // Flexible acceptance, unchanged: hex (64 chars), base64 (44 chars), or any
  // other string hashed to a 32-byte key. The hash branch is a safety net for
  // dev; production should always set a 32-byte hex string.
  return deriveFlexibleMasterKey(raw);
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  fingerprint: string;
}

/**
 * Encrypt a plaintext signing secret, AAD-bound to (workspaceId, sourceId).
 * Throws if the master key is unset. Always emits the v2 layout.
 */
export async function encryptSourceSigningSecret(
  plaintext: string,
  workspaceId: string,
  sourceId: string,
): Promise<EncryptedSecret> {
  const blob = await encryptPackedCredential(
    plaintext,
    await masterKey(),
    sourceSigningSecretAadString(workspaceId, sourceId),
  );
  return { ciphertext: Buffer.from(blob), fingerprint: fingerprintFor(plaintext) };
}

/**
 * Decrypt the bytea blob produced by `encryptSourceSigningSecret`. Handles both
 * the v2 (AAD-bound) and legacy v1 (no AAD) layouts — including a legacy nonce
 * that coincidentally begins 0x02. A v2 blob whose (workspaceId, sourceId)
 * doesn't match the AAD fails GCM authentication and is rejected — so a
 * ciphertext transplanted onto another source row won't decrypt.
 */
export async function decryptSourceSigningSecret(
  blob: Buffer,
  workspaceId: string,
  sourceId: string,
): Promise<string> {
  return decryptPackedCredential(blob, await masterKey(), sourceSigningSecretAadString(workspaceId, sourceId));
}

/**
 * Stable, non-reversible fingerprint derived from the plaintext. Used
 * by the dashboard UI to display "secret …f7a1c3" next to a rotated
 * secret without ever decrypting (or storing) the plaintext.
 */
export function fingerprintFor(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 12);
}
