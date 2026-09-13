# Webhook data security review

Review started: 2026-08-27

This record includes follow-up fixes made before the public launch. It is a
historical review, not a live security status page. For current runtime and
operation instructions, use [ADR-0002](adr-0002-current-runtime.md) and the
[docs index](README.md).

This review followed webhook data from the public ingest endpoint through raw
R2 storage, routing, delivery, dashboard inspection, CLI payload retrieval, and
self-hosted deployment. It tested unauthenticated callers, current and removed
workspace members, compromised destination URLs, missing provider secrets,
secret-bearing headers and query parameters, DNS rebinding, redirects, and
deployment misconfiguration.

This is a point-in-time code review and adversarial test pass, not a guarantee
that the system has no vulnerabilities. Report newly discovered issues through
the private process in [`SECURITY.md`](../SECURITY.md).

## Data path and trust boundaries

1. `ingest-worker` authenticates a custom source token or named-provider request before
   writing the body to a workspace-prefixed R2 key.
2. A Cloudflare Queue carries metadata and the R2 key to `router-edge`.
3. The router reads the body, evaluates workspace routes, and writes a delivery
   message.
4. `delivery-service` or `delivery-edge` resolves the destination and transmits
   the event.
5. Dashboard and CLI readers retrieve event metadata and raw R2 bytes through
   workspace-scoped authenticated paths.

The most sensitive boundaries are the source lookup service, R2 read
credentials, personal access tokens, destination egress, and any optional AI
feature that receives event examples.

## Findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | A personal access token survived removal of its user from a workspace. The removed user could continue using CLI raw-payload reads, and an ordinary member's PAT inherited write and replay abilities. | PAT authentication now joins the current membership on every request, derives scopes from the current role, and a composite foreign key deletes tokens when membership ends. |
| Critical | Data Contract patch approval trusted browser-supplied replay tuples. An admin who knew another workspace's R2 object key could pair it with local source and route IDs, causing the account-privileged replay worker to read that foreign raw body and send it to the attacker's destination. | Patch approval now resolves every tuple from an unresolved dead letter joined to the authenticated workspace, source, route, and Data Contract before any write. The shared enqueue function independently rejects foreign key prefixes, a database constraint quarantines invalid active rows and blocks new ones, and the replay consumer validates workspace ownership before hints or R2 access. |
| Critical | The self-host dashboard told operators to run `axel auth login` without a base URL. The CLI defaults to Axel Cloud, so following that instruction sent the newly pasted self-host PAT to the hosted service for validation. | The token panel now emits a copy-safe command with the configured deployment origin. The CLI validates before reading or sending a token, permits plaintext only for exact loopback development hosts, stores only a normalized origin, and refuses authenticated redirects. |
| High privacy | The dashboard and marketing site loaded browser analytics and advertising scripts that could derive page URLs, DOM text, element attributes, referrers, and campaign values. Password-reset, verification, and invitation URLs contain one-shot credentials. | PostHog, Umami, GTM, gtag, conversion cookies, browser analytics providers, and their proxy routes were removed from both applications. A regression scan fails if those tracker entry points return. Hosted and self-hosted responses also set `Referrer-Policy: no-referrer`. |
| High privacy | When production email was not configured, the development fallback printed the full recipient, message, and one-shot password-reset, verification, or invitation link to process logs while reporting success. The default self-host profile did not pass email configuration through to the dashboard. | Full-message logging is now development-only. Production returns a safe delivery error without logging the recipient or body, and the self-host environment exposes optional Resend settings explicitly. |
| High privacy | HTTP, webhook, BigQuery, and Databricks destination response bodies could be persisted in delivery analytics. A receiver could echo the submitted webhook bytes, creating a second retained copy outside the raw-payload lifecycle; generic HTTP receivers could also return an unbounded body for the connector to buffer. | HTTP, webhook, and failed Databricks delivery now cancel response streams without reading or retaining them. Successful Databricks SQL responses have a one-megabyte streaming cap. Attempt storage projects responses onto allowlisted destination types, numeric status and retry fields, booleans, and fixed error codes. Body, payload, raw, secret, schema, object-key, and other provider-controlled fields are dropped before ClickHouse or dead-letter persistence. |
| High privacy | Migration 0074 scrubbed existing billing journal payloads and changed the column default, but an older dashboard process could still supply a Stripe body explicitly during a migration-first rollout. | The migration now installs a `SECURITY INVOKER` trigger before the scrub. It rewrites every inserted or updated journal payload to an empty object, leaves old writers compatible, and revokes `PUBLIC` execution on the trigger function. Fresh-schema, incremental-migration, idempotency, and least-privilege writer tests cover the database guard. |
| High privacy | The authenticated config export returned destination URLs and configured header values. Those fields can contain credentials and internal endpoints, so a downloaded support artifact could become a second credential store. | Config export now redacts every destination URL and every header value while retaining destination type and header names for structural debugging. Contract tests reject any credential or endpoint value in the response. |
| High | Public ingest honored the caller-controlled `x-axel-test` header when recording usage, so an authenticated source could label ordinary traffic as test traffic and bypass billing accounting. | Public ingest always records `is_test=false` regardless of request headers. Only the authenticated internal admin test-event path can create billing-exempt test traffic. |
| High privacy | Native database and API connector errors could quote a rejected row, document, credential, or receiver diagnostic. Node dead letters and replay failures stored that text, and the immediate-alert path copied the dead-letter excerpt into email. Some delivery console calls also printed the raw exception object. | Durable diagnostics now use fixed operational codes. No substring of a provider or connector exception survives into dead letters, replay rows, pull history, logs, notifications, email, cron responses, or telemetry. Fingerprints use the fixed stored code. |
| Critical | The initial Docker build context included nested application `.env.local` files and other operator-local files. Publishing either image could disclose build-time credentials and bake public environment values into the dashboard bundle. | Docker now excludes root and nested environment, Wrangler secret, npm credential, key, state, credential-export, local-agent, and scratch files. A BuildKit context regression test checks representative exclusions before release. |
| Critical | The self-host provisioner silently reused a same-named R2 bucket without checking whether its r2.dev URL or a custom domain exposed objects publicly. Ingest would then write retained webhook bodies into that bucket. | New installs use a random resource suffix and installation ID. Provisioning requires matching local ownership proof for existing resources, verifies that r2.dev is disabled and no custom domain exists, and offers only a one-shot explicit adoption path after operator inspection. |
| Critical | An older installation with an empty migration ledger could be labeled current without executing the PAT-membership migration. Fresh self-host databases also needed the schema snapshot available inside the migration container. | A non-empty database without a complete, contiguous migration ledger is now rejected and requires operator restoration of reviewed ledger records; object-name heuristics never label it current. Fresh empty databases receive the snapshot and complete baseline ledger in one transaction. Compose builds a read-only migration image containing the checked runner, schema snapshot, and migration directory, and uses separate bootstrap, migration, stable owner, and runtime roles. Real Postgres tests prove fresh bootstrap, incremental migration, and fail-closed missing-ledger behavior. |
| Medium | Cloudflare Worker secrets were applied one at a time, so a failed multi-key rotation could leave a live version with only part of a coupled credential set. | The protected workflow now verifies that the newest uploaded Worker version is the sole active production version, creates one inactive version with the complete allowlisted secret set, activates that version at 100% only after staging succeeds, and reads deployment state back. A simulated staging failure proves no deployment command runs and no subset becomes active. |
| High | Stripe, GitHub, Shopify, or Chargebee sources could silently fall back to token-only authentication if the decrypted provider signing secret was missing at the edge. | Named providers now fail closed with a retryable service error before any R2 or Queue write. Custom sources retain their documented token-only mode. |
| High | Dashboard onboarding and source pages built copyable ingest URLs containing the one-shot source token. The edge also accepted that legacy query credential, exposing it to CDN, proxy, provider, and browser URL logs. | The edge rejects `token` query parameters by default with `401 query_token_not_allowed`. Existing custom sources can receive an explicit, source-scoped migration window of at most 72 hours; see [migration requirements](ingest-auth-migration.md). Normal authentication and authority fencing still apply. Custom-source copy actions show the clean URL and one-time token separately and send the token through `x-axel-token`. Named providers use provider authentication. Headerless senders can opt into a separate, independently revocable URL credential; see [webhook authentication](webhook-authentication.md) for its upstream logging tradeoff. |
| High | Positive source config in Cloudflare KV could authorize a rotated token, disabled or deleted source, or suspended workspace for up to five minutes. An authorization already in flight could also race the invalidation. | Hosted ingest now resolves every request through a per-source SQLite Durable Object and confirms the same authorization revision immediately before its first durable write. Mutations fence before the database write and release only with freshly loaded committed config; a failed sync stays closed. SQLite stores one-way source/config digests, presence, expiry, and authorization state, never plaintext identifiers or source credentials. A mixed-version legacy invalidation enters a fail-closed origin-refresh state and self-repairs without overriding an explicit mutation fence. The self-host profile omits the binding and performs an authenticated direct-origin lookup on every request. |
| High | A captured valid provider request could be submitted repeatedly. GitHub, Shopify, and Chargebee do not all provide a signed timestamp, and each retry previously received a new Axel event ID. | Signed requests now derive a source-bound deterministic event ID and stable raw-object key from the provider delivery or event identity. The raw body uses an atomic create condition, so concurrent copies cannot overwrite or create another retained payload. Retries remain safe to enqueue after a partial failure because the 30-day delivery claim sees the same event ID and suppresses duplicate external effects. Regression tests cover sequential duplicates, concurrent copies, and queue-failure recovery. |
| Critical | Oversized delivery messages trusted an embedded R2 spill key. A malformed or cross-tenant message could point a privileged consumer at another workspace's object, and retry cleanup could delete that object. | Hydration and deletion now require the exact canonical key derived from workspace, event, destination, and attempt before any R2 access. Parsed spill bodies are shape-validated, and retries write a new canonical attempt key before removing the prior object. |
| High | Delivery-edge performed R2 and Postgres work before validating the queue contract, and a failed terminal dead-letter insert could still acknowledge the last durable message and delete its spill. | Both delivery runtimes now accept only the versioned contract plus the explicit legacy-v0 rolling-upgrade shape. Malformed or future versions fail before storage access, and failed dead-letter persistence retries without ACKing or deleting spill data. Metadata-only quarantine records hashes and sizes, never queue bodies. |
| High privacy | Durable Data Contract rows retained inferred values, example identifiers, fixture payloads, mapping previews, and drift detail beyond the raw-payload lifecycle. | Migration 0069 scrubs existing rows. Database triggers and application sanitizers now retain structural schema and generalized type/shape fixtures only, clear event references and drift detail, bind mappings to the same workspace, and allowlist model metadata. Reset and erasure paths cover the remaining records. |
| High | Platform super-admin access relied on password sessions alone, and an initial pending TOTP enrollment could be viewed or completed from another authenticated session for the same administrator. | Super-admin routes now require encrypted TOTP enrollment and a fresh 15-minute step-up. Pending seeds are bound to the password-confirmed session for ten minutes, successful counters cannot replay, verification is rate-limited and audited, and seeds are AES-GCM encrypted under the credential master key. |
| Medium | Auth and API rate limiting failed open when the Postgres-backed counter was unavailable, creating a brute-force and stolen-token bypass during control-plane degradation. | The shared auth/API limiter now fails closed with a fixed 60-second retry window and a value-free diagnostic. Authentication and API-key validation still run independently. |
| Critical | Vercel's default Preview environment included production database, storage, signing, and observability credentials while Git-triggered builds were available. A malicious branch build could execute install or build code with production access. | Production credentials are now Production-only. Stripe test records moved to an isolated manual environment. Live deployment policies deny every Git source for Production, Preview, and the isolated environment; provider Git status deployments are disabled, fork CI receives no secrets, and production is built only by the reviewed CLI workflow. Automation-bypass credentials exposed during the audit were rotated immediately. |
| High | Provider-side Git deploys could race database migrations or bypass the reviewed Production environment, and the native HTTP-pull queue had only three retries with no dead-letter queue. | Vercel Git deployment policies are disabled and verified live. The first protected Render rollout disables and reads back Git auto-deploy before any service deploy; the initial merge must include Render's `[skip render]` guard so it cannot race that enforcement. Manual workflows serialize migration-first releases, stage and smoke Vercel deployments before promotion, and fail closed on provider-state drift. The native queue has been configured and verified in place for eleven retries and `axel-dead-letter`. |
| High | A configured custom-HMAC source could become token-only after a signing-secret decrypt failure, and a partial rotation could publish only one valid secret. | Edge payload creation and direct Postgres mapping now reject corrupt or empty current and previous secret slots. A cache schema bump discards older positive entries that may contain the downgraded shape. Only an intentionally unsigned custom source remains token-only. |
| High | HTTP and webhook destination validation covered only the first URL. Redirects and the gap between DNS validation and socket connection could reach private, link-local, loopback, or cloud metadata addresses with webhook bytes. | Redirects are manual and validated on every hop. Node checks the connected socket address before sending HTTP data. Generated and production Workers enable Cloudflare's strict-public global fetch behavior. IPv4-mapped IPv6, non-global and transition IPv6 space, special-use IPv4, and absolute `localhost.` names are blocked. |
| High | Postgres, MongoDB, S3-compatible, and Databricks clients could resolve a validated hostname again when opening their data socket. Mongo SRV targets and Postgres `host` query overrides expanded that gap. | Native clients now use a safe DNS hook that rejects any non-public answer and gives the checked IP directly to the socket. Postgres local-socket and query-host overrides are blocked. Databricks uses the same connected-socket guard as HTTP delivery. |
| High | Edge delivery resolved `destinations.credentials_ref` by credential ID alone, and Postgres did not bind that reference to the same destination and workspace. A corrupted or future-buggy reference could merge another tenant's decrypted credential into the wrong delivery. | Edge and Node lookups now require the exact credential, destination, and workspace tuple. A deferred composite foreign key enforces that invariant at commit, and its migration clears any existing mismatched reference before enabling the constraint. |
| High | Pull-source credential lookup trusted `pull_sources.credentials_ref` by credential ID alone. A corrupted or future-buggy reference could decrypt another source's or tenant's API credential. | Dashboard and scheduled workers now require the exact credential, pull source, and workspace tuple and decrypt with the source-bound parent context. A deferred composite foreign key enforces that relationship and its migration clears existing mismatches before enabling it. |
| High | Internal delivery-service routes used deployment-wide secrets to expose route data, direct delivery, metrics, heartbeat mutation, and decrypted source authentication configuration. Inconsistent comparison or a missing secret could weaken that boundary. | `/deliver`, metrics, and every `/internal/*` shared-secret route now fail closed through one timing-safe comparison. `/internal/source` authenticates before reading the body, returns `no-store`, prefers a dedicated source-lookup secret, and accepts an explicit previous value only for rotation; the delivery secret remains a warned bootstrap fallback when no dedicated secret is configured. |
| High | A `webhook` destination with a missing signing credential sent the body unsigned. | Signed webhook delivery now fails closed. Operators can choose a plain HTTP destination when unsigned delivery is intentional. |
| High | Destination redirects could forward webhook bytes, authorization headers, API keys, or Axel signatures to another public origin. | Every redirect target still receives SSRF validation, and cross-origin redirects are now terminal before any body or credential is sent to the new origin. |
| High | A stale positive source entry could remain usable at the edge for a year after a token rotation, source disable/delete, IP allowlist change, or workspace suspension. Cache deletion failures were also ignored. | The cache schema was bumped, positive entries now expire after five minutes, and security-reducing mutations require authenticated edge deletion before and after the database change. Workspace suspension, deletion, and wipe invalidate every source and fail closed if invalidation cannot be confirmed. |
| High | Workspace suspension could race REST source creation or source re-enable, leaving an active source inside an inactive workspace. | Every active-source create/re-enable path now serializes on the workspace row and rechecks active status under that lock. Suspension and wipe-time source enumeration use the same lock. |
| High | Edge and native delivery used different claim behavior. A crash could leave a permanent `in_flight` row, while the old duplicate path could return synthetic success and acknowledge the last durable copy. A fixed stale lease could also let another worker steal a legitimate long Parquet delivery. | Both runtimes now use the same atomic Postgres claim, persisted lease deadline, and opaque owner token. They renew active claims and fence settle operations by token; an indeterminate or live duplicate claim retries the durable message instead of sending. Stale claims are atomically reclaimed, Parquet enters persistent drain mode before shutdown waits, and the self-host container has a seven-minute stop grace period. |
| High | The self-host delivery consumer treated Cloudflare HTTP Pull JSON bodies as plain JSON. Cloudflare returns that content type as base64, so valid deliveries were classified as malformed and acknowledged without delivery. | Pull messages are now decoded according to their `CF-Content-Type` metadata before parsing. Malformed, primitive, and unsupported formats still fail closed, with protocol regression tests covering the documented response shape. |
| High | Host-side R2 calls percent-encoded `/` inside object keys, contrary to Cloudflare's REST contract. Raw reads and replay could miss existing objects, and oversized queue spill hydration could dead-letter and acknowledge a valid delivery. | Every dashboard, CLI, replay, retention, spill, and R2-destination REST call now uses one segment-aware URL builder that preserves key slashes, encodes other characters, and rejects path-normalizing dot segments. |
| Medium | Provider signature and authentication headers, common secret query keys, and signed AWS or Google query fields could be copied into retained event metadata. | Verification receives the original headers, while persisted and propagated metadata removes authentication, provider signatures, common secret names, and signed cloud query fields. |
| Medium privacy | Failed ClickHouse inserts logged an upstream error excerpt or transport exception. Parse errors can echo the submitted analytics row, which may contain webhook metadata or a downstream response excerpt. | Fire-and-forget insert logging now records only the static table name and HTTP status or a generic transport failure; response and exception objects are never printed. |
| Medium privacy | The Worker/Node Sentry transport and dashboard SDK could forward exception messages or arbitrary context without a final secret boundary. Driver, parser, or upstream errors can quote submitted values even when the calling code did not attach a payload deliberately. | Every Sentry boundary now removes quoted values, secret assignments, URL userinfo, private keys, token/query values, email, long numbers, and receiver-controlled HTTP response tails. Nested context drops body, payload, raw, and secret-bearing keys and has depth, key, array, and text limits before serialization. Fatal console output uses the same sanitized message. |
| Medium privacy | A malformed decrypted destination-credential blob reached `JSON.parse`, whose exception text can quote the secret-bearing input. | Credential parsing still fails closed, but the secret-boundary exception object is no longer written to process logs. |
| Medium privacy | A corrupt oversized-message spill was wrapped with a stable error but retained the original JSON parser exception as its `cause`. Modern parser errors can quote malformed webhook bytes, which could then reach logs or Sentry. | Spill hydration now retains only the non-sensitive R2 object key and byte count; the raw parser exception is discarded. |
| Medium | HTTP destination URLs could include `username:password@host`, retaining the credential in ordinary destination configuration rather than the encrypted credential store. | URL validation and the delivery-time guard now reject HTTP(S) userinfo. Operators must use the encrypted authentication fields or safe configured headers. |
| Medium | A plain HTTP destination could retain an operator-supplied `Host` or hop-by-hop header even though the signed-webhook path filtered them. | Both HTTP destination types now pass configured headers through the same safe-header filter before a request is built. |
| Medium | Chargebee verification could not succeed because sanitization removed HTTP Basic authorization before verification. | Verification and persistence now use separate header maps. The authorization value is used only for verification and is not retained. |
| Medium | Legacy Chargebee pull rows could choose an arbitrary API domain. Both dashboard-triggered and scheduled syncs attached the Chargebee Basic credential, allowing custom-domain SSRF, DNS rebinding, or credential forwarding through redirects. | Chargebee pulls now accept only a valid tenant label at `https://{site}.chargebee.com`; any legacy custom domain fails before a request is prepared. Dashboard and scheduled paths use DNS-pinned socket guards, disable automatic redirects, and never replay the credential to a `Location` target. |
| High privacy | Pull connectors read receiver-controlled error bodies and stored runner errors plus opaque cursor values in run history, logs, heartbeat state, and dashboard fallbacks. A provider could echo API credentials or customer records into those secondary stores. | Failed provider bodies are canceled unread, malformed-response errors are generic, and every stored or displayed pull diagnostic passes the storage-safe sanitizer. Persisted summaries omit cursor values. Stripe, Shopify, and Chargebee use protected egress with manual redirects, and token-bearing ingest posts also refuse redirects. |
| Medium | Several authenticated service, Cloudflare API, ClickHouse, BigQuery, R2, Queue, billing, and OpenRouter calls inherited automatic redirect following. A compromised or misconfigured endpoint could forward bearer tokens, shared secrets, or private request bodies to another origin. | Credential-bearing fetches now use explicit manual redirects. Calls that intentionally support redirects validate and pin each hop; other internal and provider APIs fail on the redirect response rather than replaying credentials. |
| Medium | Self-hosted outbound paths could default to Axel Cloud ingest when the local ingest URL was omitted. | Outbound test, seed, CLI, and pull paths now refuse to start or send when `AXEL_DEPLOYMENT_MODE=self-hosted` lacks an explicit ingest URL. |
| Medium | Self-host source creation, setup pages, emails, dashboard payload reads, delivery replay, and spill handling could advertise Axel Cloud or use its hardcoded R2 bucket. | Generated ingest endpoints and every dashboard or delivery R2 path use deployment-aware resolvers. Self-hosted processes fail closed unless both the ingest URL and installation-specific `RAW_PAYLOAD_BUCKET` are explicit. |
| Medium | The small self-host profile intentionally omitted KV, but the test-event admin route required a KV cache and always returned 503. | Test events now use the same authenticated cache-or-control-plane source lookup as public ingest. Lookup outages remain retryable and occur before any R2 write. |
| Medium | The self-host provisioner allowed plaintext HTTP for Worker-to-host calls containing internal authentication and source configuration. | Edge provisioning now requires a public HTTPS delivery URL and rejects localhost or plaintext HTTP. |
| Medium | The manual self-host Docker build could render an OpenAPI document with an Axel Cloud ingest fallback when the ingest build argument was absent. | The renderer and Docker build now require an explicit ingest URL and fail before producing the dashboard image when it is missing. |
| Medium | Development databases listened on every host interface, remote control-plane TLS behavior was unclear, and local migrations forced TLS against a non-TLS Postgres container. | Development ports bind to loopback, the self-host stack publishes no database port, local migrations disable TLS explicitly, and remote certificate verification has an explicit setting. |
| Medium | The base self-host Compose profile could make its HTTP entry point reachable beyond the operator's machine without a deliberate public-deployment choice. | The core Caddy port now binds to `127.0.0.1` by default. Publishing ports 80 and 443 requires the explicit public Compose override; the local profile does not reserve them. |
| Medium | The low-cost deployment instructions did not install raw-payload expiry. | The self-host provisioner adds a 30-day R2 lifecycle rule and keeps Postgres private. |
| Medium | The provisioner accepted any lifecycle rule named `axel-delete-raw`, even if it was disabled, prefix-limited, or used a different expiry. | Provisioning now verifies that the rule is enabled, applies to all prefixes, and expires objects after exactly 30 days. A mismatched existing rule aborts without mutating it. |
| Medium | Dashboard HTTP and saved-credential probes validated literal hosts but did not consistently pin the checked DNS answer to the connection. Some target, catalog, schema, collection, and DDL probes also admitted members or inactive workspaces. | Raw HTTP, Postgres, MongoDB, and Databricks dashboard egress now rejects any private or mixed DNS answer and pins the checked address before opening the socket. Saved-credential inspection and DDL actions require an owner or admin in an active workspace before database access, credential decryption, or network activity. |
| Supply-chain hardening | CI and deployment workflows executed GitHub Actions through mutable major-version tags, and the new secret scan used a mutable container tag. | Workflow actions and the Gitleaks image are pinned to immutable revisions. The scan covers the Git history without traversing installed dependencies, and a working-tree scan found no committed or unignored secret candidates. |
| Privacy hardening | Two user-triggered OpenRouter requests did not prohibit provider data collection. | All three AI-assisted analysis paths now request provider routing with data collection denied. |
| High privacy | Data Contract inference and failure investigation sent example webhook values through an incomplete masker. Credentials, arbitrary free text, and raw event-type values could reach OpenRouter. | AI requests now contain only field-name summaries, object and array shape, primitive type markers, allowlisted operational enums, and literal-withheld filter or transform structure. Primitive values, event-type values, destination names, connector text, provider responses, custom separators, and raw payload excerpts are excluded before prompt construction. Requests are capped at 64 KiB, reject prompt-injection-shaped field names, and never follow redirects. |
| High privacy | The event-type backfill script reread historical raw payloads and promoted payload values into long-lived indexed metadata. | The script now exits without reading data and explains that historical payload values cannot cross the raw-retention boundary. Any replacement must derive metadata prospectively under the current type-only contract. |

