import { createCipheriv, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSourceSigningSecret, encryptSourceSigningSecret } from "../lib/source-secret";

// Deterministic 32-byte dummy key for unit tests only — not a real secret. gitleaks:allow
const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // gitleaks:allow

// Build a legacy v1 blob exactly as the pre-AAD code did: [nonce | ct | tag],
// no version byte, no AAD.
function legacyV1Blob(plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

describe("source signing-secret encryption (AAD-bound to workspace+source)", () => {
  const prev = process.env.CREDENTIALS_MASTER_KEY;
  beforeAll(() => {
    process.env.CREDENTIALS_MASTER_KEY = KEY;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
    else process.env.CREDENTIALS_MASTER_KEY = prev;
  });

  it("emits a v2 (0x02-prefixed) blob and round-trips when workspace+source match", async () => {
    const { ciphertext } = await encryptSourceSigningSecret("whsec_abc", "ws_1", "src_1");
    expect(ciphertext[0]).toBe(0x02);
    expect(await decryptSourceSigningSecret(ciphertext, "ws_1", "src_1")).toBe("whsec_abc");
  });

  it("REJECTS a ciphertext transplanted onto a different source/workspace (AAD mismatch)", async () => {
    const { ciphertext } = await encryptSourceSigningSecret("whsec_abc", "ws_1", "src_1");
    await expect(decryptSourceSigningSecret(ciphertext, "ws_1", "src_OTHER")).rejects.toThrow();
    await expect(decryptSourceSigningSecret(ciphertext, "ws_OTHER", "src_1")).rejects.toThrow();
  });

  it("still decrypts a legacy v1 (no-AAD) blob for back-compat", async () => {
    const v1 = legacyV1Blob("whsec_legacy");
    expect(await decryptSourceSigningSecret(v1, "ws_1", "src_1")).toBe("whsec_legacy");
  });

  it("the fingerprint is stable and independent of the binding", async () => {
    const a = await encryptSourceSigningSecret("whsec_abc", "ws_1", "src_1");
    const b = await encryptSourceSigningSecret("whsec_abc", "ws_2", "src_2");
    expect(a.fingerprint).toBe(b.fingerprint); // same plaintext → same fingerprint
    // but the ciphertexts differ (distinct nonce + AAD) and aren't cross-decryptable
    await expect(decryptSourceSigningSecret(a.ciphertext, "ws_2", "src_2")).rejects.toThrow();
  });
});
