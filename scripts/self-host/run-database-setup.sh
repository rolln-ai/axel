#!/usr/bin/env bash
set +x
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

node "$ROOT_DIR/scripts/self-host/database-access.mjs" prepare

# The migration subprocess receives only the migration DSN. Export inside a
# subshell so the credential never appears in an `env` process argument. The
# bootstrap and application URLs are removed before any migration hook can run.
(
  export DATABASE_URL="$DATABASE_MIGRATION_URL"
  export DATABASE_MIGRATION_ROLE=axel_owner
  export DATABASE_MIGRATION_LOGIN_ROLE=axel_migration
  export DATABASE_MIGRATION_OWNER_PARENT_ROLES=""
  export DATABASE_MIGRATION_OWNER_CAN_CREATE_ROLES=0
  export DATABASE_RUNTIME_CAPABILITY_ROLES=axel_dashboard,axel_delivery_native
  export DATABASE_VERIFY_CAPABILITY_ROLE=axel_verify
  export PGSSLMODE=disable
  unset DATABASE_ADMIN_URL DATABASE_MIGRATION_URL DATABASE_DASHBOARD_URL \
    DATABASE_DELIVERY_URL
  bash "$ROOT_DIR/scripts/run-migrations.sh"
)

node "$ROOT_DIR/scripts/self-host/database-access.mjs" finalize
node "$ROOT_DIR/scripts/self-host/database-access.mjs" verify
