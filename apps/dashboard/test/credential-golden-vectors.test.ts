import { afterAll, describe, expect, it } from "vitest";
import {
  credentialColumnGoldenVectors,
  packedCredentialGoldenVectors,
} from "@axel/shared/credential-test-vectors";
import { decryptCredentialBlob } from "../lib/credentials";
import { decryptSourceSigningSecret } from "../lib/source-secret";

/**
 * GOLDEN VECTORS — frozen ciphertexts produced by the platform's encrypt
 * paths (this app IS the encrypt side). If one of these fails, the dashboard
 * can no longer decrypt existing stored blobs. Fix the code, never the vector.
 *
 * The dashboard loads its master key from CREDENTIALS_MASTER_KEY lazily at
 * call time, so each test pins the env var to the vector's key form first.
 */
const priorKey = process.env.CREDENTIALS_MASTER_KEY;
afterAll(() => {
  if (priorKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
  else process.env.CREDENTIALS_MASTER_KEY = priorKey;
});

describe("dashboard — golden credential vectors (column envelope)", () => {
  for (const v of credentialColumnGoldenVectors) {
    it(`decrypts column vector ${v.name}`, async () => {
      process.env.CREDENTIALS_MASTER_KEY = v.keyHex;
      const plaintext = await decryptCredentialBlob(
        {
          ciphertext: Buffer.from(v.ciphertextHex, "hex"),
          nonce: Buffer.from(v.nonceHex, "hex"),
          auth_tag: Buffer.from(v.authTagHex, "hex"),
          encryption_version: v.encryptionVersion,
        },
        v.aad !== null ? Buffer.from(v.aad, "utf8") : undefined,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("rejects a v2 vector opened with the wrong AAD", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    process.env.CREDENTIALS_MASTER_KEY = v.keyHex;
    await expect(
      Promise.resolve().then(() =>
        decryptCredentialBlob(
          {
            ciphertext: Buffer.from(v.ciphertextHex, "hex"),
            nonce: Buffer.from(v.nonceHex, "hex"),
            auth_tag: Buffer.from(v.authTagHex, "hex"),
            encryption_version: v.encryptionVersion,
          },
          Buffer.from("axel:cred:v2:ws_other:dest_gold", "utf8"),
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("dashboard — golden signing-secret vectors (packed envelope)", () => {
  for (const v of packedCredentialGoldenVectors) {
    it(`decrypts packed vector ${v.name} (key form: ${v.masterKeyRaw === v.keyHex ? "hex" : "derived"})`, async () => {
      // masterKeyRaw exercises the flexible hex/base64/sha256 derivation.
      process.env.CREDENTIALS_MASTER_KEY = v.masterKeyRaw;
      const plaintext = await decryptSourceSigningSecret(
        Buffer.from(v.blobHex, "hex"),
        v.workspaceId,
        v.sourceId,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("rejects a v2 packed vector transplanted onto another source", async () => {
    const v = packedCredentialGoldenVectors.find((x) => x.name === "b-v2-srcsign")!;
    process.env.CREDENTIALS_MASTER_KEY = v.masterKeyRaw;
    await expect(
      Promise.resolve().then(() =>
        decryptSourceSigningSecret(Buffer.from(v.blobHex, "hex"), v.workspaceId, "src_OTHER"),
      ),
    ).rejects.toThrow();
  });
});