Regression tests cover the findings above, including membership revocation,
workspace ownership, credential handling, delivery persistence, and self-host
setup. The tests check both application guards and database constraints where
applicable. Passing tests do not replace live deployment checks or independent
review.

## Limitations recorded during the review

Check the current implementation before relying on or extending these controls.

### Medium: rate limiting is per Worker isolate

The ingest token bucket is process-local. Distributed requests and isolate
turnover can exceed a source's intended limit. Move enforcement to a Durable
Object or a Cloudflare rate-limit binding keyed by source.

### Medium: outbound delivery is at least once

Renewable leases and owner-token fencing prevent stale workers from overwriting
newer database state, but they cannot make an arbitrary external HTTP or
database side effect exactly once. A process paused beyond its lease can send
successfully, lose ownership before recording completion, and cause the durable
message to be delivered again.

Receivers should deduplicate on Axel's event/idempotency identity where their
protocol permits it. Native connectors should use destination-side idempotent
writes or transaction keys when available.

### Medium: broad infrastructure credentials

The hosted dashboard uses a dedicated `CLOUDFLARE_R2_API_TOKEN`; the protected
Vercel deploy proves isolated R2 read/write/delete and rejects any token that
can list Queues or Worker scripts. Delivery uses a different runtime token for
Queue and R2 operations, while the Worker-deployment/provisioning token remains
in protected workflows. Source configuration still contains decrypted signing
material at the edge, and internal edge APIs use deployment-wide shared
secrets. A compromised runtime credential can therefore reach data across
workspaces even though the application checks workspace access.

