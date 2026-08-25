# Openrind Shell Sandbox Images

This directory contains two different runtimes. Do not mix their Dockerfiles, setup
scripts, wrappers, or persistence claims.

## Primary FUSE Image

Files:

```text
Dockerfile
setup-fuse.sh
openeral-claude-fuse.sh
pg-client-fuse.mjs
configure-stringcost.mjs  # legacy source filename, installed as configure-openrind-gateway.mjs
policy.yaml
```

The repository-root `Dockerfile.openrind-shell` is the canonical local-build entrypoint
because it has access to the Rust and TypeScript source trees. Keep this directory's
Dockerfile equivalent.

The primary image requires:

- the patched OpenShell Docker driver and explicit `--fuse` request;
- Docker operator config `enable_fuse = true` and host `/dev/fuse`;
- external PostgreSQL with TLS;
- `--upload <mode-0600-file>:/sandbox/db-url`;
- a stable `OPENRIND_SHELL_WORKSPACE_ID`.

It declares one root-owned mount policy:

```yaml
fuse_mounts:
  - binary: /usr/local/bin/openrind-shell-fused
    args: ["serve"]
    mountpoint: /sandbox/work
    fs_name: openrind-shell
```

OpenShell mounts before its supervisor seccomp prelude, then launches the daemon as a
normal hardened sandbox child with inherited FUSE and readiness descriptors. Claude
does not receive `/dev/fuse` or mount capability.

`openrind-shell-init` is the trailing one-shot command. It runs migrations/import, publishes
database coordination, waits for the writer lease, verifies that lease in PostgreSQL,
performs a mounted fsync canary, prepares the local Claude home, removes the uploaded URL, and
exits. The FUSE daemon is already a supervisor-owned critical child; init does not
launch or detach it.

Claude runs through the installed Openrind Shell wrapper (source file
`openeral-claude-fuse.sh`) with `HOME=/sandbox/claude-home` and cwd `/sandbox/work`.
The home path is a per-workspace Docker named volume; project files remain on FUSE.
`/exit` or `Ctrl+D` returns to the shell after `flush-all`; `claude -c` resumes the
latest session from the local home volume.

No watcher or PGlite process participates in primary persistence.

## Compatibility Image

Files:

```text
Dockerfile.compat
setup.sh
openeral-bash.mjs
openeral-daemon-ensure.sh
openeral-claude.sh
pg-client.mjs
```

The repository-root `Dockerfile.openrind-shell-compat` builds this runtime. It strips
`fuse_mounts` and daemon-specific policy entries from the shared policy, rewrites
primary `/sandbox/work` tool paths back to `/sandbox`, and does not install
`openrind-shell-fused`.

Compatibility mode supports optional PostgreSQL or sandbox-lifetime PGlite. With
PostgreSQL, its detached Node daemon watches and syncs only `.claude`, `.claude.json`,
`.openrind-shell`, and legacy `.openeral`. It remains the implementation behind
`ghcr.io/openrind/openrind-shell/sandbox:just-bash`.

## PostgreSQL Policy

The shared production policy permits raw CONNECT tunnels to Supabase poolers on 5432
and 6543. The primary FUSE runtime accepts only session mode (5432): its one-writer
lease is a session-level advisory lock, so `openrind-shell-init` rejects 6543
(transaction pooling); the compatibility runtime may use either port. PostgreSQL
negotiates TLS end to end inside the tunnel, so the OpenShell
endpoint must use `tls: skip` rather than HTTP/TLS inspection.

A custom database host needs an exact route. Primary mode must authorize both Node
(migrations/init) and the Rust daemon:

```yaml
postgres:
  endpoints:
    - { host: db.example.com, port: 5432, tls: skip }
  binaries:
    - { path: /usr/bin/node }
    - { path: /usr/local/bin/openrind-shell-fused }
```

## Local Build

From the repository root:

```bash
docker build --pull=false -f Dockerfile.openrind-shell -t openrind-shell-fuse:local .
docker build --pull=false -f Dockerfile.openrind-shell-compat -t openrind-shell-compat:local .
```

Both inherit `ghcr.io/nvidia/openshell-community/sandboxes/base:latest`. Do not rebuild
that base to work around a registry or local-image configuration problem.

Primary launch and E2E instructions are in the repository [README](../../README.md)
and [BUILD](../../BUILD.md).
