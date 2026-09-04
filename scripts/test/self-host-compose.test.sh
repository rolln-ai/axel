#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/axel-selfhost-compose-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

ENV_FILE="$TEST_DIR/selfhost.env"
TEST_CREDENTIALS_MASTER_KEY="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
cat > "$ENV_FILE" <<EOF
AXEL_SITE_ADDRESS=http://localhost:8080
AXEL_PUBLIC_URL=http://localhost:8080
AXEL_DELIVERY_PUBLIC_URL=http://localhost:8080
AXEL_LOCAL_BIND_ADDRESS=127.0.0.1
AXEL_LOCAL_PORT=8080
AXEL_HTTP_PORT=80
AXEL_HTTPS_PORT=443
AXEL_PUBLISH_PUBLIC_PORTS=0
POSTGRES_ADMIN_PASSWORD=test_admin_database_password_00000000000000000000
POSTGRES_MIGRATION_PASSWORD=test_migration_database_password_00000000000000000
POSTGRES_DASHBOARD_PASSWORD=test_dashboard_database_password_00000000000000000
POSTGRES_DELIVERY_PASSWORD=test_delivery_database_password_000000000000000000
CREDENTIALS_MASTER_KEY=$TEST_CREDENTIALS_MASTER_KEY
DELIVERY_SHARED_SECRET=dddddddddddddddddddddddddddddddd
DELIVERY_SHARED_SECRET_PREVIOUS=pppppppppppppppppppppppppppppppp
SOURCE_LOOKUP_SHARED_SECRET=ssssssssssssssssssssssssssssssss
SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS=llllllllllllllllllllllllllllllll
INGEST_ADMIN_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CRON_SECRET=cccccccccccccccccccccccccccccccc
NEXT_PUBLIC_AXEL_INGEST_URL=https://ingest.example.test
CLOUDFLARE_ACCOUNT_ID=account
CLOUDFLARE_API_TOKEN=token
CLOUDFLARE_RUNTIME_API_TOKEN=runtime-token
RAW_PAYLOAD_BUCKET=axel-test-raw
DELIVERY_QUEUE_ID=queue-id
EOF

# Exercise the helper with a fake Docker binary so the selected Compose files
# are checked even on systems without a Docker daemon.
mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$MOCK_DOCKER_LOG"
EOF
chmod 700 "$TEST_DIR/bin/docker"

MOCK_DOCKER_LOG="$TEST_DIR/local-docker.log" \
  PATH="$TEST_DIR/bin:$PATH" \
  AXEL_SELF_HOST_ENV="$ENV_FILE" \
  "$ROOT_DIR/scripts/axel-self-host" status
if grep -Fq 'docker-compose.public.yml' "$TEST_DIR/local-docker.log"; then
  echo "local mode unexpectedly selected public host ports" >&2
  exit 1
fi
grep -Fq -- "-f $ROOT_DIR/docker-compose.selfhost.yml ps" "$TEST_DIR/local-docker.log"

sed 's/^AXEL_PUBLISH_PUBLIC_PORTS=0$/AXEL_PUBLISH_PUBLIC_PORTS=1/' "$ENV_FILE" \
  > "$TEST_DIR/public.env"
MOCK_DOCKER_LOG="$TEST_DIR/public-docker.log" \
  PATH="$TEST_DIR/bin:$PATH" \
  AXEL_SELF_HOST_ENV="$TEST_DIR/public.env" \
  "$ROOT_DIR/scripts/axel-self-host" status
grep -Fq -- "-f $ROOT_DIR/infra/self-host/docker-compose.public.yml ps" \
  "$TEST_DIR/public-docker.log"

grep -Fq "FROM workspace AS migration" "$ROOT_DIR/Dockerfile"
grep -Fq "postgresql-client" "$ROOT_DIR/Dockerfile"
grep -Fq 'CMD ["bash", "/app/scripts/self-host/run-database-setup.sh"]' \
  "$ROOT_DIR/Dockerfile"
