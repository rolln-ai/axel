import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceSigningSecretAadString } from "@axel/shared";
import { decryptSourceSigningSecretEdge, mapSourceRow } from "../src/source-lookup-pg.js";

// Deterministic 32-byte dummy key for unit tests only — not a real secret. gitleaks:allow
const HEX_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // gitleaks:allow

function keyBytes(keyRaw: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(keyRaw)
    ? Buffer.from(keyRaw, "hex")
    : createHash("sha256").update(keyRaw).digest();
}

// LEGACY v1: [12-byte nonce | ciphertext | 16-byte tag], no AAD — as the
// dashboard wrote before AAD binding shipped. Still must decrypt.
function encryptBlob(plaintext: string, keyRaw: string): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyRaw), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([nonce, ct, tag]));
}

// CURRENT v2: [0x02 | nonce | ciphertext | tag], AAD-bound to (workspace,
// source) — byte-identical to apps/dashboard/lib/source-secret.ts so this proves
// the two runtimes interoperate.
function encryptBlobV2(plaintext: string, keyRaw: string, workspaceId: string, sourceId: string): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyRaw), nonce);
  cipher.setAAD(Buffer.from(sourceSigningSecretAadString(workspaceId, sourceId), "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([Buffer.from([0x02]), nonce, ct, tag]));
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "src_1",
    workspace_id: "ws_1",
    name: "My Source",
    secret_token_hash: "hash_abc",
    status: "active" as const,
    max_body_bytes: null,
    max_body_depth: null,
    max_events_per_minute: null,
    field_selection: null,
    provider: "custom",
    signing_secret_ciphertext: null,
    signing_secret_previous_ciphertext: null,
    redact_paths: null,
    ordering_enabled: false,
    ordering_key_header: null,
    ordering_key_path: null,
    subject_key_paths: null,
    inbound_ip_allowlist: null,
    ...overrides,
  };
}

describe("source-lookup-pg — edge signing-secret decryption (matches dashboard encrypt)", () => {
  it("round-trips a LEGACY v1 (no-AAD) blob — back-compat for rows written before AAD", async () => {
    const blob = encryptBlob("whsec_supersecret", HEX_KEY);
    expect(await decryptSourceSigningSecretEdge(HEX_KEY, blob, "ws_1", "src_1")).toBe("whsec_supersecret");
  });

  it("round-trips a v1 blob with the sha256-fallback key form", async () => {
    const raw = "not-a-hex-or-base64-key";
    const blob = encryptBlob("whsec_devkey", raw);
    expect(await decryptSourceSigningSecretEdge(raw, blob, "ws_1", "src_1")).toBe("whsec_devkey");
  });

  it("round-trips a v2 AAD-bound blob when (workspace, source) match", async () => {
    const blob = encryptBlobV2("whsec_v2", HEX_KEY, "ws_1", "src_1");
    expect(await decryptSourceSigningSecretEdge(HEX_KEY, blob, "ws_1", "src_1")).toBe("whsec_v2");
  });

  it("REJECTS a v2 blob transplanted onto a different source (AAD mismatch)", async () => {
    const blob = encryptBlobV2("whsec_v2", HEX_KEY, "ws_1", "src_1");
    // Same key, but decrypting as a different source must fail GCM auth — this is
    // the whole point of AAD binding (a copied ciphertext can't be reused).
    await expect(decryptSourceSigningSecretEdge(HEX_KEY, blob, "ws_1", "src_OTHER")).rejects.toThrow();
    await expect(decryptSourceSigningSecretEdge(HEX_KEY, blob, "ws_OTHER", "src_1")).rejects.toThrow();
  });

  it("rejects a too-short blob", async () => {
    await expect(decryptSourceSigningSecretEdge(HEX_KEY, new Uint8Array(8), "ws_1", "src_1")).rejects.toThrow(/too short/);
  });
});

