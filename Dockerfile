FROM node:22-bookworm-slim AS workspace
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM workspace AS dashboard-build
ARG NEXT_PUBLIC_AXEL_APP_URL=http://localhost:8080
ARG NEXT_PUBLIC_AXEL_INGEST_URL
ARG NEXT_PUBLIC_AXEL_DELIVERY_URL
ENV NEXT_PUBLIC_AXEL_APP_URL=$NEXT_PUBLIC_AXEL_APP_URL
ENV NEXT_PUBLIC_AXEL_INGEST_URL=$NEXT_PUBLIC_AXEL_INGEST_URL
ENV NEXT_PUBLIC_AXEL_DELIVERY_URL=$NEXT_PUBLIC_AXEL_DELIVERY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN node scripts/self-host/render-openapi.mjs \
      apps/dashboard/public/openapi.yaml \
      "$NEXT_PUBLIC_AXEL_APP_URL" \
      "$NEXT_PUBLIC_AXEL_INGEST_URL" \
    && pnpm --filter @axel/shared build \
    && pnpm --filter @axel/dashboard build

FROM node:22-bookworm-slim AS dashboard
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dashboard-build --chown=node:node /app /app
WORKDIR /app/apps/dashboard
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

FROM workspace AS delivery-build
RUN pnpm --filter @axel/shared build

FROM node:22-bookworm-slim AS delivery
ENV NODE_ENV=production
COPY --from=delivery-build --chown=node:node /app /app
WORKDIR /app/apps/delivery-service
USER node
EXPOSE 10000
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server.ts"]
