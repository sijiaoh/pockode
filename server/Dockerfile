# Stage 1: Build frontend
FROM node:24.13.1-alpine AS frontend-builder

WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

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

ENV SERVER_PORT=8080
ENV WORK_DIR=/workspace
ENV DEV_MODE=false
ENV PATH="/home/pockode/.local/bin:${PATH}"

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["/usr/local/bin/server"]
