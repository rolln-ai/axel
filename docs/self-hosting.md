# Self-hosting Axel

Axel has a small-install profile for people who want to run it on a home
server, lab machine, or existing VM. The public ingest and durable queues still
use Cloudflare, while the control plane and all destination delivery run in
Docker on your host.

## What can actually be free

Cloudflare Queues became available on the Workers Free plan in February 2026.
The current free allowances include 100,000 Worker requests per day, 10,000
Queue operations per day, and the published R2 free allowance. Cloudflare
counts an HTTP pull as a read even when the Queue is empty. The small profile
therefore starts at one-second polling while work is active, doubles the delay
after each empty pull, and caps sustained-idle polling at 60 seconds. At that
ceiling, an idle installation uses about 1,440 Queue reads per day, plus a few
reads while the delay ramps up.

Axel normally uses about six additional Queue operations for one event routed
to one destination. After sustained-idle polling, the remaining daily
allowance is roughly 8,500 operations, or about 1,400 one-destination events
with no retries. Multiple destinations, retries, other Queues in the same
account, and waking from idle lower that number. An event arriving after a
long idle period can wait up to 60 seconds for the next pull; finding work
resets polling to one second.

Workers Free Queue messages have a non-configurable 24-hour retention limit.
If the Docker host or its delivery service stays offline for that long, pending
delivery and dead-letter messages can expire. Use a paid Queue plan or another
durable broker when the host cannot reliably recover inside 24 hours.

The Docker services have no license fee. A $0 deployment therefore means you
already have a machine and network connection. There is no credible option for
an always-on, fully managed app, database, domain, and backups with a permanent
$0 guarantee.

Official limits change over time. Check the current
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before relying
on a specific ceiling.

## Small-install architecture

| Component | Location | Notes |
| --- | --- | --- |
| Ingest Worker | Cloudflare Free | Validates and stores incoming payloads |
| Router Worker | Cloudflare Free | Reads one ingress queue and fans out routes |
| Three Queues | Cloudflare Free | Ingress, delivery, and dead letter |
| Raw payload bucket | Cloudflare R2 | Provisioner installs a 30-day expiry rule |
| Postgres | Docker host | Private Docker network, no published database port |
| Dashboard | Docker host | Next.js production server |
| Delivery service | Docker host | Handles every connector type in this profile |
| Scheduler | Docker host | Calls the authenticated dashboard cron routes |
| Caddy | Docker host | TLS and routing for dashboard plus internal APIs |

The full production topology keeps 16 ingress shards and a separate edge
delivery worker. The small profile binds all 16 code-level producers to one
queue and maps both delivery bindings to one HTTP-pull queue. This trades peak
throughput for fewer resources and a much simpler install.

ClickHouse is not part of the default small stack. Webhook ingest, routing, and
delivery work without it, but event search, usage charts, and parts of CLI
payload lookup show empty or unavailable states. Add ClickHouse when those
features matter; the production schema is in `infra/clickhouse`.

The small profile's R2 lifecycle is a fixed 30-day ceiling. Shorter workspace
or source retention settings, transient-mode early deletion, and the
subject-to-event index used by data-subject erasure are not automated without
the full analytics/indexing path. The dashboard disables those controls when
`AXEL_SELF_HOST_PROFILE=small`; the server actions reject direct submissions
too. Postgres-only dead-letter, replay-request, and audit-log retention remain
available. Add ClickHouse and the production retention path when shorter raw
retention or indexed erasure is required.

## Requirements

- Docker with the Compose plugin
- Node 20 or newer and pnpm 9 for the pinned Cloudflare provisioning command
- A Cloudflare account with a Workers subdomain enabled
- A provisioning-only Cloudflare API token that can edit Workers scripts,
  Queues, and R2 storage
- A separate, account-restricted runtime Cloudflare token that can pull,
  acknowledge, and enqueue Queue messages and read, write, and delete R2
  objects
- A public HTTPS URL that reaches this host
- A domain whose DNS points at the host if Caddy will obtain the certificate

