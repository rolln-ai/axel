/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate: node test/fixtures/generate-credential-golden-vectors.mjs
 * (from packages/shared, after building dist).
 *
 * Golden vectors pinning the AES-256-GCM credential envelopes used across
 * the platform. If a change to any decrypt path makes one of these vectors
 * fail, that change would make EXISTING stored credential blobs
 * undecryptable on that runtime — do not "fix" the vector; fix the code.
 *
 * All key material here is deterministic test data, never a real secret.
 * Exported via the "@axel/shared/credential-test-vectors" subpath so every
 * app's test suite can pin its own decrypt entry point against the same
 * frozen bytes. Not part of the runtime API.
 */

/** Family A: ciphertext/nonce/auth_tag stored as separate columns + encryption_version. */
export interface CredentialColumnGoldenVector {
  name: string;
  plaintext: string;
  keyHex: string;
  /** 1 = legacy, sealed without AAD; 2 = AAD-bound. */
  encryptionVersion: 1 | 2;
  /** The exact AAD string the blob was sealed with (null for v1). */
  aad: string | null;
  nonceHex: string;
  ciphertextHex: string;
  authTagHex: string;
}

/** Family B: one self-contained blob — v2 [0x02|nonce|ct|tag] w/ AAD, v1 [nonce|ct|tag] no AAD. */
export interface PackedCredentialGoldenVector {
  name: string;
  plaintext: string;
  keyHex: string;
  /** Raw CREDENTIALS_MASTER_KEY env form (hex / base64 / passphrase) for flexible-derivation decrypters. */
  masterKeyRaw: string;
  layout: "v1" | "v2";
  workspaceId: string;
  sourceId: string;
  aad: string | null;
  blobHex: string;
}

/** Flexible master-key derivation: raw env string -> expected 32-byte key. */
export interface MasterKeyGoldenVector {
  form: "hex" | "base64" | "sha256-passphrase";
  raw: string;
  keyHex: string;
}

export const credentialColumnGoldenVectors: CredentialColumnGoldenVector[] = [
  {
    "name": "a-v1-legacy-no-aad",
    "plaintext": "{\"connection_string\":\"postgres://gold:v1@db.example/axel\"}",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "encryptionVersion": 1,
    "aad": null,
    "nonceHex": "b4888765b3c7099986e1f45d",
    "ciphertextHex": "0138c22adc231a62ce58a1604b8efb84a88c2dee53e943002976bf38b4914c20ec23ba324985a03f4f7d7c54aca4dd645b77d33f5328bdd540b4",
    "authTagHex": "a13016a8f5af0da3ce97668ddecb56b9"
  },
  {
    "name": "a-v2-destination-aad",
    "plaintext": "{\"connection_string\":\"postgres://gold:v2@db.example/axel\",\"token\":\"shh-gold\"}",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "encryptionVersion": 2,
    "aad": "axel:cred:v2:ws_gold:dest_gold",
    "nonceHex": "f4ae4ec0c4d766c017780704",
    "ciphertextHex": "520807b9b3fff337d0a637d82ca8316fc5a455401fc049fc777ad649870f24b5e8317a32d1ee27a90187f533a34d067e7d568a8a0e94c4805affd9f3a6747c8d3923b24a4380c9cc0891169d9f",
    "authTagHex": "83a52fa211f82f32d0bf7814a3fbb0ac"
  },
  {
    "name": "a-v2-pull-source-aad",
    "plaintext": "{\"api_key\":\"pull-gold-key\",\"ingest_token\":\"tok_gold\"}",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "encryptionVersion": 2,
    "aad": "axel:pullcred:v2:ws_gold:src_gold",
    "nonceHex": "2730ad701b88ce1488d63730",
    "ciphertextHex": "e093b0deeb944b6df3e4a46b83dfa6a545d1f7d6345f6269f4c23d64ac6f19c6c76cee4fbecefeffe2c382c99d4d7371bd8e70e738",
    "authTagHex": "50519c0f3fde31e96758a98862b238f5"
  },
  {
    "name": "a-v2-unicode-plaintext",
    "plaintext": "{\"token\":\"tök€n-π-🔑\"}",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "encryptionVersion": 2,
    "aad": "axel:cred:v2:ws_gold:dest_unicode",
    "nonceHex": "08077e5eba2e61304c868683",
    "ciphertextHex": "1532f16a0658e2c8be777cee7fd3da286af8d5aa4ff87b686c168cab",
    "authTagHex": "e0e543e0e2007956e7f134184fcccffa"
  }
];

