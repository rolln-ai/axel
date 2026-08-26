/**
 * Golden-vector generator for the AES-256-GCM credential envelopes.
 *
 * Emits packages/shared/src/credential-test-vectors.ts — FROZEN ciphertext
 * vectors that pin the exact byte layouts the platform's encrypt paths
 * produce, so any change to the (now shared) decrypt core that would break
 * compatibility with existing stored blobs fails tests loudly.
 *
 * The envelope construction below deliberately mirrors, primitive-for-
 * primitive, the two production encrypt paths as of the generation date:
 *
 *   Family A — "column envelope" (apps/dashboard/lib/credentials.ts
 *   encryptCredential): AES-256-GCM with a 12-byte nonce; ciphertext,
 *   nonce and 16-byte auth tag stored as SEPARATE columns plus an
 *   encryption_version int. v1 = no AAD; v2 = AAD required
 *   (credentialAadString / pullSourceCredentialAadString).
 *
 *   Family B — "packed envelope" (apps/dashboard/lib/source-secret.ts
 *   encryptSourceSigningSecret): one self-contained bytea.
 *   v2 = [0x02 | 12-byte nonce | ciphertext | 16-byte tag] with
 *   AAD = sourceSigningSecretAadString; v1 (legacy, pre-AAD writer) =
 *   [nonce | ciphertext | tag], no AAD, no version byte. Decrypters must
 *   try v2 when byte0 == 0x02 and fall back to v1 (a legacy nonce can
 *   coincidentally begin 0x02 — pinned by the "b-v1-nonce-02" vector).
 *
 * Everything is deterministic (keys/nonces derived by SHA-256 of labels)
 * so re-running the generator is byte-reproducible. All key material here
 * is test-only, never a real secret.
 *
 * Run (from packages/shared, after `pnpm build` so dist/credential-aad.js
 * exists — the AAD strings are imported from the real module, not retyped):
 *
 *   node test/fixtures/generate-credential-golden-vectors.mjs
 */
import { createCipheriv, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  credentialAadString,
  pullSourceCredentialAadString,
  sourceSigningSecretAadString,
} from "../../dist/credential-aad.js";

const NONCE_BYTES = 12;
const PACKED_AAD_VERSION = 0x02;

const sha256 = (s) => createHash("sha256").update(s).digest();
/** Deterministic per-vector nonce (test vectors only — production uses randomBytes). */
const nonceFor = (name, firstByte = null) => {
  const n = sha256(`axel-golden-nonce:${name}`).subarray(0, NONCE_BYTES);
  if (firstByte !== null) n[0] = firstByte;
  return n;
};

// ---- deterministic test keys (NOT real secrets) -------------------------- //
const KEY_A = sha256("axel-golden-master-key-a (test only)");
const KEY_A_HEX = KEY_A.toString("hex");

// Flexible master-key derivation inputs (mirrors dashboard source-secret.ts
// masterKey() and ingest-worker deriveMasterKey()):
//   hex(64) -> raw bytes; base64([A-Za-z0-9+/]{43}=) -> raw bytes; else sha256(raw).
const KEY_B64_BYTES = sha256("axel-golden-master-key-b64 (test only)");
const KEY_B64_RAW = KEY_B64_BYTES.toString("base64"); // 44 chars, ends '='
const PASSPHRASE_RAW = "axel-golden-passphrase (test only, not a real secret)";
const PASSPHRASE_KEY = sha256(PASSPHRASE_RAW);

// ---- Family A: column envelope (mirrors encryptCredential) --------------- //
function encryptColumns(name, plaintext, key, aadString) {
  const nonce = nonceFor(name);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aadString) cipher.setAAD(Buffer.from(aadString, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    name,
    plaintext,
    keyHex: key.toString("hex"),
    encryptionVersion: aadString ? 2 : 1,
    aad: aadString ?? null,
    nonceHex: nonce.toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
  };
}

// ---- Family B: packed envelope (mirrors encryptSourceSigningSecret) ------ //
function encryptPacked(name, plaintext, key, { workspaceId, sourceId, layout, nonceFirstByte = null, masterKeyRaw }) {
  const nonce = nonceFor(name, nonceFirstByte);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const aad = layout === "v2" ? sourceSigningSecretAadString(workspaceId, sourceId) : null;
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob =
    layout === "v2"
      ? Buffer.concat([Buffer.from([PACKED_AAD_VERSION]), nonce, ct, tag])
      : Buffer.concat([nonce, ct, tag]);
  return {
    name,
    plaintext,
    keyHex: key.toString("hex"),
    /** Raw env-var form for the flexible-derivation decrypters (hex/base64/passphrase). */
    masterKeyRaw,
    layout,
    workspaceId,
    sourceId,
    aad,
    blobHex: blob.toString("hex"),
  };
}

const columnVectors = [
  encryptColumns(
    "a-v1-legacy-no-aad",
    JSON.stringify({ connection_string: "postgres://gold:v1@db.example/axel" }),
    KEY_A,
    null,
  ),
  encryptColumns(
    "a-v2-destination-aad",
    JSON.stringify({ connection_string: "postgres://gold:v2@db.example/axel", token: "shh-gold" }),
    KEY_A,
    credentialAadString("ws_gold", "dest_gold"),
  ),
  encryptColumns(
    "a-v2-pull-source-aad",
    JSON.stringify({ api_key: "pull-gold-key", ingest_token: "tok_gold" }),
    KEY_A,
    pullSourceCredentialAadString("ws_gold", "src_gold"),
  ),
  encryptColumns(
    "a-v2-unicode-plaintext",
    JSON.stringify({ token: "tök€n-π-🔑" }),
    KEY_A,
    credentialAadString("ws_gold", "dest_unicode"),
  ),
];
// Pin the AAD context ids alongside so tests can rebuild AADs via the shared
// builders (proving builder output still matches the frozen aad strings).
const columnAadContexts = {
  "a-v2-destination-aad": { kind: "destination", workspaceId: "ws_gold", id: "dest_gold" },
  "a-v2-pull-source-aad": { kind: "pull-source", workspaceId: "ws_gold", id: "src_gold" },
  "a-v2-unicode-plaintext": { kind: "destination", workspaceId: "ws_gold", id: "dest_unicode" },
};

