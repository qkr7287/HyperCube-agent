# Debian base (glibc) instead of node:20-alpine (musl). Required so the
# host's nvidia-smi binary — injected by nvidia-container-toolkit when the
# nvidia runtime is active — can execute inside the container. Alpine/musl
# silently fails to exec glibc binaries with the misleading
# `no such file or directory` error. Mirrors Dockerfile.dev which already
# uses bookworm-slim for the same reason.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
# procps provides `ps`, which systeminformation's si.processes() shells out to.
# docker-ce-cli + docker-compose-plugin power the compose-up/down handlers.
# pciutils/iproute2/net-tools used by various system collectors.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      pciutils iproute2 net-tools procps && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
