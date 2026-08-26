import { describe, expect, it } from "vitest";
import { credentialColumnGoldenVectors } from "@axel/shared/credential-test-vectors";
import { decryptCredentialBlob, type CredentialRow } from "../src/index.ts";

/**
 * GOLDEN VECTORS — frozen ciphertexts produced by the dashboard's
 * encryptCredential path. If one of these fails, delivery-edge can no
 * longer decrypt existing destination_credentials rows. Fix the code,
 * never the vector.
 *
 * delivery-edge rebuilds the AAD from the row's (workspace_id,
 * destination_id), so only destination-bound v2 vectors and v1 (no-AAD)
 * vectors are decryptable here.
 */
function rowFor(v: (typeof credentialColumnGoldenVectors)[number], workspaceId: string, destinationId: string): CredentialRow {
  return {
    ciphertext: new Uint8Array(Buffer.from(v.ciphertextHex, "hex")),
    nonce: new Uint8Array(Buffer.from(v.nonceHex, "hex")),
    auth_tag: new Uint8Array(Buffer.from(v.authTagHex, "hex")),
    encryption_version: v.encryptionVersion,
    workspace_id: workspaceId,
    destination_id: destinationId,
  };
}

describe("delivery-edge — golden credential vectors", () => {
  it("decrypts the v1 (legacy, no-AAD) vector regardless of row identity", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v1-legacy-no-aad")!;
    expect(await decryptCredentialBlob(v.keyHex, rowFor(v, "ws_any", "dest_any"))).toBe(v.plaintext);
  });

  it("decrypts the v2 destination-bound vector with its matching row identity", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    expect(await decryptCredentialBlob(v.keyHex, rowFor(v, "ws_gold", "dest_gold"))).toBe(v.plaintext);
  });

  it("decrypts the unicode-plaintext v2 vector (UTF-8 handling)", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-unicode-plaintext")!;
    expect(await decryptCredentialBlob(v.keyHex, rowFor(v, "ws_gold", "dest_unicode"))).toBe(v.plaintext);
  });

  it("rejects the v2 vector when the row identity differs (transplanted row)", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    await expect(decryptCredentialBlob(v.keyHex, rowFor(v, "ws_OTHER", "dest_gold"))).rejects.toThrow();
  });

  it("rejects a pull-source-bound v2 blob (cross-type transplant)", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-pull-source-aad")!;
    await expect(decryptCredentialBlob(v.keyHex, rowFor(v, "ws_gold", "src_gold"))).rejects.toThrow();
  });
});
