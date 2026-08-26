import { describe, expect, it } from "vitest";
import { credentialColumnGoldenVectors } from "@axel/shared/credential-test-vectors";
import { decryptCredentialBlob, type CredentialRow } from "../src/index";

/**
 * GOLDEN VECTORS — frozen ciphertexts produced by the dashboard's
 * encryptCredential path. If one of these fails, the pull-worker can no
 * longer decrypt existing pull_source_credentials rows. Fix the code,
 * never the vector.
 *
 * The pull-worker rebuilds the AAD from the row's (workspace_id,
 * pull_source_id), so only pull-source-bound v2 vectors and v1 (no-AAD)
 * vectors are decryptable here.
 */
function rowFor(v: (typeof credentialColumnGoldenVectors)[number], workspaceId: string, pullSourceId: string): CredentialRow {
  return {
    ciphertext: Buffer.from(v.ciphertextHex, "hex"),
    nonce: Buffer.from(v.nonceHex, "hex"),
    auth_tag: Buffer.from(v.authTagHex, "hex"),
    encryption_version: v.encryptionVersion,
    workspace_id: workspaceId,
    pull_source_id: pullSourceId,
  };
}

describe("pull-worker — golden credential vectors", () => {
  it("decrypts the v1 (legacy, no-AAD) vector regardless of row identity", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v1-legacy-no-aad")!;
    const plaintext = await decryptCredentialBlob(
      Buffer.from(v.keyHex, "hex"),
      rowFor(v, "ws_any", "src_any"),
    );
    expect(plaintext).toBe(v.plaintext);
  });

  it("decrypts the v2 pull-source-bound vector with its matching row identity", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-pull-source-aad")!;
    const plaintext = await decryptCredentialBlob(
      Buffer.from(v.keyHex, "hex"),
      rowFor(v, "ws_gold", "src_gold"),
    );
    expect(plaintext).toBe(v.plaintext);
  });

  it("rejects the v2 vector when the row identity differs (transplanted row)", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-pull-source-aad")!;
    await expect(
      Promise.resolve().then(() =>
        decryptCredentialBlob(Buffer.from(v.keyHex, "hex"), rowFor(v, "ws_gold", "src_OTHER")),
      ),
    ).rejects.toThrow();
  });

  it("rejects a destination-bound v2 blob (cross-type transplant)", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    await expect(
      Promise.resolve().then(() =>
        decryptCredentialBlob(Buffer.from(v.keyHex, "hex"), rowFor(v, "ws_gold", "dest_gold")),
      ),
    ).rejects.toThrow();
  });
});
