import { decryptCredentialV2, parseHexMasterKey, type CredentialColumnsBlob } from "@axel/shared";

/**
 * Decrypt a destination credential blob produced by the dashboard's
 * `encryptCredential` helper, via the shared AES-256-GCM core
 * (@axel/shared credential-crypto — golden-vector pinned). Same master key
 * (`CREDENTIALS_MASTER_KEY` env, 64 hex chars, strict — unchanged).
 *
 * Why a separate file from server.ts: keeps the crypto path testable in
 * isolation and matches the layout of the delivery-edge counterpart.
 */
export type CredentialBlob = CredentialColumnsBlob & {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
};

export function loadCredentialsMasterKey(): Buffer | null {
  const hex = process.env.CREDENTIALS_MASTER_KEY;
  if (!hex) return null;
  return Buffer.from(parseHexMasterKey(hex));
}

export function decryptCredentialBlob(masterKey: Buffer, blob: CredentialBlob, aad?: Buffer): Promise<string> {
  // v2 blobs were sealed with AAD and must be opened with the same AAD; v1
  // (legacy) blobs have none. A mismatched/missing AAD fails the auth tag.
  return decryptCredentialV2(blob, masterKey, aad);
}