/** (workspace, id) contexts to rebuild v2 AADs via the shared builders. */
export const credentialColumnAadContexts: Record<
  string,
  { kind: "destination" | "pull-source"; workspaceId: string; id: string }
> = {
  "a-v2-destination-aad": {
    "kind": "destination",
    "workspaceId": "ws_gold",
    "id": "dest_gold"
  },
  "a-v2-pull-source-aad": {
    "kind": "pull-source",
    "workspaceId": "ws_gold",
    "id": "src_gold"
  },
  "a-v2-unicode-plaintext": {
    "kind": "destination",
    "workspaceId": "ws_gold",
    "id": "dest_unicode"
  }
};

export const packedCredentialGoldenVectors: PackedCredentialGoldenVector[] = [
  {
    "name": "b-v2-srcsign",
    "plaintext": "whsec_golden_v2_secret",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "masterKeyRaw": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "layout": "v2",
    "workspaceId": "ws_gold",
    "sourceId": "src_gold",
    "aad": "axel:srcsign:v2:ws_gold:src_gold",
    "blobHex": "02df8a878d86fd4cbea41f88164df3f32366ecd7406447f95b955ed0f706aa39391565ec3f53918b9f046f4357e5c1577ba5b6"
  },
  {
    "name": "b-v1-legacy",
    "plaintext": "whsec_golden_v1_legacy",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "masterKeyRaw": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "layout": "v1",
    "workspaceId": "ws_gold",
    "sourceId": "src_gold",
    "aad": null,
    "blobHex": "f0a9ce9f4c38f1477f84f5124931981162f1fa83e1faf80e3b1bc7bd2e67bf687291757ecf1e60b60751a47b5763aff2bbd6"
  },
  {
    "name": "b-v1-nonce-02",
    "plaintext": "whsec_ambiguous_nonce",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "masterKeyRaw": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "layout": "v1",
    "workspaceId": "ws_gold",
    "sourceId": "src_gold",
    "aad": null,
    "blobHex": "02563755d286b75d0447732294c4f271f0c2c5bb30b23b8f94a62173b6c9074579bf3066b609660ff6081095288a318af7"
  },
  {
    "name": "b-v2-base64-key",
    "plaintext": "whsec_base64_key_form",
    "keyHex": "0f72782058e7b92507ea9b5237bc164d82c61b318af6790c1ebf74021615b63b",
    "masterKeyRaw": "D3J4IFjnuSUH6ptSN7wWTYLGGzGK9nkMHr90AhYVtjs=",
    "layout": "v2",
    "workspaceId": "ws_gold",
    "sourceId": "src_b64",
    "aad": "axel:srcsign:v2:ws_gold:src_b64",
    "blobHex": "02aa0823a33da83881186358c27933fdb8164770acea96554bab3b1be0670b38623b4c09a03ca3db8547dc77e1699aea10fb"
  },
  {
    "name": "b-v2-passphrase-key",
    "plaintext": "whsec_passphrase_key_form",
    "keyHex": "df07672b1610e57b06aaa1ffe7d4512ffbf9fc713271372e284de9c9969cd7ab",
    "masterKeyRaw": "axel-golden-passphrase (test only, not a real secret)",
    "layout": "v2",
    "workspaceId": "ws_gold",
    "sourceId": "src_pass",
    "aad": "axel:srcsign:v2:ws_gold:src_pass",
    "blobHex": "027e112d01ee67827b90b4ce585492d16c1bc5144b4a5ef25a6df2541c462d98cbea8b1cc26dafef54bca379ac6d9e4b64646df24b94"
  }
];

export const masterKeyGoldenVectors: MasterKeyGoldenVector[] = [
  {
    "form": "hex",
    "raw": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8",
    "keyHex": "ef5dd08e500d24517a59e19f86f96c5449b9137bef4db2e1bcdeb54eaef239e8"
  },
  {
    "form": "base64",
    "raw": "D3J4IFjnuSUH6ptSN7wWTYLGGzGK9nkMHr90AhYVtjs=",
    "keyHex": "0f72782058e7b92507ea9b5237bc164d82c61b318af6790c1ebf74021615b63b"
  },
  {
    "form": "sha256-passphrase",
    "raw": "axel-golden-passphrase (test only, not a real secret)",
    "keyHex": "df07672b1610e57b06aaa1ffe7d4512ffbf9fc713271372e284de9c9969cd7ab"
  }
];
