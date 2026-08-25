# Bake the Ubuntu 24.04 + Docker Engine + OpenShell CLI rootfs that
# installer.mjs phaseDistro imports via `wsl --import`. We build on
# Linux (Docker) rather than spinning up WSL on a Windows GHA runner
# because:
#   1. Docker on Linux is ~10x faster, more reliable, and cheaper to run.
#   2. `wsl --import` accepts any rootfs tarball; the source doesn't
#      have to come from another WSL distro.
#   3. We avoid the rancher-desktop/distrod fragility of running WSL
#      inside Hyper-V inside a GHA Windows VM.
#
# The driver (build-openshell-rootfs.sh) runs:
#   docker build -> docker create -> docker export | gzip
# and drops the result at apps/desktop/resources/openshell/.

FROM rust:1.95-bookworm AS openshell-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        clang libclang-dev libz3-dev pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY vendor/openshell/ ./
RUN cargo build --locked --release \
        -p openshell-cli \
        -p openshell-server \
        -p openshell-sandbox \
    && strip target/release/openshell \
        target/release/openshell-gateway \
        target/release/openshell-sandbox

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages the installer phases assume: ca-certificates, curl, and gpg
# for adding the Docker apt repo; sudo for local maintenance; and
# iproute2/net-tools for OpenShell's network probes.
#
# systemd-sysv / dbus / dbus-user-session / policykit-1 are mandatory:
# without them WSL's /init does not run systemd as PID 1, so Docker and the
# root-owned paired OpenShell FUSE gateway service cannot start.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dbus \
        dbus-user-session \
        gnupg \
        iproute2 \
        less \
        libz3-4 \
        net-tools \
        openssh-client \
        openssl \
        policykit-1 \
        procps \
        sudo \
        systemd \
        systemd-sysv \
    && rm -rf /var/lib/apt/lists/*

# openssh-client is required for `openshell sandbox connect / upload /
# download / exec` — the CLI runs `ssh` and `scp` locally to reach the
# sandbox container over the supervisor SSH relay. Without it every
# operation fails with the cryptic `Error: × No such file or directory
# (os error 2)` (Rust's stringified ENOENT from a failed exec()).

# Non-root default user. Matches the OpenShell convention of
# `run_as_user: sandbox` in policy.yaml.
RUN useradd -m -s /bin/bash -G sudo banker \
    && echo 'banker ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

# Docker Engine — same recipe installer.mjs phaseDocker runs at first
# launch, but pre-baked so banker laptops on slow/blocked corporate
# networks never have to fetch it themselves. Pinned to noble (24.04).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
    && usermod -aG docker banker \
    && rm -rf /var/lib/apt/lists/*

# Patched OpenShell FUSE control-plane binaries.
# The primary image needs the repository's pinned FUSE patch in all three
# OpenShell components. Bake that matched CLI/gateway/supervisor trio into the
# distro; never replace it at runtime with a stock installer release.
COPY --from=openshell-builder /source/target/release/openshell /opt/openrind-desktop/fuse-runtime/openshell
COPY --from=openshell-builder /source/target/release/openshell-gateway /opt/openrind-desktop/fuse-runtime/openshell-gateway
COPY --from=openshell-builder /source/target/release/openshell-sandbox /opt/openrind-desktop/fuse-runtime/openshell-sandbox
RUN chmod 0755 /opt/openrind-desktop/fuse-runtime/openshell \
        /opt/openrind-desktop/fuse-runtime/openshell-gateway \
        /opt/openrind-desktop/fuse-runtime/openshell-sandbox \
    && printf '%s' bundled-fuse-v1 > /opt/openrind-desktop/fuse-runtime/source-id \
    && ln -sf /opt/openrind-desktop/fuse-runtime/openshell /usr/local/bin/openshell

# wsl.conf — tells WSL to use systemd as PID 1 (required for
# `service docker start` and openshell's gateway pod) and pins the
# default user to `banker`.
RUN printf '[boot]\nsystemd=true\n[user]\ndefault=banker\n' > /etc/wsl.conf

# Sanity-check the binaries the installer expects, so a regression in
# the upstream OpenShell install script breaks the build here instead
# of breaking a banker laptop weeks later.
RUN which docker && docker --version \
    && which openshell && openshell --version
