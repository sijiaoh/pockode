# Stage 1: Build Go application
FROM golang:1.25.4-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go module files for caching
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . ./

# Build the binary (TARGETARCH is set by Docker BuildKit)
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags="-w -s" \
    -o server .

# Stage 2: Runtime with Claude CLI (also serves as dev environment)
FROM ubuntu:24.04

# Install runtime dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user and workspace
RUN groupadd -r pockode && useradd -r -g pockode -m pockode \
    && mkdir -p /workspace && chown pockode:pockode /workspace

# Copy the binary from builder
COPY --from=builder --chown=pockode:pockode /app/server /usr/local/bin/server

# Switch to non-root user and install Claude CLI
USER pockode
ENV HOME=/home/pockode
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /workspace

# Environment variables
ENV PORT=8080
ENV WORK_DIR=/workspace
ENV DEV_MODE=false
ENV PATH="/home/pockode/.local/bin:${PATH}"

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["/usr/local/bin/server"]
