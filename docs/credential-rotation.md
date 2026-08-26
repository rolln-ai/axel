# Credential Rotation

## Credentials Master Key

`CREDENTIALS_MASTER_KEY` is shared by dashboard, delivery-edge, and
delivery-service. It decrypts destination credentials, so rotate carefully.

Current storage uses AES-256-GCM under one master key. Until envelope
encryption is introduced, rotation is a maintenance operation.

## Rotation Plan

1. Freeze destination credential writes.
2. Add support for `CREDENTIALS_MASTER_KEY_PREVIOUS` and dual-read/new-write
   behavior.
3. Deploy dashboard, delivery-edge, and delivery-service.
4. Re-encrypt all credential rows with the new key.
5. Verify delivery to each credential-backed destination type.
6. Remove the previous key from every runtime.

## Emergency Rotation

If the key is suspected compromised:

1. Disable credential-backed deliveries if exposure risk is active.
2. Rotate the master key.
3. Force customers to rotate destination credentials.
4. Audit `destination_credentials` and credential read logs.

Track the work privately with the maintainers.