Use the narrowest Cloudflare tokens possible and restrict both to the account
that will hold this installation. The delivery service needs the separate
runtime token for Queue pull, acknowledge, enqueue, and consumer-edit operations
plus R2 object read, write, and delete. Protect `.env.selfhost` and back it up as
a secret. The broader provisioning token does not enter an application
container.

## Install

1. Generate the private configuration. Pass the public URL now so it is also
   embedded into the dashboard build. `AXEL_SITE_ADDRESS` is a Caddy site label,
   normally the hostname without `https://`.

   ```sh
   AXEL_PUBLIC_URL=https://axel.example.com \
   AXEL_SITE_ADDRESS=axel.example.com \
     ./scripts/axel-self-host init
   ```

   This writes `.env.selfhost` with mode `0600` and generates independent
   256-bit values for credential encryption, internal service authentication,
   ingest administration, and cron authentication. It also generates a random
   resource-name suffix and an installation ID so two installs do not silently
   claim the same Cloudflare resources. It will not overwrite an existing file.

2. Add the operator-supplied Cloudflare values in `.env.selfhost`:

   ```dotenv
   CLOUDFLARE_ACCOUNT_ID=your-account-id
   CLOUDFLARE_API_TOKEN=your-provisioning-token
   CLOUDFLARE_RUNTIME_API_TOKEN=your-runtime-token
   ```

   The provisioning token deploys Workers and creates the installation's
   Queue and R2 bucket. It never enters an application container. The separate
   account-restricted runtime token must be able to pull, acknowledge, and
   enqueue on that Queue and read, write, and delete objects in that R2 bucket.
   It does not need Workers Scripts edit or resource-creation permission.
   The helper rejects reuse of the provisioning token and verifies Queue edit
   plus an isolated R2 write/read/delete round trip before starting the stack;
   it never leases a customer message for this check.

   If the delivery service uses a different public origin, set
   `AXEL_DELIVERY_PUBLIC_URL` too. It must be reachable from Cloudflare and must
   not point at localhost. It must use HTTPS because edge authentication
   secrets and webhook source configuration cross this connection.

   Email is optional. To enable invitations, verification, password reset, and
   notifications, also set `RESEND_API_KEY` and a verified
   `RESEND_FROM_EMAIL`. Without them, production email actions fail safely and
   do not print the recipient or one-shot link into container logs.

3. Provision the edge resources:

   ```sh
   ./scripts/axel-self-host edge
   ```

   On its first run, the helper installs the lockfile-pinned workspace tools if
   they are not present. It does not use an arbitrary globally installed
   Wrangler version. The command creates missing resources without deleting
   existing ones. It creates the ingress, delivery, and dead-letter Queues,
   enables HTTP pull, creates the private R2 bucket, adds a 30-day raw-payload
   lifecycle rule, deploys the ingest and router Workers, installs their
   secrets, and records the Worker URL plus Queue ID in `.env.selfhost`.
   Before deploying, it verifies that the raw bucket has neither public r2.dev
   access nor a custom domain and that its expiry rule is enabled, covers every
   prefix, and is exactly 30 days.

   Created resources are recorded in `.selfhost/ownership.env`. If that local
   proof is missing, the helper refuses to attach to same-named queues or an R2
   bucket. After inspecting resources from an older install, a one-time explicit
   adoption is available:

   ```sh
   AXEL_ADOPT_EXISTING_RESOURCES=1 ./scripts/axel-self-host edge
   ```

   Do not put that acknowledgement in `.env.selfhost`; leaving it enabled would
   defeat collision protection on later runs.

4. Build and start the private services:

   ```sh
   ./scripts/axel-self-host up
   ./scripts/axel-self-host status
   ```

   Caddy uses ports 80 and 443 for a public hostname. The default localhost
   configuration uses port 8080 instead and binds it only to `127.0.0.1`.
   Change `AXEL_HTTP_PORT`, `AXEL_HTTPS_PORT`, or `AXEL_LOCAL_PORT` in
   `.env.selfhost` when those host ports are already in use. Set
   `AXEL_LOCAL_BIND_ADDRESS=0.0.0.0` only when you deliberately want the local
   HTTP listener reachable from other machines; public deployments should use
   Caddy's HTTPS listener instead.

   The generated `AXEL_PUBLISH_PUBLIC_PORTS` is `0` for a loopback site and `1`
   for a public hostname. The helper adds the public-port Compose override only
   in the latter mode, so a local install does not reserve or expose host ports
   80 and 443.

