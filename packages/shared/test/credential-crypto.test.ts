import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCredentialV2,
  decryptPackedCredential,
  deriveFlexibleMasterKey,
  encryptCredentialV2,
  encryptPackedCredential,
  parseHexMasterKey,
} from "../src/credential-crypto.ts";
import {
  credentialAadString,
  pullSourceCredentialAadString,
  sourceSigningSecretAadString,
} from "../src/credential-aad.ts";
import {
  credentialColumnAadContexts,
  credentialColumnGoldenVectors,
  masterKeyGoldenVectors,
  packedCredentialGoldenVectors,
} from "../src/credential-test-vectors.ts";

const KEY = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"); // test only, gitleaks:allow

// ---- golden vectors: the shared core must decrypt every historical blob --- //

describe("credential-crypto — golden column vectors (Family A)", () => {
  for (const v of credentialColumnGoldenVectors) {
    it(`decrypts ${v.name}`, async () => {
      const plaintext = await decryptCredentialV2(
        {
          ciphertext: Buffer.from(v.ciphertextHex, "hex"),
          nonce: Buffer.from(v.nonceHex, "hex"),
          auth_tag: Buffer.from(v.authTagHex, "hex"),
          encryption_version: v.encryptionVersion,
        },
        Buffer.from(v.keyHex, "hex"),
        v.aad ?? undefined,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("the shared AAD builders still produce the exact frozen AAD strings", () => {
    for (const [name, ctx] of Object.entries(credentialColumnAadContexts)) {
      const v = credentialColumnGoldenVectors.find((x) => x.name === name)!;
      const rebuilt =
        ctx.kind === "destination"
          ? credentialAadString(ctx.workspaceId, ctx.id)
          : pullSourceCredentialAadString(ctx.workspaceId, ctx.id);
      expect(rebuilt).toBe(v.aad);
    }
  });

  it("rejects a v2 vector with the wrong AAD and with no AAD", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v2-destination-aad")!;
    const blob = {
      ciphertext: Buffer.from(v.ciphertextHex, "hex"),
      nonce: Buffer.from(v.nonceHex, "hex"),
      auth_tag: Buffer.from(v.authTagHex, "hex"),
      encryption_version: v.encryptionVersion,
    };
    const key = Buffer.from(v.keyHex, "hex");
    await expect(decryptCredentialV2(blob, key, credentialAadString("ws_other", "dest_gold"))).rejects.toThrow();
    await expect(decryptCredentialV2(blob, key)).rejects.toThrow(/requires its AAD context/);
  });

  it("a v1 vector decrypts even when an (ignored) AAD is passed — historical behavior", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v1-legacy-no-aad")!;
    const plaintext = await decryptCredentialV2(
      {
        ciphertext: Buffer.from(v.ciphertextHex, "hex"),
        nonce: Buffer.from(v.nonceHex, "hex"),
        auth_tag: Buffer.from(v.authTagHex, "hex"),
        encryption_version: 1,
      },
      Buffer.from(v.keyHex, "hex"),
      credentialAadString("ws_x", "dest_x"),
    );
    expect(plaintext).toBe(v.plaintext);
  });

  it("treats a missing encryption_version as v1", async () => {
    const v = credentialColumnGoldenVectors.find((x) => x.name === "a-v1-legacy-no-aad")!;
    const plaintext = await decryptCredentialV2(
      {
        ciphertext: Buffer.from(v.ciphertextHex, "hex"),
        nonce: Buffer.from(v.nonceHex, "hex"),
        auth_tag: Buffer.from(v.authTagHex, "hex"),
      },
      Buffer.from(v.keyHex, "hex"),
    );
    expect(plaintext).toBe(v.plaintext);
  });
});

describe("credential-crypto — golden packed vectors (Family B)", () => {
  for (const v of packedCredentialGoldenVectors) {
    it(`decrypts ${v.name}`, async () => {
      const aad = sourceSigningSecretAadString(v.workspaceId, v.sourceId);
      if (v.layout === "v2") expect(aad).toBe(v.aad); // builders still match the frozen AAD
      const plaintext = await decryptPackedCredential(
        Buffer.from(v.blobHex, "hex"),
        Buffer.from(v.keyHex, "hex"),
        aad,
      );
      expect(plaintext).toBe(v.plaintext);
    });
  }

  it("rejects a transplanted v2 packed blob (wrong workspace or source)", async () => {
    const v = packedCredentialGoldenVectors.find((x) => x.name === "b-v2-srcsign")!;
    const blob = Buffer.from(v.blobHex, "hex");
    const key = Buffer.from(v.keyHex, "hex");
    await expect(
      decryptPackedCredential(blob, key, sourceSigningSecretAadString(v.workspaceId, "src_OTHER")),
    ).rejects.toThrow();
    await expect(
      decryptPackedCredential(blob, key, sourceSigningSecretAadString("ws_OTHER", v.sourceId)),
    ).rejects.toThrow();
  });

  it("rejects a too-short blob", async () => {
    await expect(decryptPackedCredential(new Uint8Array(8), KEY, "aad")).rejects.toThrow(/too short/);
  });
});

describe("credential-crypto — master-key derivation", () => {
  for (const v of masterKeyGoldenVectors) {
    it(`derives the ${v.form} form`, async () => {
      const key = await deriveFlexibleMasterKey(v.raw);
      expect(Buffer.from(key).toString("hex")).toBe(v.keyHex);
    });
  }

  it("parseHexMasterKey is strict: rejects non-hex, wrong length; accepts mixed case", () => {
    expect(() => parseHexMasterKey("not-hex")).toThrow(/64 hex characters/);
    expect(() => parseHexMasterKey("ab".repeat(31))).toThrow(/64 hex characters/);
    expect(() => parseHexMasterKey("zz".repeat(32))).toThrow(/64 hex characters/);
    const upper = "AB".repeat(32);
    expect(Buffer.from(parseHexMasterKey(upper)).toString("hex")).toBe("ab".repeat(32));
  });
});

// ---- cross-runtime interop: Web-Crypto core vs node:crypto ---------------- //
// The Node services historically used createDecipheriv/createCipheriv. Prove
// bytes written by either side open on the other, for both families.

function nodeEncryptColumns(plaintext: string, key: Buffer, aad: string | null) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, auth_tag: cipher.getAuthTag(), encryption_version: aad ? 2 : 1 };
}