if grep -Fq '/internal/*' "$ROOT_DIR/infra/self-host/Caddyfile"; then
  echo "self-host Caddyfile exposes internal routes by wildcard" >&2
  exit 1
fi
for path in \
  /internal/source \
  /internal/erasure-subjects \
  /internal/heartbeat \
  /internal/routes \
  /internal/routes/errored; do
  grep -Fq "$path" "$ROOT_DIR/infra/self-host/Caddyfile"
done
grep -Fq 'export DATABASE_RUNTIME_CAPABILITY_ROLES=axel_dashboard,axel_delivery_native' \
  "$ROOT_DIR/scripts/self-host/run-database-setup.sh"
grep -Fq 'export DATABASE_VERIFY_CAPABILITY_ROLE=axel_verify' \
  "$ROOT_DIR/scripts/self-host/run-database-setup.sh"
if grep -Fq 'DATABASE_URL=postgres://axel:axel@localhost:5432/axel' \
  "$ROOT_DIR/README.md"; then
  echo "README still recommends the unsupported shared-role migration path" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "self-host Compose render skipped (Docker Compose unavailable); helper selection passed"
  exit 0
fi

docker compose --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/docker-compose.selfhost.yml" \
  config --format json > "$TEST_DIR/local.json"
docker compose --env-file "$TEST_DIR/public.env" \
  -f "$ROOT_DIR/docker-compose.selfhost.yml" \
  -f "$ROOT_DIR/infra/self-host/docker-compose.public.yml" \
  config --format json > "$TEST_DIR/public.json"

node - "$TEST_DIR/local.json" "$TEST_DIR/public.json" <<'EOF'
const { readFileSync } = require("node:fs");
const [localPath, publicPath] = process.argv.slice(2);
const local = JSON.parse(readFileSync(localPath, "utf8"));
const published = JSON.parse(readFileSync(publicPath, "utf8"));

function ports(config) {
  return config.services.caddy.ports ?? [];
}
function hasPort(config, target, protocol = "tcp", hostIp) {
  return ports(config).some((port) => Number(port.target) === target
    && (port.protocol ?? "tcp") === protocol
    && (hostIp === undefined || port.host_ip === hostIp));
}

