import { describe, expect, it } from "vitest";
import { packedCredentialGoldenVectors } from "@axel/shared/credential-test-vectors";
import { decryptSourceSigningSecretEdge } from "../src/source-lookup-pg.js";

/**
 * GOLDEN VECTORS — frozen ciphertexts produced by the dashboard's
 * encryptSourceSigningSecret path (and its pre-AAD v1 predecessor). If one
 * of these fails, ingest can no longer decrypt existing
 * sources.signing_secret_ciphertext blobs — which fails CLOSED and 503s
 * ingest for those sources. Fix the code, never the vector.
 *
 * masterKeyRaw exercises all three flexible key-derivation branches
 * (hex64 / base64-44 / sha256-of-anything).
 */
describe("ingest-worker — golden signing-secret vectors", () => {
  for (const v of packedCredentialGoldenVectors) {
    it(`decrypts packed vector ${v.name}`, async () => {
      const plaintext = await decryptSourceSigningSecretEdge(
        v.masterKeyRaw,
        new Uint8Array(Buffer.from(v.blobHex, "hex")),
        v.workspaceId,
        v.sourceId,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("rejects a v2 packed vector transplanted onto another source/workspace", async () => {
    const v = packedCredentialGoldenVectors.find((x) => x.name === "b-v2-srcsign")!;
    const blob = new Uint8Array(Buffer.from(v.blobHex, "hex"));
    await expect(decryptSourceSigningSecretEdge(v.masterKeyRaw, blob, v.workspaceId, "src_OTHER")).rejects.toThrow();
    await expect(decryptSourceSigningSecretEdge(v.masterKeyRaw, blob, "ws_OTHER", v.sourceId)).rejects.toThrow();
  });
});
