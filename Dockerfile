FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS base
WORKDIR /app
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

FROM base AS workspace
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM workspace AS migration-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @axel/migration --prod deploy /opt/migration

FROM base AS migration
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=migration-deps /opt/migration/node_modules ./node_modules
COPY infra/postgres ./infra/postgres
COPY scripts/run-migrations.sh scripts/psql-safe.mjs \
    scripts/check-postgres-migrations.mjs scripts/postgres-migration-safety.mjs \
    scripts/database-service-access-profiles.mjs \
    scripts/verify-database-migration-role.sql scripts/ensure-database-migration-ledger.sql \
    scripts/sync-impact-alert-access.sql scripts/sync-dead-letter-triage-access.sql ./scripts/
COPY scripts/self-host/run-database-setup.sh scripts/self-host/database-access.mjs ./scripts/self-host/
USER node
CMD ["bash", "/app/scripts/self-host/run-database-setup.sh"]

FROM workspace AS dashboard-build
ARG NEXT_PUBLIC_AXEL_APP_URL=http://localhost:8080
ARG NEXT_PUBLIC_AXEL_INGEST_URL=https://ingest.example.invalid
ARG NEXT_PUBLIC_AXEL_DELIVERY_URL=http://localhost:8080
ENV NEXT_PUBLIC_AXEL_APP_URL=$NEXT_PUBLIC_AXEL_APP_URL
ENV NEXT_PUBLIC_AXEL_INGEST_URL=$NEXT_PUBLIC_AXEL_INGEST_URL
ENV NEXT_PUBLIC_AXEL_DELIVERY_URL=$NEXT_PUBLIC_AXEL_DELIVERY_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV AXEL_STANDALONE_BUILD=1
RUN cp apps/dashboard/public/openapi.yaml infra/self-host/openapi.template.yaml \
    && node scripts/self-host/render-openapi.mjs \
      apps/dashboard/public/openapi.yaml \
      "$NEXT_PUBLIC_AXEL_APP_URL" \
      "$NEXT_PUBLIC_AXEL_INGEST_URL" \
    && pnpm --filter @axel/shared build \
    && pnpm --filter @axel/dashboard build

FROM base AS dashboard
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/.next/standalone /app
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/.next/static /app/apps/dashboard/.next/static
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/public /app/apps/dashboard/public
COPY --from=dashboard-build /app/infra/self-host/openapi.template.yaml /app/infra/self-host/openapi.template.yaml
COPY scripts/self-host/start-dashboard.sh scripts/self-host/render-openapi.mjs /app/scripts/self-host/
WORKDIR /app/apps/dashboard
USER node
EXPOSE 3000
ENTRYPOINT ["bash", "/app/scripts/self-host/start-dashboard.sh"]
CMD ["node", "server.js"]

FROM workspace AS delivery-build
RUN pnpm --filter @axel/shared build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @axel/delivery-service --prod deploy /opt/delivery

FROM base AS delivery
ENV NODE_ENV=production
COPY --from=delivery-build --chown=node:node /opt/delivery /app/apps/delivery-service
COPY scripts/delivery-canary.mjs /app/scripts/delivery-canary.mjs
COPY scripts/self-host/cron.mjs /app/scripts/self-host/cron.mjs
WORKDIR /app/apps/delivery-service
USER node
EXPOSE 10000
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server.ts"]
