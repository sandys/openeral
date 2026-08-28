# Openrind Shell primary sandbox: OpenShell-mounted PostgreSQL FUSE workspace.

FROM rust:1.95-bookworm AS fused-builder

WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY sandboxes/openeral/openclaw-agent-launcher.c ./
RUN cargo build --locked --release -p openeral-fused \
    && cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra -Werror \
        -o openrind-openclaw-agent openclaw-agent-launcher.c \
    && strip target/release/openeral-fused openrind-openclaw-agent

FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

LABEL com.openrind.desktop.fuse-contract="fuse-openclaw-identity-v19"

USER root

ARG OPENCLAW_VERSION=2026.7.1-2

# Refresh Node.js 22 from NodeSource. The current upstream base pins 22.22.1,
# which its Dockerfile documents as affected by multiple known CVEs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error "openclaw@${OPENCLAW_VERSION}" \
    && test -x /usr/bin/openclaw \
    && test -f /usr/lib/node_modules/openclaw/openclaw.mjs \
    && rm -rf /var/lib/apt/lists/*

# TypeScript owns migrations and one-time legacy import. Rust never migrates.
COPY openeral-js/ /opt/openrind-shell/
RUN cd /opt/openrind-shell && npm install && npm run build && npm prune --omit=dev \
    && chmod -R a+rX /opt/openrind-shell \
    && chown -R sandbox:sandbox /opt/openrind-shell \
    && ln -s /opt/openrind-shell /opt/openeral

# The OpenShell Community base installs Claude with Anthropic's native
# installer. Preserve it behind Openrind Shell's persistence-aware wrapper.
RUN test -x /usr/local/bin/claude \
    && mv /usr/local/bin/claude /usr/local/bin/claude-real

# The supervisor validates this root-owned binary and supplies /dev/fuse and
# readiness descriptors. No fusermount helper or workload mount capability ships.
COPY --from=fused-builder /source/target/release/openeral-fused /usr/local/bin/openrind-shell-fused
# OpenShell authorizes this kernel-visible parent, never the shared Node runtime.
COPY --from=fused-builder /source/openrind-openclaw-agent /usr/local/bin/openrind-openclaw-agent

COPY sandboxes/openeral/openeral-claude-fuse.sh /usr/local/bin/claude
COPY sandboxes/openeral/pg-client-fuse.mjs /usr/local/bin/pg
COPY sandboxes/openeral/setup-fuse.sh /opt/openrind-shell/setup.sh
COPY sandboxes/openeral/openrind-pty-bridge.py /opt/openrind-shell/openrind-pty-bridge.py
COPY sandboxes/openeral/configure-stringcost.mjs /opt/openrind-shell/configure-openrind-gateway.mjs
COPY sandboxes/openeral/configure-openclaw-fuse.mjs /opt/openrind-shell/configure-openclaw-fuse.mjs
COPY sandboxes/openeral/openrind-openclaw-fuse.sh /usr/local/bin/openrind-openclaw
COPY sandboxes/openeral/supabase-root-2021-ca.pem /opt/openrind-shell/certs/supabase-root-2021-ca.pem
RUN chmod 755 /usr/local/bin/openrind-shell-fused /usr/local/bin/claude /usr/local/bin/pg \
        /usr/local/bin/openrind-openclaw /usr/local/bin/openrind-openclaw-agent \
        /opt/openrind-shell/setup.sh /opt/openrind-shell/openrind-pty-bridge.py \
        /opt/openrind-shell/configure-openrind-gateway.mjs \
        /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && chmod 644 /opt/openrind-shell/certs/supabase-root-2021-ca.pem \
    && install -m 0644 /opt/openrind-shell/certs/supabase-root-2021-ca.pem /usr/local/share/ca-certificates/supabase-root-2021-ca.crt \
    && cat /opt/openrind-shell/certs/supabase-root-2021-ca.pem >> /etc/ssl/certs/ca-certificates.crt \
    && sed -i 's/\r$//' /usr/local/bin/claude /usr/local/bin/pg \
        /usr/local/bin/openrind-openclaw \
        /opt/openrind-shell/setup.sh /opt/openrind-shell/openrind-pty-bridge.py \
        /opt/openrind-shell/configure-openrind-gateway.mjs \
        /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && bash -n /usr/local/bin/openrind-openclaw \
    && node --check /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && printf '%s' fuse-openclaw-identity-v19 > /opt/openrind-shell/desktop-contract \
    && ln -sf /usr/local/bin/openrind-shell-fused /usr/local/bin/openeral-fused \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell-init \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell-start \
    && ln -sf /usr/local/bin/openrind-shell /usr/local/bin/openeral \
    && ln -sf /usr/local/bin/openrind-shell-init /usr/local/bin/openeral-init \
    && ln -sf /usr/local/bin/openrind-shell-start /usr/local/bin/openeral-start \
    && install -d -o sandbox -g sandbox -m 0700 \
        /var/lib/openrind-shell/runtime /sandbox/claude-home /sandbox/openclaw-home

# Override the upstream base policy
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Bundled skills are copied into the mounted home by one-shot init without
# overwriting user-owned files.
COPY --chown=root:root .claude/skills/ /opt/openrind-shell/skills/

WORKDIR /sandbox