The self-host profile requires a separate `CLOUDFLARE_RUNTIME_API_TOKEN`; its
startup verifier proves Queue/R2 operations and rejects Worker Scripts access,
so the provisioning permission cannot silently enter application containers.
For simpler installation, that profile
uses the same Queue/R2 runtime token in separate dashboard and delivery
containers; operators can split those credentials further in a customized
deployment. The runtime still remains broader than Axel's workspace-level
authorization boundaries.
The current Cloudflare REST object API requires account-scoped Workers R2
Storage Write, which also permits bucket management; Cloudflare's bucket-scoped
Object Read & Write credentials apply only to the S3-compatible API.

Prefer narrowly scoped R2 credentials or an authenticated workspace-scoped raw
payload service. Reaching bucket-only scope requires migrating the delivery
runtime to S3-compatible authentication or isolating Axel in a dedicated
Cloudflare account. Encrypt cached source secrets with a separate runtime key,
and replace global admin credentials with service bindings or independently
scoped credentials where the platform permits it.

### Medium privacy: one-shot auth links reach the first upstream request

Browser telemetry, referrer, and remote-script controls now prevent the
dashboard from forwarding password-reset, verification, or invitation tokens
after the page loads. The initial navigation still places that one-shot token
in the request target seen by the operator's CDN, load balancer, and reverse
proxy. Axel cannot redact infrastructure access logs after they are written.

