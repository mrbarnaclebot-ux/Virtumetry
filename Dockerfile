# Virtumetry backend: one image for BOTH services (api + worker).
# Lives at repo root because Railway builds with the upload root as context.
# CMD dispatches on SERVICE_ENTRY:  node dist/${SERVICE_ENTRY:-server}.js
#   SERVICE_ENTRY=server  -> Fastify API (default)
#   SERVICE_ENTRY=worker  -> job queue worker
#
# Node only. trixie-slim is the base already proven in production; Node 24
# matches package.json `engines: >=24`. Multi-stage: the build stage carries dev
# deps + the TS toolchain, the runtime stage gets only dist + prod node_modules.

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim
WORKDIR /app
# package.json is load-bearing: its "type": "module" makes dist/*.js ESM.
COPY --chown=node:node backend/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# migrate.ts applies ../drizzle (committed migration SQL); drizzle-kit is a
# pruned devDependency, so preDeploy runs dist/migrate.js against this folder.
COPY --chown=node:node backend/drizzle ./drizzle
# The mock provider's import step reads ../../test/fixtures/mock-outputs from
# dist/provider/mock.js (dev only, ~25 KB synthetic files, no user data).
COPY --chown=node:node backend/test/fixtures/mock-outputs ./test/fixtures/mock-outputs
# Dev-only synthetic demo room (~4 MB) served when MOCK_OUTPUTS_SET=demo-room.
COPY --chown=node:node backend/test/fixtures/demo-room ./test/fixtures/demo-room
USER node
ENV NODE_ENV=production
# exec: node replaces sh as PID 1 and receives Railway's SIGTERM directly.
CMD ["sh", "-c", "exec node dist/${SERVICE_ENTRY:-server}.js"]