describe("source-lookup-pg — mapSourceRow (matches dashboard rowToEdgePayload)", () => {
  it("maps secret_token from the hash and decrypts the signing secret", async () => {
    const blob = encryptBlob("whsec_1", HEX_KEY);
    const src = await mapSourceRow(row({ provider: "stripe", signing_secret_ciphertext: blob }), HEX_KEY);
    expect(src.source_id).toBe("src_1");
    expect(src.secret_token).toBe("hash_abc"); // hot path compares against the hash
    expect(src.provider).toBe("stripe");
    expect(src.signing_secret).toBe("whsec_1");
  });

  it("omits signing_secret when there is no ciphertext", async () => {
    const src = await mapSourceRow(row(), HEX_KEY);
    expect(src.signing_secret).toBeUndefined();
  });

  it("FAILS CLOSED (throws) when a signing secret exists but the master key is absent", async () => {
    // Must NOT return a source with an omitted secret — the ingest gate would
    // then skip HMAC verification and accept spoofed webhooks.
    const blob = encryptBlob("whsec_1", HEX_KEY);
    await expect(mapSourceRow(row({ signing_secret_ciphertext: blob }), undefined)).rejects.toThrow(
      /undecryptable|refusing to skip verification/,
    );
  });

  it("FAILS CLOSED (throws) on a decrypt failure rather than omitting the secret", async () => {
    const blob = encryptBlob("whsec_1", HEX_KEY);
    const wrongKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await expect(mapSourceRow(row({ signing_secret_ciphertext: blob }), wrongKey)).rejects.toThrow(
      /undecryptable|refusing to skip verification/,
    );
  });

  it("FAILS CLOSED for a configured custom-HMAC source when only the previous secret is corrupt", async () => {
    await expect(mapSourceRow(row({
      provider: "custom",
      signing_secret_previous_ciphertext: new Uint8Array(8),
    }), HEX_KEY)).rejects.toThrow(/previous signing secret.*undecryptable|refusing to skip verification/);
  });

  it("FAILS CLOSED on a partial rotation instead of accepting only the current secret", async () => {
    const current = encryptBlob("whsec_current", HEX_KEY);
    await expect(mapSourceRow(row({
      provider: "stripe",
      signing_secret_ciphertext: current,
      signing_secret_previous_ciphertext: new Uint8Array(8),
    }), HEX_KEY)).rejects.toThrow(/previous signing secret.*undecryptable|refusing to skip verification/);
  });

  it("FAILS CLOSED when a configured ciphertext decrypts to an empty secret", async () => {
    const empty = encryptBlob("", HEX_KEY);
    await expect(mapSourceRow(row({
      provider: "custom",
      signing_secret_ciphertext: empty,
    }), HEX_KEY)).rejects.toThrow(/current signing secret.*undecryptable|refusing to skip verification/);
  });

  it("propagates redact_paths, signing_secret_previous, and ordering (Theme A — were dropped)", async () => {
    const prev = encryptBlob("whsec_old", HEX_KEY);
    const src = await mapSourceRow(
      row({
        signing_secret_previous_ciphertext: prev,
        redact_paths: ["user.email", "card.number"],
        ordering_enabled: true,
        ordering_key_header: "X-Order-Key",
      }),
      HEX_KEY,
    );
    expect(src.redact_paths).toEqual(["user.email", "card.number"]);
    expect(src.signing_secret_previous).toBe("whsec_old"); // rotation overlap works
    expect(src.ordering_enabled).toBe(true);
    expect(src.ordering_key_header).toBe("X-Order-Key");
  });

  it("includes optional caps, field selection, and ip allowlist only when present", async () => {
    const src = await mapSourceRow(
      row({
        max_body_bytes: 2048,
        field_selection: ["customer.id"],
        inbound_ip_allowlist: ["10.0.0.0/8"],
      }),
      HEX_KEY,
    );
    expect(src.max_body_bytes).toBe(2048);
    expect(src.max_body_depth).toBeUndefined();
    expect(src.field_selection).toEqual(["customer.id"]);
    expect(src.inbound_ip_allowlist).toEqual(["10.0.0.0/8"]);
  });
});
