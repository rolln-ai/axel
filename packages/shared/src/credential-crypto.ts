/**
 * AES-256-GCM credential-envelope core — the ONE implementation every
 * runtime decrypts (and the dashboard encrypts) credentials with.
 *
 * Web Crypto only: must run unchanged on Cloudflare Workers (ingest-worker,
 * delivery-edge) and Node 20+ (dashboard, delivery-service, pull-worker,
 * where `globalThis.crypto` is the same API). No node:crypto imports.
 *
 * Two envelope families exist in production; both are handled here and both
 * are pinned by golden vectors (credential-test-vectors.ts + each app's
 * credential-golden-vectors.test.ts). Any change that fails a golden vector
 * would make EXISTING stored blobs undecryptable on some runtime.
 *
 * Family A — "column envelope" (destination_credentials,
 * pull_source_credentials): ciphertext, 12-byte nonce and 16-byte auth tag
 * stored as separate columns plus an `encryption_version` int.
 *   v1 (legacy): sealed with no AAD; decrypt ignores any AAD passed.
 *   v2: sealed with AAD (credentialAadString / pullSourceCredentialAadString)
 *       — decrypt REQUIRES the same AAD or GCM auth fails.
 *
 * Family B — "packed envelope" (sources.signing_secret_ciphertext): one
 * self-contained bytea.
 *   v2 (current): [0x02 | 12-byte nonce | ciphertext | 16-byte tag], AAD
 *       = sourceSigningSecretAadString(workspace, source).
 *   v1 (legacy): [nonce | ciphertext | tag], no version byte, no AAD.
 *   Decrypt rule: when byte0 == 0x02 try the v2 interpretation first and
 *   fall back to whole-blob v1 on failure — a legacy nonce can
 *   coincidentally begin 0x02 (pinned by the "b-v1-nonce-02" vector).
 *
 * Master-key DERIVATION is split to preserve each runtime's historical
 * acceptance exactly (never tighten what a runtime accepts — a key form
 * that decrypts today must keep decrypting):
 *   - parseHexMasterKey: strict 64-hex → 32 bytes (dashboard destination
 *     credentials, delivery-service, pull-worker).
 *   - deriveFlexibleMasterKey: hex(64) → raw, base64(43+"=") → raw, else
 *     SHA-256 of the raw string (dashboard source-secret, ingest-worker).
 *   - delivery-edge keeps its own laxer local hex parser (accepts any
 *     even-length string; per-app key LOADING stays local by design).
 */

const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** Leading byte marking an AAD-bound v2 packed blob. */
const PACKED_AAD_VERSION = 0x02;
/** Column-envelope versions: 1 = legacy no-AAD, 2 = AAD-bound. */
const COLUMN_VERSION_LEGACY = 1;
const COLUMN_VERSION_AAD = 2;

/** Family A blob as stored: separate columns + version int (1 when absent). */
export interface CredentialColumnsBlob {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  /** Defaults to 1 (legacy, no AAD). 2 = AAD-bound; decrypt requires the AAD. */
  encryption_version?: number;
}

export interface EncryptedCredentialColumns {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  encryption_version: number;
}

function toAadBytes(aad: Uint8Array | string): Uint8Array {
  return typeof aad === "string" ? new TextEncoder().encode(aad) : aad;
}

function assertKeyBytes(keyBytes: Uint8Array): void {
  if (keyBytes.length !== 32) {
    throw new Error("credential master key must be 32 bytes (AES-256)");
  }
}

function importAesKey(keyBytes: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  // BufferSource casts keep this compiling under both the DOM lib and
  // @cloudflare/workers-types (mixed-lib consumers include this source).
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [usage]);
}

async function gcmDecrypt(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array | undefined,
): Promise<string> {
  const key = await importAesKey(keyBytes, "decrypt");
  // Web Crypto wants the auth tag appended to the ciphertext.
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const params: { name: string; iv: BufferSource; tagLength: number; additionalData?: BufferSource } = {
    name: "AES-GCM",
    iv: nonce as BufferSource,
    tagLength: 128,
  };
  if (aad) params.additionalData = aad as BufferSource;
  const plaintext = await crypto.subtle.decrypt(params, key, combined as BufferSource);
  return new TextDecoder().decode(plaintext);
}

async function gcmEncrypt(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  plaintext: string,
  aad: Uint8Array | undefined,
): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> {
  const key = await importAesKey(keyBytes, "encrypt");
  const params: { name: string; iv: BufferSource; tagLength: number; additionalData?: BufferSource } = {
    name: "AES-GCM",
    iv: nonce as BufferSource,
    tagLength: 128,
  };
  if (aad) params.additionalData = aad as BufferSource;
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(params, key, new TextEncoder().encode(plaintext) as BufferSource),
  );
  return {
    ciphertext: sealed.subarray(0, sealed.length - GCM_TAG_BYTES),
    tag: sealed.subarray(sealed.length - GCM_TAG_BYTES),
  };
}