5. Inspect logs or stop the stack without deleting data:

   ```sh
   ./scripts/axel-self-host logs
   ./scripts/axel-self-host down
   ```

When signing the CLI into this installation, keep the PAT on your self-hosted
origin by passing the dashboard URL explicitly. The npm package is not
published yet, so build and install the CLI from the same source checkout
first:

```sh
pnpm --filter @axel/cli build
npm install -g ./packages/cli
axel auth login --api-base 'https://axel.example.com'
```

The token panel prints this deployment-specific command after minting a PAT.
The CLI's no-argument default is Axel Cloud, so do not omit `--api-base` for a
self-hosted token.

The helper deliberately has no resource-destroy command. Removing Queues or an
R2 bucket can discard undelivered or retained webhook data, so teardown stays
an explicit Cloudflare console or Wrangler operation.

## Security defaults in this profile

- Postgres is reachable only on the Compose network.
- The development Compose file binds Postgres and ClickHouse to loopback only.
- Caddy exposes only dashboard traffic, delivery health, authenticated internal
  delivery routes, and PAT-authenticated CLI routes.
- Raw R2 objects expire after 30 days even when ClickHouse is absent; shorter
  per-source retention requires the full retention path described above.
- Signed webhook delivery fails closed if its signing credential is missing.
- Outbound HTTP redirects are checked at every hop, and the Node delivery
  socket rejects private, loopback, link-local, and metadata addresses.
- The generated Workers use Cloudflare's `global_fetch_strictly_public` mode.
- Stripe is not configured, so the billing integration stays inactive.

Use `CONTROL_PLANE_DB_SSL_VERIFY=true` when the control-plane Postgres is moved
to a remote provider with a publicly trusted certificate. The local Compose
connection explicitly uses `sslmode=disable` inside the host network.

## Operations you still own

- Back up the `selfhost_pgdata` Docker volume and test restoration.
- Keep `.env.selfhost` in a password manager or secret backup. Losing
  `CREDENTIALS_MASTER_KEY` makes stored destination credentials unreadable.
- Back up `.selfhost/ownership.env` with the private configuration. Losing it
  requires inspecting and explicitly adopting existing Cloudflare resources.
- Rotate the Cloudflare token and internal shared secrets after suspected
  exposure.
- Keep the required `CLOUDFLARE_RUNTIME_API_TOKEN` limited to Queue and R2
  runtime operations so a dashboard or delivery compromise does not also
  expose the Worker-deployment credential.
- Monitor Queue backlog and the `/health` endpoint.
- Confirm the R2 lifecycle rule after manual bucket changes.
- Add ClickHouse if searchable delivery history is required.
- Add the full retention and erasure-indexing path before promising retention
  shorter than 30 days or indexed data-subject erasure.
- Review provider limits before increasing traffic.

For a master key outside the helper, the required format is exactly 64 hex
characters:

```sh
openssl rand -hex 32
```

The rotation procedure is in [`credential-rotation.md`](credential-rotation.md).

## Manual and production deployments

The checked-in `wrangler.toml` files and `render.yaml` describe Axel Cloud's
production topology. They include Axel-owned domains, resource IDs, service
URLs, autoscaling, and a high-capacity ClickHouse service. Do not treat them as
a cheap starter template.

For higher traffic, keep the 16 ingress queues, run the delivery web role with
multiple replicas, run exactly one singleton worker role, add ClickHouse, and
use a managed Postgres or pooler with verified TLS. See
[`production-scale.md`](production-scale.md) and
[`adr-0001-architecture.md`](adr-0001-architecture.md).
