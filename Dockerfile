# syntax=docker/dockerfile:1

# The base image is pinned by digest; Dependabot proposes new ones.
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# --- Build: bundle our own code, and install the third-party packages from the lockfile
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install --global pnpm@12.11.2
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @progwise/pforte-server build
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm --filter @progwise/pforte-server deploy --prod --legacy /deploy
# The packages of this repository are in the bundle already.
RUN rm -rf /deploy/node_modules/@progwise

# --- Run
FROM ${NODE_IMAGE}
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="pforte" \
      org.opencontainers.image.description="A small, self-hosted OpenID Connect identity service" \
      org.opencontainers.image.source="https://github.com/progwise/pforte" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    PORT=3300 \
    PFORTE_VERSION=${VERSION} \
    NODE_OPTIONS=--enable-source-maps
# pforte needs neither npm nor corepack: less to patch and to scan.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /src/apps/server/dist/ ./
COPY --from=build /src/packages/db/drizzle ./drizzle

# Nothing is written to disk: the image runs with a read-only root filesystem.
USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3300) + '/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/pforte.mjs"]
CMD ["start"]
