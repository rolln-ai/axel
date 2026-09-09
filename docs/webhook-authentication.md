# Webhook authentication

For a sender that supports custom headers, copy the **Webhook URL**, set the
header name to `x-axel-token`, and copy the **Header value** from Axel. Creating
or rotating a source token shows all three values together. The header token
is shown once and stored only as a SHA-256 hash.

## Senders without custom headers

On a custom webhook source, open **Settings → Without custom headers → Generate
webhook URL**. Copy the complete **Authenticated webhook URL** into your sender's
webhook URL field. No Axel header is needed. The URL contains a dedicated
`url_token` credential. Do not append the ordinary header token to the URL.

Only owners and admins of an active workspace can manage these URLs. URL
authentication is disabled by default, including for existing sources. It uses a
separate random 256-bit credential and stores only its SHA-256 hash. Generating,
replacing, or disabling this credential does not change header authentication.
The complete URL is shown once. After leaving the page, use the URL already saved
in your sender or choose **Replace webhook URL** to get a new one.

Replacing the URL immediately invalidates its predecessor. **Disable URL** revokes
URL authentication for that source. Update each sender using that URL after a
replacement. These changes use the same authority fence, committed-state sync,
and workspace guards as header-token rotation. A sync failure does not report
success or release the hosted authority fence.

This option is for custom sources. Stripe, GitHub, Shopify, and Chargebee presets
continue to require their own authentication. If a custom source has an HMAC
secret configured, its signature remains required even with a URL credential.
IP restrictions, source status, billing limits, body limits, and durable
storage/queue acknowledgement apply to both authentication methods.

Axel rejects duplicate `url_token` parameters, combining a URL credential with
`x-axel-token`, and the legacy `token` query parameter by default. The only legacy
exception is an explicit source-scoped [migration window](ingest-auth-migration.md)
of at most 72 hours; mixing legacy and new credentials is always rejected.
A credential from another source or a revoked URL cannot authorize a request.

## Keeping the URL private

An authenticated webhook URL is a bearer credential. Anyone with it can submit
events to its source. Use HTTPS and keep it out of tickets, screenshots, shell
history, and public repositories. The copy control copies text without opening
the URL in a browser. Axel does not put it in browser storage, configuration
exports, audit entries, queue messages, event metadata, or delivery analytics.

A sender, proxy, CDN, or access-log system can record a URL before the application
receives it. Application redaction cannot erase those upstream copies. Configure
query-string redaction there and keep log access restricted. Cloudflare's
[Worker observability settings](https://developers.cloudflare.com/api/resources/workers/)
include `redact_query_string` for logs and traces. The checked-in ingest Worker
configuration leaves persisted invocation logs and traces disabled; review
account-level logging, Logpush, and any proxies separately before enabling them.
Prefer headers whenever the sender supports them.

## Deployment order and verification

Apply migration `0075_source_url_tokens.sql`, then deploy the source-lookup
service and ingest Worker before the dashboard. The nullable column preserves
existing credentials and leaves URL authentication off. Enable a URL only after
all three services have the new code. An older source-lookup deployment omits
the URL hash, which makes URL authentication fail closed.

Use a synthetic source to verify URL-only acceptance, unchanged header acceptance,
replacement rejecting the old URL, and disable rejecting the replacement. Check
a durable delivery through the protected smoke/canary workflow after promotion.
The signed-in local QA suite runs the real receiver and admin authentication
against disposable Postgres, with in-memory substitutes only for R2 and Queues.
It does not prove Cloudflare platform logging behavior or external delivery.
