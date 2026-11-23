# VirtSpace backend — single image for BOTH services (API + worker).
# Lives at repo root because Railway builds with the upload root as context.
# CMD dispatches on SERVICE_ENTRY:  node dist/${SERVICE_ENTRY:-server}.js
#   SERVICE_ENTRY=server  → Fastify API      (default)
#   SERVICE_ENTRY=worker  → job queue worker (runs the Python stitcher)
#
# The worker shells out to stitcher/reproject.py, so this image ships Python 3 +
# numpy + opencv-python-headless alongside Node. The API service never invokes
# Python but shares the same image for operational simplicity.
#
# Node 24 matches package.json `engines: >=24`.
#
# Pinned to the trixie variant ON PURPOSE (both stages): plain `node:24-slim` is
# Debian bookworm (python 3.11), and the stitcher's pinned numpy 2.5.x requires
# python >= 3.12 — the first Railway build failed on exactly that. trixie ships
# python 3.13, which is what stitcher/requirements.txt's cp313 wheels assume.
# The runtime stage MUST use the same base as the build stage: the venv copied
# across symlinks /usr/bin/python3 and holds cp313 wheels.
#
# Multi-stage (spec §10 R33): the build stage carries npm's dev dependencies,
# the TypeScript toolchain, pip and the source tree; the runtime stage gets only
# the compiled output, prod node_modules, the venv and the files read at runtime.

# ============================================================================
FROM node:24-trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python deps into an isolated venv (avoids PEP 668 conflicts) -------------
RUN python3 -m venv /opt/venv
COPY backend/stitcher/requirements.txt ./stitcher/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r stitcher/requirements.txt

# --- Node build: all deps to compile, then prune to prod-only -----------------
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# ============================================================================
FROM node:24-trixie-slim

# Runtime OS deps only: the interpreter the venv points at, plus the shared
# libraries opencv-headless loads (libGL/libglib). No pip, no venv tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV VIRTUAL_ENV=/opt/venv
# PYTHON_BIN defaults to python3, which resolves to the venv interpreter.
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY --from=build /opt/venv /opt/venv

# Runs as the stock unprivileged `node` user. Nothing under /app needs to be
# writable at runtime (the API writes nothing to disk; the worker only writes to
# mkdtemp() dirs under /tmp); --chown just keeps the tree owned by the user that
# reads it, without the duplicate layer a `chown -R` would add.
#
# package.json is load-bearing: its "type": "module" makes dist/*.js ESM.
COPY --chown=node:node backend/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Read at runtime via paths relative to dist/: worker.ts spawns
# ../stitcher/reproject.py; migrate.ts applies ../drizzle (committed migration
# SQL + snapshots; drizzle-kit is a pruned devDependency, so the release step
# runs dist/migrate.js against THIS folder).
COPY --chown=node:node backend/stitcher ./stitcher
COPY --chown=node:node backend/drizzle ./drizzle

USER node

ENV NODE_ENV=production
# exec: sh expands SERVICE_ENTRY, then REPLACES itself with node, so node is
# PID 1 and receives Railway's SIGTERM directly (npm/sh as PID 1 sat between
# the signal and the graceful-drain handlers). SERVICE_ENTRY: server | worker.
CMD ["sh", "-c", "exec node dist/${SERVICE_ENTRY:-server}.js"]
