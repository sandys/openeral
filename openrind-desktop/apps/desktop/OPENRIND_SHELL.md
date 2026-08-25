# Openrind Desktop + Openrind Shell FUSE

This document describes the desktop integration for the repository's primary
FUSE runtime. The root [`README.md`](../../../README.md) is the source of truth
for image creation, persistence, initialization, and security.

## User flow

1. Install the bundled OpenShell stack from **Settings -> Sandbox**.
2. Save a PostgreSQL session-mode `DATABASE_URL` and `ANTHROPIC_API_KEY` in
   **Settings -> Environment**.
3. Create an **Openrind Shell - Claude Code** sandbox.
4. Use Claude directly in the embedded WebGL terminal.

The user does not start a gateway, run `claude`, upload a credential manually,
or mount a filesystem manually. Openrind Desktop owns those steps.

## Desktop provisioning contract

Openrind Desktop installs and starts a paired system service named
`openrind-desktop-fuse-gateway.service`. It runs the matched patched OpenShell
CLI, gateway, and supervisor from `/opt/openrind-desktop/fuse-runtime` on
`http://127.0.0.1:18770` with the Docker driver and `enable_fuse = true`.

Source checkouts use `openrind-shell-fuse:local` with pull policy `Never`.
Packaged builds use `ghcr.io/openrind/openrind-shell/sandbox:fuse` with pull
policy `IfNotPresent`. The image must expose the desktop contract recorded in
`/opt/openrind-shell/desktop-contract`; incompatible containers are recreated
without deleting their PostgreSQL-backed workspaces.

The first sandbox creation follows the root README command shape exactly:

```text
openshell --gateway-endpoint http://127.0.0.1:18770 sandbox create
  --name <sandbox>
  --from <fuse-image>
  --fuse
  --upload <mode-0600-db-file>:/sandbox/db-url
  --provider claude
  --auto-providers
  --env OPENRIND_SHELL_WORKSPACE_ID=<workspace>
  --no-tty
  -- openrind-shell-init
```

`openrind-shell-init` is the one-shot README initializer. It migrates the
schema, waits for the supervisor-owned FUSE daemon's writer lease, validates
the required durability canary, seeds Claude state, writes `init.done`, flushes,
deletes the uploaded database file, and exits. Openrind Desktop does not run a
second initializer or a parallel upload/poll loop.

## Credentials

- `DATABASE_URL` is read from Electron `safeStorage`, sent to the WSL helper on
  stdin, written to a temporary mode-0600 file, and uploaded only for init.
- `ANTHROPIC_API_KEY` is read in the Electron main process and supplied to the
  local patched CLI through `WSLENV` while creating/updating the gateway-owned
  `claude` provider. The key is not placed in terminal environment variables or
  persisted in `/sandbox/work`.
- The native Claude executable is `/usr/local/bin/claude-real`; the
  `/usr/local/bin/claude` wrapper enforces initialized, writable FUSE storage
  and performs the final `flush-all`.

## Interactive terminal

The desktop launch is an extension of the README's manual connect flow:

1. Electron writes a consume-once session marker outside the FUSE mount.
2. `openshell sandbox connect <name>` opens the normal forced SSH TTY.
3. The sandbox `.bashrc` consumes the marker and starts Claude automatically
   from `/sandbox/work`.
4. `/opt/openrind-shell/openrind-pty-bridge.py` owns the only Linux PTY used by
   Claude. Electron talks to `wsl.exe` over plain pipes, avoiding Windows
   ConPTY's TUI reserialization.
5. The first in-band `OPENRINDPTY1` handshake selects framed mode and carries
   the initial geometry. Later input and resize frames are forwarded to the
   Linux PTY; Claude output returns as raw bytes to xterm.js WebGL.

The image policy grants the bridge read/write access to `/dev/pts`. This is
required for `os.openpty()` after Landlock is active; Claude still receives no
`/dev/fuse`, mount capability, or filesystem-daemon privilege.

Normal manual `sandbox connect` sessions have no desktop marker and therefore
remain a shell, as documented by the root README.

## Persistence and lifecycle

Claude's `HOME` and cwd are `/sandbox/work`. All normal project files, Claude
settings, and transcripts therefore traverse the supervisor-mounted FUSE
filesystem and PostgreSQL durability path. Deleting a sandbox removes its
container but retains the database workspace for the same workspace ID.

Warm reconnects reuse a Ready container only when its image contract matches,
the bridge exists, and `openrind-shell-fused health` reports `writable`.
Navigation detaches the renderer while the main process retains the live PTY
and bounded raw scrollback; returning to a session reattaches without restarting
Claude.

## Troubleshooting

- **Gateway missing:** use **Settings -> Sandbox -> Restart gateway**. Do not
  start a second stock gateway.
- **Local image missing/outdated:** rebuild the root `Dockerfile.openrind-shell`
  as `openrind-shell-fuse:local`. Source mode intentionally never pulls it.
- **Published image unavailable:** confirm GHCR access to the `:fuse` package.
- **Database initialization fails:** use a TLS PostgreSQL URL and Supabase
  session pooling on port 5432, not transaction pooling on 6543.
- **Terminal is blank:** inspect the private bridge diagnostic and confirm the
  image contract is current. Bridge failures now emit a visible terminal error;
  a v4 image includes Python, the bridge, CRLF-safe launch scripts, and the
  `/dev/pts` policy permission.
- **Terminal rendering is damaged:** WebGL is the production renderer. The DOM
  renderer is an explicit recovery option only. Raw PTY dumps can be captured
  with the existing `openrindPtyDumpBuffer` diagnostic to separate transport
  bytes from renderer behavior.