/**
 * Decrypt a Family A (column-envelope) credential blob.
 *
 * v2 blobs REQUIRE the AAD they were sealed with (a mismatched or missing
 * AAD fails GCM authentication). v1 blobs were sealed without AAD, so any
 * AAD passed is deliberately ignored — matching every historical decrypter.
 */
export async function decryptCredentialV2(
  blob: CredentialColumnsBlob,
  keyBytes: Uint8Array,
  aad?: Uint8Array | string,
): Promise<string> {
  assertKeyBytes(keyBytes);
  const version = blob.encryption_version ?? COLUMN_VERSION_LEGACY;
  let aadBytes: Uint8Array | undefined;
  if (version >= COLUMN_VERSION_AAD) {
    if (aad == null) throw new Error("decryptCredentialV2: v2 credential requires its AAD context");
    aadBytes = toAadBytes(aad);
  }
  return gcmDecrypt(keyBytes, blob.nonce, blob.ciphertext, blob.auth_tag, aadBytes);
}

/**
 * Encrypt to the Family A column envelope with a fresh random 12-byte nonce.
 * With an AAD → v2; without → legacy v1 (kept for back-compat writers).
 */
export async function encryptCredentialV2(
  plaintext: string,
  keyBytes: Uint8Array,
  aad?: Uint8Array | string,
): Promise<EncryptedCredentialColumns> {
  assertKeyBytes(keyBytes);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const { ciphertext, tag } = await gcmEncrypt(keyBytes, nonce, plaintext, aad != null ? toAadBytes(aad) : undefined);
  return {
    ciphertext,
    nonce,
    auth_tag: tag,
    encryption_version: aad != null ? COLUMN_VERSION_AAD : COLUMN_VERSION_LEGACY,
  };
}

/**
 * Decrypt a Family B (packed) blob: v2 `[0x02|nonce|ct|tag]` with the given
 * AAD string, falling back to legacy v1 `[nonce|ct|tag]` (no AAD) — both
 * when the version byte is absent and when a v2-looking blob fails auth
 * (a legacy nonce can coincidentally begin 0x02).
 */
export async function decryptPackedCredential(
  blob: Uint8Array,
  keyBytes: Uint8Array,
  aadString: string,
): Promise<string> {
  assertKeyBytes(keyBytes);
  if (blob.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error("credential blob is too short to be valid");
  }
  if (blob.length >= 1 + NONCE_BYTES + GCM_TAG_BYTES && blob[0] === PACKED_AAD_VERSION) {
    try {
      return await decryptPackedBody(blob.subarray(1), keyBytes, toAadBytes(aadString));
    } catch {
      // fall through to the legacy v1 interpretation (whole blob, no AAD)
    }
  }
  return decryptPackedBody(blob, keyBytes, undefined);
}

async function decryptPackedBody(
  body: Uint8Array,
  keyBytes: Uint8Array,
  aad: Uint8Array | undefined,
): Promise<string> {
  if (body.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error("credential blob is too short to be valid");
  }
  return gcmDecrypt(
    keyBytes,
    body.subarray(0, NONCE_BYTES),
    body.subarray(NONCE_BYTES, body.length - GCM_TAG_BYTES),
    body.subarray(body.length - GCM_TAG_BYTES),
    aad,
  );
}

/**
 * Encrypt to the Family B packed envelope. Always emits the current v2
 * layout `[0x02|nonce|ct|tag]`, AAD-bound; fresh random nonce.
 */
export async function encryptPackedCredential(
  plaintext: string,
  keyBytes: Uint8Array,
  aadString: string,
): Promise<Uint8Array> {
  assertKeyBytes(keyBytes);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const { ciphertext, tag } = await gcmEncrypt(keyBytes, nonce, plaintext, toAadBytes(aadString));
  const blob = new Uint8Array(1 + NONCE_BYTES + ciphertext.length + GCM_TAG_BYTES);
  blob[0] = PACKED_AAD_VERSION;
  blob.set(nonce, 1);
  blob.set(ciphertext, 1 + NONCE_BYTES);
  blob.set(tag, 1 + NONCE_BYTES + ciphertext.length);
  return blob;
}

/**
 * Strict master-key parsing: exactly 64 hex chars → 32 bytes. The
 * acceptance policy of the dashboard's destination-credential path,
 * delivery-service, and pull-worker — do not loosen or tighten.
 */
export function parseHexMasterKey(raw: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("CREDENTIALS_MASTER_KEY must be 64 hex characters (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Flexible master-key derivation: hex(64) → raw bytes, base64
 * (`[A-Za-z0-9+/]{43}=`) → raw bytes, anything else → SHA-256 of the
 * string. The acceptance policy of the dashboard's source-secret path and
 * the ingest edge — do not loosen or tighten (the sha256 branch is a dev
 * safety net that production keys never hit, but existing deployments may
 * rely on it).
 */
export async function deriveFlexibleMasterKey(raw: string): Promise<Uint8Array> {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return parseHexMasterKey(raw);
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw) as BufferSource);
  return new Uint8Array(digest);
}
