# Self-hosting Axel

Run Axel's dashboard, Postgres database, and delivery service on a Docker host.
Cloudflare Workers receive and route webhooks; Cloudflare Queues and R2 store
pending work and raw payloads. This guide uses the `small` profile, which sends
all deliveries through one Node service.

You maintain the host, backups, credentials, and upgrades. There is no Axel
license or subscription fee. For a managed installation, use
[Axel Cloud](https://app.axelapp.ai/signup?ref=github).

## Requirements

- Docker with Compose 2.24.4 or later.
- Node 22.13 or later on the Node 22 line, and pnpm 9.12.0. CI uses the exact
  Node version in `.node-version`.
- A Cloudflare account with a `workers.dev` subdomain or an active zone for a
  custom ingest domain.
- Two Cloudflare API tokens: one for provisioning and one for the running
  application containers. Required permissions are listed below.
- A public HTTPS URL that reaches your host. If Caddy will obtain the TLS
  certificate, point your domain's DNS at the host first.

The default stack omits ClickHouse. Ingest, routing, and delivery work without
it. Event search, usage charts, and some CLI payload lookups need ClickHouse
and otherwise show empty or unavailable results. See [limits](#limits-of-the-small-profile)
before choosing this profile.

## Install

### 1. Create the configuration

Clone the repository and generate `.env.selfhost`:

```sh
git clone https://github.com/rolln-ai/axel.git
cd axel

AXEL_PUBLIC_URL=https://axel.example.com \
AXEL_SITE_ADDRESS=axel.example.com \
  ./scripts/axel-self-host init
```

Set `AXEL_PUBLIC_URL` before starting the dashboard.
`AXEL_SITE_ADDRESS` is the Caddy hostname, without `https://`.

The helper creates a private file with mode `0600` and refuses to overwrite it.
It generates separate 256-bit secrets for encryption and service authentication,
Postgres credentials, and an installation ID and resource-name suffix. Back up
this file in a password manager or other secret store. Losing
`CREDENTIALS_MASTER_KEY` makes stored destination credentials unreadable.

### 2. Configure Cloudflare

Add these values to `.env.selfhost`:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-provisioning-token
CLOUDFLARE_RUNTIME_API_TOKEN=your-runtime-token
```

Restrict both tokens to the account for this installation. Use different tokens:

| Token | Permissions | Used by |
| --- | --- | --- |
| Provisioning | Edit Workers scripts, Queues, and R2 storage | The `edge` command; never an application container |
| Runtime | Queues Edit and Workers R2 Storage Write | Delivery uses Queues and R2; the dashboard uses R2 |

The runtime token does not need Workers Scripts, Workers Routes, zone, or token
management permissions. Its R2 permission is account-wide: Cloudflare's REST
object API does not accept bucket-scoped Object Read & Write credentials, and
Workers R2 Storage Write also allows bucket management. Use a dedicated account
if you need to isolate those permissions. Bucket-scoped credentials would require
changing the delivery runtime to use the S3-compatible API.

The helper rejects reuse of the provisioning token as the runtime token. It
checks Queue edit access and writes, reads, then deletes a test R2 object before
starting the stack. This check does not lease existing Queue messages.

For a new Cloudflare account, open **Workers & Pages** in its dashboard and
confirm a `workers.dev` subdomain before running `edge`. The command cannot
complete that first-use subdomain prompt. A new hostname can return 523 for about a minute
while it activates; wait and retry its health check.

The default ingest URL uses `workers.dev`. For production, set a custom hostname
in an active Cloudflare zone:

```dotenv
AXEL_INGEST_DOMAIN=ingest.example.com
```

Cloudflare recommends custom domains for production rather than `workers.dev`.
Keep sender retries enabled with either hostname.

If delivery uses a different public origin, set `AXEL_DELIVERY_PUBLIC_URL` too.
It must be reachable from Cloudflare over HTTPS. Internal credentials and source
configuration travel over this connection, so localhost and plain HTTP are not
supported.

To enable invitations, email verification, password resets, and notifications,
set `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL`. Without them, email
actions return an unavailable result. They do not log recipients or one-use links.

### 3. Deploy the Workers and start Docker

```sh
./scripts/axel-self-host edge
./scripts/axel-self-host up
./scripts/axel-self-host status
```

`edge` installs the repository's pinned tools if needed, with package lifecycle
scripts disabled and before loading deployment secrets. It creates the ingress,
delivery, and dead-letter Queues, enables HTTP pull, creates a private R2 bucket
with 30-day expiry, and deploys the ingest and router Workers. It saves the Worker
URL and Queue ID in `.env.selfhost`.

Before deploying, the helper checks that R2 has no public `r2.dev` access or
custom domain and that the expiry rule covers every object for exactly 30 days.
Worker updates are staged before activation. See [failed Worker updates](#failed-worker-updates)
if the command cannot activate or restore a deployment.

`up` builds the images from this checkout and runs database setup before starting
the application containers. It creates separate owner, migration, dashboard,
and delivery roles. The owner cannot log in. The runtime roles cannot create
tables, read `schema_migrations`, or become the owner. The dashboard can run
only the five JSON helper functions required by its privacy triggers; other
application routines remain denied.
See [database roles](database-service-roles.md) for the grant lists and role model.

### Use a published release

When a version appears on [GitHub Releases](https://github.com/rolln-ai/axel/releases),
you can use its prebuilt Linux images on x86-64 or ARM64. Check out that release
so its migrations, Workers, and container configuration match the images:

```sh
git fetch --tags
git checkout v0.1.0
```

Set `AXEL_IMAGE_TAG=0.1.0` in `.env.selfhost`, using the version you checked out,
then run `edge` and `up` as above. `up` pulls the dashboard, delivery, and migration
images from `ghcr.io/rolln-ai` and starts them without a local Docker build.
The dashboard reads your public URLs at startup. Changing a hostname does not
require rebuilding the image. Cloudflare Workers still deploy from the checkout.

Each release attaches `self-host-images.json` with the commit and image digests.
Images include build provenance and an SBOM. An unset `AXEL_IMAGE_TAG` keeps the
local build path, including when testing an unreleased checkout.

Runtime images omit development dependencies and build caches. The dashboard
uses Next.js standalone output, the delivery image contains its production
dependency graph, and the migration image contains the database setup scripts,
schema, and Postgres client. All three run as an unprivileged user.

Caddy uses ports 80 and 443 for a public hostname. A localhost installation uses
port 8080 on `127.0.0.1` and does not publish ports 80 or 443. Change
`AXEL_HTTP_PORT`, `AXEL_HTTPS_PORT`, or `AXEL_LOCAL_PORT` if a port is occupied.
`AXEL_PUBLISH_PUBLIC_PORTS` selects the public-port Compose override: `1` for a
public hostname, `0` for loopback. Set `AXEL_LOCAL_BIND_ADDRESS=0.0.0.0` only to
expose the local HTTP listener to other machines; use Caddy's HTTPS listener
for public access.

Inspect logs or stop the stack without deleting data:

```sh
./scripts/axel-self-host logs
./scripts/axel-self-host down
```

For sender setup, see [webhook authentication](webhook-authentication.md).

## Connect the CLI

The CLI npm package is not published yet. Build it from this checkout and pass
your dashboard URL when signing in:

```sh
pnpm --filter @axel/cli build
npm install -g ./packages/cli
axel auth login --api-base 'https://axel.example.com'
```

The dashboard's token panel also shows this command after creating a personal
access token. The CLI defaults to Axel Cloud, so keep `--api-base` when using
a self-hosted token.

## Costs and capacity

A small installation can fit within Cloudflare's free allowances if you already
have a host and network connection. Hardware, domains, backups, and any provider
overages are your costs.

| Free-plan limit | Effect on this profile |
| --- | --- |
| 100,000 Worker requests per day | Shared with other Workers on the account |
| 10,000 Queue operations per day | Empty HTTP pulls count as reads |
| 24-hour Queue message retention | Pending deliveries and dead letters can expire during a long host outage |
| R2 free allowance | Storage and operations are metered separately; check current R2 pricing |

Active Queue polling starts at one second. Each empty pull doubles the delay,
up to 60 seconds. An idle installation therefore uses about 1,440 Queue reads
per day, plus the reads while polling slows down. A new event may wait up to
60 seconds after a long idle period. Finding work resets the delay to one second.

One event sent to one destination normally uses about six additional Queue
operations. After idle polling, roughly 8,500 daily operations remain, enough
for about 1,400 events without retries. More destinations, retries, other Queues,
and repeated transitions out of idle reduce that estimate.

Workers Free limits each HTTP Worker request to 10 ms of CPU time. Validation,
hashing, and parsing count; network waits do not. Test large representative
synthetic payloads against this limit. Cloudflare
may terminate requests that exceed it with error 1102. Senders must retry any
request without Axel's 202 response. Use Workers Paid if normal traffic exceeds
the free CPU limit. Use a paid Queue plan or another durable broker if the host
cannot reliably recover within the free plan's fixed 24-hour retention window.

Check current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[`workers.dev` guidance](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
before sizing an installation.

## Limits of the small profile

The profile maps all 16 ingest producers to one Queue and both delivery bindings
to one HTTP-pull Queue. One Node service handles every connector type. Postgres,
migrations, dashboard, cron, delivery, and Caddy run in Docker. The optional
Parquet delivery queue is disabled.

Raw R2 payloads expire after 30 days. Shorter source or workspace retention,
transient-mode early deletion, and the subject-to-event index for erasure need
the full analytics and retention path. The dashboard disables these controls
when `AXEL_SELF_HOST_PROFILE=small`, and server actions reject direct submissions.
Postgres retention for dead letters, replay requests, and audit logs still works.
Add ClickHouse and the production cleanup and indexing jobs before using shorter
raw retention or indexed subject erasure.

Other defaults:

- Postgres is accessible only within the private Compose network. Bootstrap and
  migration credentials stay in Postgres and the migration job. Dashboard and
  delivery each receive their own restricted connection string, with explicit
  grants that do not extend to future tables.
- Caddy exposes dashboard traffic, delivery health, authenticated internal
  delivery routes, and CLI routes authenticated with personal access tokens.
- Signed webhook delivery stops if the signing credential is missing.
- Outbound HTTP redirects are checked at every hop. Node rejects connections
  to private, loopback, link-local, and metadata addresses. Generated Workers
  use `global_fetch_strictly_public`.
- Stripe is not configured, so billing is inactive.

Local Postgres connections use `sslmode=disable` inside the private Compose network. For a
remote provider with a publicly trusted certificate, set
`CONTROL_PLANE_DB_SSL_VERIFY=true`.

## Backups and upgrades

Back up the `selfhost_pgdata` Docker volume and test restoration. Store
`.env.selfhost` and `.selfhost/ownership.env` in a private backup. The ownership
file identifies the Cloudflare resources created by this installation.

Before upgrades, read the release notes, back up the database and configuration,
and check out the intended code version. If using release images, update
`AXEL_IMAGE_TAG` to match `VERSION`. Run `up` to apply database setup and
start the new containers. Run `edge` to update the Workers. Use the order below
when rotating internal credentials at the same time.

For installations that used the shared `axel_app` or `axel_runtime` roles, the
setup job revokes their grants and removes them. Keep `POSTGRES_PASSWORD` as the
admin credential or rename it to `POSTGRES_ADMIN_PASSWORD`. Replace
`POSTGRES_RUNTIME_PASSWORD` with separate `POSTGRES_DASHBOARD_PASSWORD` and
`POSTGRES_DELIVERY_PASSWORD` values before upgrading. The dashboard uses the
`dashboard` grant profile. Delivery uses the union of `delivery-native` and
`delivery-workers` because this profile runs one `DELIVERY_ROLE=all` container.

Monitor Queue backlog and `/health`. Check the R2 expiry rule after manual bucket
changes. Rotate Cloudflare and internal credentials after suspected exposure.
Keep `ORDERING_KEY_HMAC_SECRET` private and stable across Worker releases. It is
installed only on the ingest Worker and hashes FIFO keys before they enter Queue
or Durable Object state.

### Rotate internal credentials

The delivery service can accept a previous value temporarily while Workers
switch to a new value. The previous value is never uploaded to Cloudflare.

1. Move the current value in `.env.selfhost` to
   `DELIVERY_SHARED_SECRET_PREVIOUS` or `SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS`.
   Set the current value to a different random value of at least 32 characters.
2. Run `./scripts/axel-self-host up` so delivery accepts both values.
3. Run `./scripts/axel-self-host edge`. If activation or rollback fails, inspect
   both Worker deployments before retrying.
4. Verify ingest, routing, source lookup, and delivery. Clear the previous value
   and run `./scripts/axel-self-host up` again.

The helper rejects a previous value that is short or matches the current value.
Keep this order: updating Workers first would send new credentials to a service
that still accepts only the old ones.

For a credential master key generated outside the helper, use exactly 64 hex
characters:

```sh
openssl rand -hex 32
```

See [credential rotation](credential-rotation.md) before changing an encryption key.

## Troubleshooting edge setup

### Existing resource names

`edge` records created resources in `.selfhost/ownership.env`. Without that
file, it refuses to attach to same-named Queues or buckets. After inspecting
resources from an older installation, you can adopt them once:

```sh
AXEL_ADOPT_EXISTING_RESOURCES=1 ./scripts/axel-self-host edge
```

Do not save this flag in `.env.selfhost`. Leaving it enabled would allow later
runs to adopt resources without another check.

### Failed Worker updates

The helper records both current deployments before uploading code. An existing
Worker must have one version serving 100% of traffic. The helper activates the
new code and secrets, applies triggers, then reads back both deployments.

If activation, triggers, or readback fail, it restores every prior deployment
that may have changed. A first installation has no earlier version to restore.
If rollback is unavailable or fails, inspect both Workers before retrying.

### Removing Cloudflare resources

`down` stops Docker services. It does not delete Queues or R2 data. The helper has
no destroy command; remove resources explicitly through Cloudflare or Wrangler
after checking for pending deliveries and retained payloads.

## Higher-volume deployments

The checked-in `wrangler.toml` files and `render.yaml` describe Axel Cloud. They
contain Axel-owned domains and resource IDs, 16 ingress shards, separate edge
and Node delivery, autoscaling, and a larger ClickHouse service. Use the
self-host helper for this small profile rather than deploying those files.

For higher traffic, retain the 16 ingress Queues, scale the delivery web role,
keep exactly one periodic worker, add ClickHouse, and use managed Postgres or a
pooler with verified TLS. See [production scale](production-scale.md) and the
[current runtime](adr-0002-current-runtime.md).