function nodeDecryptColumns(
  blob: { ciphertext: Uint8Array; nonce: Uint8Array; auth_tag: Uint8Array; encryption_version: number },
  key: Buffer,
  aad: string | null,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  if (blob.encryption_version >= 2 && aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(blob.auth_tag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString("utf8");
}

describe("credential-crypto — cross-runtime interop", () => {
  const SECRET = JSON.stringify({ connection_string: "postgres://u:p@host/db", token: "tök€n" });

  it("node:crypto-sealed column blob (v1 and v2) opens via the shared core", async () => {
    const aad = credentialAadString("ws_1", "dest_1");
    const v2 = nodeEncryptColumns(SECRET, KEY, aad);
    expect(await decryptCredentialV2(v2, KEY, aad)).toBe(SECRET);
    const v1 = nodeEncryptColumns(SECRET, KEY, null);
    expect(await decryptCredentialV2(v1, KEY)).toBe(SECRET);
  });

  it("shared-core-sealed column blob opens via node:crypto (v1 and v2)", async () => {
    const aad = credentialAadString("ws_1", "dest_1");
    const v2 = await encryptCredentialV2(SECRET, KEY, aad);
    expect(v2.encryption_version).toBe(2);
    expect(nodeDecryptColumns(v2, KEY, aad)).toBe(SECRET);
    const v1 = await encryptCredentialV2(SECRET, KEY);
    expect(v1.encryption_version).toBe(1);
    expect(nodeDecryptColumns(v1, KEY, null)).toBe(SECRET);
  });

  it("shared-core packed blob is the exact v2 layout and round-trips both ways", async () => {
    const aad = sourceSigningSecretAadString("ws_1", "src_1");
    const blob = await encryptPackedCredential("whsec_roundtrip", KEY, aad);
    expect(blob[0]).toBe(0x02);
    expect(await decryptPackedCredential(blob, KEY, aad)).toBe("whsec_roundtrip");
    // node:crypto opens it too (delivery-service/dashboard historically did):
    const body = Buffer.from(blob.subarray(1));
    const decipher = createDecipheriv("aes-256-gcm", KEY, body.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([
      decipher.update(body.subarray(12, body.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    expect(plain).toBe("whsec_roundtrip");
  });

  it("packed v1 fallback: a legacy blob whose nonce begins 0x02 still decrypts", async () => {
    // Construct a v1 blob with nonce[0] forced to 0x02 (the version marker).
    const nonce = randomBytes(12);
    nonce[0] = 0x02;
    const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
    const ct = Buffer.concat([cipher.update("whsec_legacy_02", "utf8"), cipher.final()]);
    const blob = Buffer.concat([nonce, ct, cipher.getAuthTag()]);
    expect(await decryptPackedCredential(blob, KEY, sourceSigningSecretAadString("ws", "src"))).toBe(
      "whsec_legacy_02",
    );
  });

  it("rejects a wrong-length key", async () => {
    await expect(encryptCredentialV2("x", new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    await expect(
      decryptCredentialV2(
        { ciphertext: new Uint8Array(4), nonce: new Uint8Array(12), auth_tag: new Uint8Array(16) },
        new Uint8Array(31),
      ),
    ).rejects.toThrow(/32 bytes/);
  });
});
