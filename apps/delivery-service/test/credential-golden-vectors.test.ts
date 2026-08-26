import { describe, expect, it } from "vitest";
import {
  credentialColumnGoldenVectors,
  packedCredentialGoldenVectors,
} from "@axel/shared/credential-test-vectors";
import { decryptCredentialBlob } from "../src/credentials.ts";
import { decryptSourceSigningSecret } from "../src/internal-source.ts";

/**
 * GOLDEN VECTORS — frozen ciphertexts produced by the platform's encrypt
 * paths. If one of these fails, this runtime can no longer decrypt existing
 * stored credential blobs. Fix the code, never the vector.
 */
describe("delivery-service — golden credential vectors", () => {
  for (const v of credentialColumnGoldenVectors) {
    it(`decrypts column vector ${v.name}`, async () => {
      const plaintext = await decryptCredentialBlob(
        Buffer.from(v.keyHex, "hex"),
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

  it("rejects a v2 column vector opened with the wrong AAD", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    await expect(
      Promise.resolve().then(() =>
        decryptCredentialBlob(
          Buffer.from(v.keyHex, "hex"),
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

  for (const v of packedCredentialGoldenVectors) {
    it(`decrypts packed signing-secret vector ${v.name}`, async () => {
      const plaintext = await decryptSourceSigningSecret(
        Buffer.from(v.keyHex, "hex"),
        Buffer.from(v.blobHex, "hex"),
        v.workspaceId,
        v.sourceId,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("rejects a v2 packed vector transplanted onto another source", async () => {
    const v = packedCredentialGoldenVectors.find((x) => x.name === "b-v2-srcsign")!;
    await expect(
      Promise.resolve().then(() =>
        decryptSourceSigningSecret(
          Buffer.from(v.keyHex, "hex"),
          Buffer.from(v.blobHex, "hex"),
          v.workspaceId,
          "src_OTHER",
        ),
      ),
    ).rejects.toThrow();
  });
});
