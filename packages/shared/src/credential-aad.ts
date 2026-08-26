/**
 * Additional-authenticated-data (AAD) for AES-256-GCM credential encryption.
 *
 * Binding a credential ciphertext to its row identity means a blob copied to
 * another workspace/destination row fails GCM authentication on decrypt — so a
 * leaked/copied row can't be reused out of context. These builders live in one
 * place so all four decrypt runtimes (dashboard, delivery-service,
 * delivery-edge Web-Crypto, pull-worker) produce BYTE-IDENTICAL AAD; any
 * divergence would make a v2 blob undecryptable on that path.
 *
 * Returned as a string; each caller wraps it for its runtime (Node Buffer or
 * Web-Crypto Uint8Array). Destination and pull-source credentials use distinct
 * prefixes so the two are not interchangeable.
 */

export function credentialAadString(workspaceId: string, destinationId: string): string {
  return `axel:cred:v2:${workspaceId}:${destinationId}`;
}

export function pullSourceCredentialAadString(workspaceId: string, sourceId: string): string {
  return `axel:pullcred:v2:${workspaceId}:${sourceId}`;
}

/**
 * Inbound provider signing-secret AAD — binds the ciphertext to (workspace,
 * source). Must match BYTE-FOR-BYTE across the dashboard (Node, source-secret.ts)
 * and the ingest edge (Web-Crypto, source-lookup-pg.ts), the two runtimes that
 * encrypt/decrypt these blobs. Distinct prefix so a signing-secret blob can't be
 * transplanted onto a destination/pull-source row (or another source) and still
 * authenticate.
 */
export function sourceSigningSecretAadString(workspaceId: string, sourceId: string): string {
  return `axel:srcsign:v2:${workspaceId}:${sourceId}`;
}