if (!hasPort(local, 8080, "tcp", "127.0.0.1")) {
  throw new Error("local Caddy port is not bound to 127.0.0.1:8080");
}
if (hasPort(local, 80) || hasPort(local, 443, "tcp") || hasPort(local, 443, "udp")) {
  throw new Error("local Compose config exposes or reserves public ports 80/443");
}
if (!hasPort(published, 80, "tcp")
  || !hasPort(published, 443, "tcp")
  || !hasPort(published, 443, "udp")) {
  throw new Error("public Compose override does not publish HTTP, HTTPS, and HTTP/3 ports");
}
if (local.services.dashboard.environment.CLOUDFLARE_R2_API_TOKEN !== "runtime-token"
  || local.services.dashboard.environment.CLOUDFLARE_API_TOKEN !== undefined) {
  throw new Error("dashboard did not receive only the R2-named runtime Cloudflare token");
}
if (local.services.delivery.environment.CLOUDFLARE_API_TOKEN !== "runtime-token"
  || local.services.delivery.environment.CLOUDFLARE_R2_API_TOKEN !== undefined) {
  throw new Error("delivery did not receive only the Queue/R2 runtime Cloudflare token");
}
if (local.services.delivery.environment.DELIVERY_SHARED_SECRET_PREVIOUS
    !== "pppppppppppppppppppppppppppppppp"
  || local.services.delivery.environment.DELIVERY_SHARED_SECRET
    !== "dddddddddddddddddddddddddddddddd"
  || local.services.delivery.environment.SOURCE_LOOKUP_SHARED_SECRET
    !== "ssssssssssssssssssssssssssssssss"
  || local.services.delivery.environment.SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS
    !== "llllllllllllllllllllllllllllllll"
  || local.services.dashboard.environment.DELIVERY_SHARED_SECRET !== undefined
  || local.services.dashboard.environment.DELIVERY_SHARED_SECRET_PREVIOUS !== undefined
  || local.services.dashboard.environment.SOURCE_LOOKUP_SHARED_SECRET !== undefined
  || local.services.dashboard.environment.SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS !== undefined) {
  throw new Error("delivery internal credentials are not confined to the delivery service");
}
const serviceDatabaseUrls = {
  dashboard: "postgresql://axel_dashboard_app:test_dashboard_database_password_00000000000000000@postgres:5432/axel?sslmode=disable",
  delivery: "postgresql://axel_delivery_app:test_delivery_database_password_000000000000000000@postgres:5432/axel?sslmode=disable",
};
for (const service of ["dashboard", "delivery"]) {
  const environment = local.services[service].environment;
  if (environment.DATABASE_URL !== serviceDatabaseUrls[service]) {
    throw new Error(`${service} did not receive its independent database DSN`);
  }
  for (const forbidden of [
    "DATABASE_ADMIN_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_DASHBOARD_URL",
    "DATABASE_DELIVERY_URL",
    "POSTGRES_ADMIN_PASSWORD",
    "POSTGRES_MIGRATION_PASSWORD",
    "POSTGRES_DASHBOARD_PASSWORD",
    "POSTGRES_DELIVERY_PASSWORD",
  ]) {
    if (environment[forbidden] !== undefined) {
      throw new Error(`${service} received privileged database material: ${forbidden}`);
    }
  }
}
if (local.services.postgres.image !== "postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94") {
  throw new Error("self-host Postgres must support explicit SET-only role memberships");
}
if (local.services.caddy.image !== "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d") {
  throw new Error("self-host Caddy must use the reviewed immutable image");
}
if (local.services.postgres.environment.POSTGRES_USER !== "axel"
  || local.services.postgres.environment.POSTGRES_PASSWORD
    !== "test_admin_database_password_00000000000000000000"
  || local.services.postgres.environment.POSTGRES_MIGRATION_PASSWORD !== undefined
  || local.services.postgres.environment.POSTGRES_DASHBOARD_PASSWORD !== undefined
  || local.services.postgres.environment.POSTGRES_DELIVERY_PASSWORD !== undefined) {
  throw new Error("Postgres bootstrap environment is not isolated");
}
const migrate = local.services.migrate;
if (migrate.build?.target !== "migration"
  || migrate.image !== "axel-selfhost-migration:local"
  || migrate.read_only !== true
  || (migrate.volumes ?? []).length !== 0
  || migrate.command?.join(" ") !== "bash /app/scripts/self-host/run-database-setup.sh"
  || !migrate.tmpfs?.some((entry) => entry.startsWith("/tmp"))) {
  throw new Error("migration job is not the read-only repository migration image");
}
if (!migrate.environment.DATABASE_ADMIN_URL.startsWith("postgresql://axel:")
  || !migrate.environment.DATABASE_MIGRATION_URL.startsWith("postgresql://axel_migration:")
  || !migrate.environment.DATABASE_DASHBOARD_URL.startsWith("postgresql://axel_dashboard_app:")
  || !migrate.environment.DATABASE_DELIVERY_URL.startsWith("postgresql://axel_delivery_app:")
  || migrate.environment.DATABASE_URL !== undefined) {
  throw new Error("migration job database identities are not separated");
}
for (const service of ["dashboard", "delivery"]) {
  if (local.services[service].environment.AXEL_SELF_HOST_PROFILE !== "small") {
    throw new Error(`${service} does not advertise the small-profile capability limits`);
  }
}
for (const service of ["migrate", "dashboard", "delivery", "cron", "caddy"]) {
  const config = local.services[service];
  if (!config.cap_drop?.includes("ALL")) {
    throw new Error(`${service} does not drop ambient Linux capabilities`);
  }
  if (!config.security_opt?.includes("no-new-privileges:true")) {
    throw new Error(`${service} permits privilege escalation`);
  }
}
if (!local.services.caddy.cap_add?.includes("NET_BIND_SERVICE")) {
  throw new Error("Caddy is missing its single required bind capability");
}
EOF

echo "self-host Compose tests passed"
