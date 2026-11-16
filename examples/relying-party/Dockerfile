# syntax=docker/dockerfile:1

# The example application as an image, for trying pforte on a server together with an application
# (examples/swarm). Build it from the root of the repository, which holds the lockfile:
#
#   docker build -f examples/relying-party/Dockerfile -t pforte-example-app .
#
# The base image is the one of pforte's own Dockerfile, pinned by digest; a test keeps the two the same.

# --- Build: install the one dependency from the lockfile
FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src
RUN npm install --global pnpm@12.11.2
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @progwise/pforte-example-relying-party
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm --filter @progwise/pforte-example-relying-party deploy --prod --legacy /deploy

# --- Run
FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
LABEL org.opencontainers.image.title="pforte example application" \
      org.opencontainers.image.description="A minimal relying party that signs in with pforte. For trying things, not for production." \
      org.opencontainers.image.source="https://github.com/progwise/pforte" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    PORT=3400
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/src ./src

# Nothing is written to disk: sessions are in memory, and gone with the container.
USER node
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3400) + '/manifest.webmanifest').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

# Node runs the TypeScript file as it is: the types are stripped, nothing is compiled.
CMD ["node", "src/server.ts"]