const packedVectors = [
  encryptPacked("b-v2-srcsign", "whsec_golden_v2_secret", KEY_A, {
    workspaceId: "ws_gold",
    sourceId: "src_gold",
    layout: "v2",
    masterKeyRaw: KEY_A_HEX,
  }),
  encryptPacked("b-v1-legacy", "whsec_golden_v1_legacy", KEY_A, {
    workspaceId: "ws_gold",
    sourceId: "src_gold",
    layout: "v1",
    masterKeyRaw: KEY_A_HEX,
  }),
  // CRITICAL edge case: a legacy v1 blob whose nonce coincidentally begins
  // 0x02. Decrypters must attempt the v2 interpretation, fail GCM auth, and
  // fall back to the whole-blob v1 interpretation.
  encryptPacked("b-v1-nonce-02", "whsec_ambiguous_nonce", KEY_A, {
    workspaceId: "ws_gold",
    sourceId: "src_gold",
    layout: "v1",
    nonceFirstByte: PACKED_AAD_VERSION,
    masterKeyRaw: KEY_A_HEX,
  }),
  // Flexible master-key derivation branches (base64 + sha256-of-passphrase).
  encryptPacked("b-v2-base64-key", "whsec_base64_key_form", KEY_B64_BYTES, {
    workspaceId: "ws_gold",
    sourceId: "src_b64",
    layout: "v2",
    masterKeyRaw: KEY_B64_RAW,
  }),
  encryptPacked("b-v2-passphrase-key", "whsec_passphrase_key_form", PASSPHRASE_KEY, {
    workspaceId: "ws_gold",
    sourceId: "src_pass",
    layout: "v2",
    masterKeyRaw: PASSPHRASE_RAW,
  }),
];

const masterKeyVectors = [
  { form: "hex", raw: KEY_A_HEX, keyHex: KEY_A_HEX },
  { form: "base64", raw: KEY_B64_RAW, keyHex: KEY_B64_BYTES.toString("hex") },
  { form: "sha256-passphrase", raw: PASSPHRASE_RAW, keyHex: PASSPHRASE_KEY.toString("hex") },
];

const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate: node test/fixtures/generate-credential-golden-vectors.mjs
 * (from packages/shared, after building dist).
 *
 * Golden vectors pinning the AES-256-GCM credential envelopes used across
 * the platform. If a change to any decrypt path makes one of these vectors
 * fail, that change would make EXISTING stored credential blobs
 * undecryptable on that runtime — do not "fix" the vector; fix the code.
 *
 * All key material here is deterministic test data, never a real secret.
 * Exported via the "@axel/shared/credential-test-vectors" subpath so every
 * app's test suite can pin its own decrypt entry point against the same
 * frozen bytes. Not part of the runtime API.
 */

/** Family A: ciphertext/nonce/auth_tag stored as separate columns + encryption_version. */
export interface CredentialColumnGoldenVector {
  name: string;
  plaintext: string;
  keyHex: string;
  /** 1 = legacy, sealed without AAD; 2 = AAD-bound. */
  encryptionVersion: 1 | 2;
  /** The exact AAD string the blob was sealed with (null for v1). */
  aad: string | null;
  nonceHex: string;
  ciphertextHex: string;
  authTagHex: string;
}

/** Family B: one self-contained blob — v2 [0x02|nonce|ct|tag] w/ AAD, v1 [nonce|ct|tag] no AAD. */
export interface PackedCredentialGoldenVector {
  name: string;
  plaintext: string;
  keyHex: string;
  /** Raw CREDENTIALS_MASTER_KEY env form (hex / base64 / passphrase) for flexible-derivation decrypters. */
  masterKeyRaw: string;
  layout: "v1" | "v2";
  workspaceId: string;
  sourceId: string;
  aad: string | null;
  blobHex: string;
}

/** Flexible master-key derivation: raw env string -> expected 32-byte key. */
export interface MasterKeyGoldenVector {
  form: "hex" | "base64" | "sha256-passphrase";
  raw: string;
  keyHex: string;
}

export const credentialColumnGoldenVectors: CredentialColumnGoldenVector[] = ${JSON.stringify(columnVectors, null, 2)};

/** (workspace, id) contexts to rebuild v2 AADs via the shared builders. */
export const credentialColumnAadContexts: Record<
  string,
  { kind: "destination" | "pull-source"; workspaceId: string; id: string }
> = ${JSON.stringify(columnAadContexts, null, 2)};

export const packedCredentialGoldenVectors: PackedCredentialGoldenVector[] = ${JSON.stringify(packedVectors, null, 2)};

export const masterKeyGoldenVectors: MasterKeyGoldenVector[] = ${JSON.stringify(masterKeyVectors, null, 2)};
`;

const target = fileURLToPath(new URL("../../src/credential-test-vectors.ts", import.meta.url));
writeFileSync(target, out);
console.log(`wrote ${target}`);
console.log(`  ${columnVectors.length} column vectors, ${packedVectors.length} packed vectors, ${masterKeyVectors.length} key-derivation vectors`);
