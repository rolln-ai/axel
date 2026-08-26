import { describe, expect, it } from "vitest";
import { credentialAad, decryptCredentialBlob, encryptCredential, pullSourceCredentialAad } from "../lib/credentials";

// 64 hex chars = 32 bytes. loadMasterKey reads this lazily at call time.
process.env.CREDENTIALS_MASTER_KEY = "a".repeat(64);

const SECRET = JSON.stringify({ connection_string: "postgres://u:p@host/db", token: "shh-3a4f" });

describe("credential AAD binding", () => {
  it("v1 (no AAD) round-trips and stays version 1", async () => {
    const enc = await encryptCredential(SECRET);
    expect(enc.encryption_version).toBe(1);
    expect(await decryptCredentialBlob(enc)).toBe(SECRET);
  });

  it("v2 (AAD) round-trips with the matching context and is version 2", async () => {
    const aad = credentialAad("ws_1", "dest_1");
    const enc = await encryptCredential(SECRET, aad);
    expect(enc.encryption_version).toBe(2);
    expect(await decryptCredentialBlob(enc, aad)).toBe(SECRET);
  });

  it("rejects a v2 blob opened with the WRONG context (copied to another workspace/destination)", async () => {
    const enc = await encryptCredential(SECRET, credentialAad("ws_1", "dest_1"));
    await expect(decryptCredentialBlob(enc, credentialAad("ws_2", "dest_1"))).rejects.toThrow();
    await expect(decryptCredentialBlob(enc, credentialAad("ws_1", "dest_2"))).rejects.toThrow();
  });

  it("rejects a v2 blob opened with NO AAD", async () => {
    const enc = await encryptCredential(SECRET, credentialAad("ws_1", "dest_1"));
    await expect(decryptCredentialBlob(enc)).rejects.toThrow(/requires its AAD context/);
  });

  it("a v1 blob still decrypts without AAD (back-compat) even if an AAD is passed", async () => {
    const enc = await encryptCredential(SECRET); // v1
    expect(await decryptCredentialBlob(enc)).toBe(SECRET);
    // v1 decrypt ignores AAD (version < 2), so passing one is harmless.
    expect(await decryptCredentialBlob({ ...enc, encryption_version: 1 }, credentialAad("ws_1", "dest_1"))).toBe(SECRET);
  });

  it("pull-source credentials round-trip with their (workspace, source) AAD", async () => {
    const aad = pullSourceCredentialAad("ws_1", "src_1");
    const enc = await encryptCredential(SECRET, aad);
    expect(enc.encryption_version).toBe(2);
    expect(await decryptCredentialBlob(enc, aad)).toBe(SECRET);
  });

  it("a pull-source blob can't be opened with the destination context for the same ids (no cross-type transplant)", async () => {
    const enc = await encryptCredential(SECRET, pullSourceCredentialAad("ws_1", "x_1"));
    await expect(decryptCredentialBlob(enc, credentialAad("ws_1", "x_1"))).rejects.toThrow();
  });

  it("credentialAad is deterministic and distinct per (workspace, destination)", () => {
    expect(credentialAad("ws_1", "dest_1").equals(credentialAad("ws_1", "dest_1"))).toBe(true);
    expect(credentialAad("ws_1", "dest_1").equals(credentialAad("ws_1", "dest_2"))).toBe(false);
    expect(credentialAad("ws_1", "dest_1").equals(credentialAad("ws_2", "dest_1"))).toBe(false);
  });
});
