# Migrating existing webhook authentication

Custom sources use the `x-axel-token` header. Named providers must use their
configured signature or Basic authentication. For senders without custom headers,
use the separate opt-in [authenticated webhook URL](webhook-authentication.md).
Never append an ordinary header token to a new integration URL. A receiving
application cannot remove credentials from upstream URL logs.

Before removing a previously accepted credential format, inventory the active
senders and verify how each one authenticates. Deployments must compare real
per-source accepted traffic and delivery outcomes before and after the change.
A header-authenticated canary passing does not prove a legacy sender migrated.

## Temporary recovery for a custom source

The ingest worker rejects `?token=...` by default. An operator can grant a named
custom source a migration window of at most 72 hours using the
`LEGACY_QUERY_TOKEN_SOURCES` environment binding:

```json
{
  "src_existing": {
    "starts_at": "2026-01-01T00:00:00Z",
    "expires_at": "2026-01-03T00:00:00Z"
  }
}
```

The example dates are intentionally expired. Use UTC dates for the reviewed
recovery window and only the source IDs that need migration. The value contains
no credentials. Unlisted sources, expired windows, invalid configuration,
duplicate query tokens, and requests combining header and query credentials
remain rejected. A listed source must still be active, pass its normal token
hash check, IP restrictions and source-authority fencing, and complete durable
storage and queueing. This setting cannot replace a named provider's signature.

The token stays out of Axel's retained metadata. It can still appear in upstream
URL logs, which is why this is an explicit, temporary recovery measure.

For hosted deployments, store the reviewed JSON in the GitHub Production
environment's `LEGACY_QUERY_TOKEN_SOURCES` secret, then use **Sync Cloudflare
Runtime Secrets** for `ingest-worker` and the existing reviewed code-deployment
workflow. The sync defaults to `{}` when no value is configured. For self-hosting,
set the same binding on the ingest worker. Do not commit live source IDs.

Before activating a window, assign the sender migration and confirm its available
authentication options. Configure a header or supported provider authentication,
then verify real events through the final destination before the deadline.
If a sender cannot supply either, generate its separate authenticated webhook URL
and verify delivery before ending compatibility. Do not treat the deadline alone
as successful migration.

After recovery, determine which events the sender retained for retry. Events
rejected before ingestion are absent from Axel's replay store and may need a
provider-side retry or backfill. Do not claim recovery from current traffic alone.

Remove the temporary entry after migration.
