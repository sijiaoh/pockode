# Stage 1: Build frontend
FROM node:24.21.0-alpine AS frontend-builder

WORKDIR /app
RUN npm install -g pnpm@10

# Installed from the workspace root, not from web/: web depends on
# @pockode/shared through pnpm-workspace.yaml, and only the root lockfile
# describes how that resolves. Every member's manifest has to be present or
# --frozen-lockfile calls the lockfile stale for the ones it cannot find, so the
# manifests are copied on their own first and the sources only afterwards —
# editing a component must not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY web/package.json ./web/
COPY web-cluster/package.json ./web-cluster/
RUN pnpm install --frozen-lockfile --filter web...

COPY packages/shared/ ./packages/shared/
COPY web/ ./web/
# The local favicon is a symlink outside web/, so copy the target into the image.
RUN rm -f web/public/favicon.svg
COPY site/static/images/logo.svg ./web/public/favicon.svg
RUN pnpm --filter web run build

# Stage 2: Build backend
FROM golang:1.25.4-alpine AS backend-builder

WORKDIR /app
RUN apk add --no-cache git ca-certificates

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY --from=frontend-builder /app/web/dist ./static/

COPY server/ ./
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags="-w -s" \
    -o server .

# Stage 3: Runtime
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r pockode && useradd -r -g pockode -m pockode \
    && mkdir -p /workspace && chown pockode:pockode /workspace

USER pockode
ENV HOME=/home/pockode
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /workspace
COPY --from=backend-builder --chown=pockode:pockode /app/server /usr/local/bin/server

ENV PATH="/home/pockode/.local/bin:${PATH}"

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Default command with required --auth-token to be overridden at runtime
ENTRYPOINT ["/usr/local/bin/server"]
CMD ["--port=8080", "--work=/workspace"]