Configure upstream URL-query redaction and short log retention. A later auth
flow can exchange a short code through a POST or fragment-based handoff so the
redeemable credential never appears in an ordinary request URL.

### Medium: small-profile visibility and dead letters

The small Docker profile omits ClickHouse. Event search, usage charts, and some
CLI inspection are unavailable, and Cloudflare's dead-letter queue is not yet
drained into a local searchable store. Delivery terminal outcomes are retained
in Postgres, but operators must monitor the Cloudflare queue directly for
router or queue-exhaustion failures.

Add a dead-letter poller and a Postgres-backed minimal event index before using
the small profile for workloads that require complete audit history.

Workers Free also caps Queue message retention at 24 hours. An offline Docker
host can therefore lose pending delivery or dead-letter messages after one day,
even though raw payload objects remain in R2. Use a paid Queue plan or another
durable broker when a 24-hour recovery window is not acceptable.

### Medium: small-profile privacy controls need the full index

The small Docker profile has a fixed 30-day R2 lifecycle but no ClickHouse
event-key index. Shorter workspace or source retention, transient-mode early
deletion, and the subject-to-event index used for data-subject erasure are not
automated in this profile. The small-profile UI disables those settings and
the server rejects direct submissions, so operators cannot accidentally
configure a guarantee that the profile does not implement.

