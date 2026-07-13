FROM node:22-bookworm-slim

ARG OPENRIND_DESKTOP_ORCHESTRATOR_VERSION=0.11.22

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openrind-desktop-orchestrator@${OPENRIND_DESKTOP_ORCHESTRATOR_VERSION}"

# Persistent directories (mount volumes here on PaaS/SSH).
ENV OPENRIND_DESKTOP_DATA_DIR=/data/openrind-desktop-orchestrator
ENV OPENRIND_DESKTOP_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENRIND_DESKTOP_WORKSPACE=/workspace

# OpenrindDesktop host contract surface.
EXPOSE 8787

# Optional: opencode-router health (only relevant if you enable the router).
EXPOSE 3005

VOLUME ["/workspace", "/data"]

# Defaults:
# - OpenrindDesktop server is published intentionally via --remote-access
# - OpenCode stays internal (127.0.0.1:4096)
# - OpenrindDesktop server proxies OpenCode via localhost
# - OpenCode Router disabled by default
CMD [
  "openrind-desktop",
  "serve",
  "--workspace", "/workspace",
  "--remote-access",
  "--openrind-desktop-port", "8787",
  "--opencode-host", "127.0.0.1",
  "--opencode-port", "4096",
  "--connect-host", "127.0.0.1",
  "--cors", "*",
  "--approval", "manual",
  "--no-opencode-router"
]
