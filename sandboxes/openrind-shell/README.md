# Openrind Shell Sandbox Image

This directory contains the OpenShell sandbox image used by the end-user command in the repository README.

Published image:

```text
ghcr.io/openrind/openrind-shell/sandbox:just-bash
```

## Build Locally

```bash
docker build -f sandboxes/openrind-shell/Dockerfile -t openrind-shell-sandbox:local .
```

## Launch From The Published Image

```bash
openshell gateway start

openshell sandbox create --tty \
  --from ghcr.io/openrind/openrind-shell/sandbox:just-bash \
  --provider claude --auto-providers \
  -- openrind-shell
```

## Launch With PostgreSQL Persistence

PostgreSQL credentials must be uploaded as a plaintext file. Do not use a generic OpenShell provider for `DATABASE_URL`; provider placeholders are for HTTP credential injection and are not usable by raw PostgreSQL clients.

```bash
printf '%s' "$DATABASE_URL" > /tmp/openrind-shell-db-url
chmod 600 /tmp/openrind-shell-db-url

openshell sandbox create --tty \
  --from ghcr.io/openrind/openrind-shell/sandbox:just-bash \
  --upload /tmp/openrind-shell-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- openrind-shell

rm -f /tmp/openrind-shell-db-url
```

## What `setup.sh` Does

1. Resolves persistence from `DATABASE_URL`, `OPENRIND_SHELL_DATABASE_URL`, `POSTGRES_URL`, or uploaded `/sandbox/db-url`.
2. Creates a normalized Openrind Gateway proxy config when `OPENRIND_GATEWAY_API_KEY` is attached.
3. Runs `_openrind` schema migrations.
4. Seeds the workspace keyed by `$OPENSHELL_SANDBOX_ID`.
5. Starts the `openrind-shell-bash` daemon.
6. Launches Claude Code with `HOME=/home/agent` and `SHELL=/usr/local/bin/openrind-shell-bash`.

## Image Contents

- Node.js 22 LTS.
- Openrind Shell compiled into `/opt/openrind-shell/dist/`.
- `openrind-shell-bash.mjs`, the daemon/client bridge for Claude Code's bash tool.
- `setup.sh`, the sandbox entry point.
- `policy.yaml`, the OpenShell network policy at `/etc/openshell/policy.yaml`.
