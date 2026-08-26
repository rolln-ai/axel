import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptCredentialBlob, loadCredentialsMasterKey } from "../src/credentials.ts";

describe("delivery-service credentials", () => {
  const prior = process.env.CREDENTIALS_MASTER_KEY;

  afterEach(() => {
    if (prior === undefined) {
      delete process.env.CREDENTIALS_MASTER_KEY;
    } else {
      process.env.CREDENTIALS_MASTER_KEY = prior;
    }
  });

  it("loads a valid 32-byte hex master key", () => {
    process.env.CREDENTIALS_MASTER_KEY = "a".repeat(64);

    const key = loadCredentialsMasterKey();

    expect(key?.byteLength).toBe(32);
    expect(key?.toString("hex")).toBe("a".repeat(64));
  });

  it("rejects malformed master keys", () => {
    process.env.CREDENTIALS_MASTER_KEY = "not-hex";

    expect(() => loadCredentialsMasterKey()).toThrow("64 hex characters");
  });

  it("decrypts dashboard-compatible AES-256-GCM credential blobs", async () => {
    const masterKey = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = JSON.stringify({ connection_string: "postgres://user:pass@host/db" });
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const auth_tag = cipher.getAuthTag();

    expect(await decryptCredentialBlob(masterKey, { ciphertext, nonce, auth_tag })).toBe(plaintext);
  });
});