Add a Postgres-backed event-key and subject index, or enable the full
ClickHouse retention path, before promising sub-30-day raw retention or indexed
data-subject erasure on the small profile.

### Medium: remote Postgres certificate verification is opt-in

Local Compose correctly uses `sslmode=disable`. For a remote control-plane
database, set `CONTROL_PLANE_DB_SSL_VERIFY=true` and use a publicly trusted
certificate. Compatibility mode without that flag encrypts the connection but
does not authenticate the server certificate.

### Low: runtime container bundles remain broader than necessary

The Node services run as an unprivileged user, Caddy receives no Docker socket
or application secrets, and the build context excludes local credentials. The
application containers drop all ambient Linux capabilities and prevent
privilege escalation; Caddy receives only `NET_BIND_SERVICE`. Every checked-in
third-party container reference now uses an immutable digest, including the CI
Postgres service, and Dependabot checks Docker references weekly. The Node
runtime stages still retain more workspace files and dependencies than a
pruned production bundle requires. The official Caddy image also keeps a root
UID inside the container so it can bind low ports.

Keep digest updates behind review, generate pruned runtime bundles, and
evaluate an unprivileged high-port Caddy configuration. Continue scanning the
finished images as well as source and dependency manifests.

## Review result

The reviewed raw-payload read endpoints require authentication. The most
direct cross-membership data-access paths found were the removed-member PAT and
the patch-approval replay confused deputy. Both are now closed at the
application boundary and reinforced in the database; replay also fails closed
again at the privileged consumer. The remaining webhook confidentiality risks
are chiefly broad infrastructure credentials and upstream logging of the
first request for token-bearing auth links. AI requests contain schema and type
markers rather than webhook values. Replay and distributed source rate limiting
remain integrity and cost risks. The residual items above should stay visible
until implemented and independently reviewed.
