# Openrind Desktop + Openrind Shell FUSE

This document describes the desktop integration for the repository's primary
FUSE runtime. The root [`README.md`](../../../README.md) is the source of truth
for image creation, persistence, initialization, and security.

## User flow

1. Install the bundled OpenShell stack from **Settings -> Sandbox**.
2. Save a PostgreSQL session-mode `DATABASE_URL` and `ANTHROPIC_API_KEY` in
   **Settings -> Environment**.
3. Create an **Openrind Shell - Claude Code** or **Openrind Shell - OpenClaw** sandbox.
4. Use the selected agent through the required Haloop route in the embedded WebGL terminal.

The user does not start a gateway, run `claude`, upload a credential manually,
or mount a filesystem manually. Openrind Desktop owns those steps.

## Desktop provisioning contract

Openrind Desktop installs and starts a paired system service named
`openrind-desktop-fuse-gateway.service`. It runs the matched patched OpenShell
CLI, gateway, and supervisor from `/opt/openrind-desktop/fuse-runtime` on
`http://127.0.0.1:18770` with the Docker driver and `enable_fuse = true`.

Source checkouts use `openrind-shell-fuse:local`, `haloop-gateway:local`, and
`haloop-collector:local` with pull policy `Never`; all three must exist in the
dedicated OpenShell WSL Docker daemon, not only in the host Docker Desktop daemon. Packaged builds use
`ghcr.io/openrind/openrind-shell/sandbox:fuse` with pull policy `IfNotPresent`.
The FUSE image must expose the desktop contract recorded in
`/opt/openrind-shell/desktop-contract`; the Haloop images must expose the
`openrind-haloop-v2` gateway and `openrind-haloop-collector-v1` collector
labels with matching version labels. Incompatible containers are recreated without
deleting their PostgreSQL-backed workspaces. A pinned published Haloop image is
still required before release packaging is complete.

From the `openeral` source root, build and validate all three development images in
the correct daemon with:

```powershell
node openrind-desktop/apps/desktop/scripts/build-openshell-runtime-images.mjs
```

Use `--haloop-only`, `--fuse-only`, or `--verify-only` for a focused run. The
script validates all three contract labels and the matching Haloop diagnostic versions after
the build. If the Haloop checkout is not the default sibling directory, set
`OPENRIND_DESKTOP_HALOOP_SOURCE` to its absolute path.

The first sandbox creation follows the root README command shape exactly:

```text
openshell --gateway-endpoint http://127.0.0.1:18770 sandbox create
  --name <sandbox>
  --from <fuse-image>
  --fuse
  --upload <mode-0600-db-file>:/sandbox/db-url
  --provider <desktop-created-scoped-haloop-provider>
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
- `ANTHROPIC_API_KEY` is read in the Electron main process and written only to
  the protected host-side Haloop route registry. The sandbox receives a
  workspace/sandbox/agent-scoped client token through an endpoint-bound
  OpenShell provider. Neither the upstream key nor the raw scoped token is
  placed in terminal environment variables or persisted in `/sandbox/work`.
- The server-owned route profile always installs synchronous `halo.mark` and
  `halo.export` hooks. Desktop starts the collector as an unprivileged private
  service with no published port, disables raw hook retention, and persists
  JSONL traces under `/var/lib/openrind-desktop/haloop/collector-data`.
- Every Desktop agent launch receives a profile-bound signed conversation
  assertion. The edge validates and removes it, then derives the canonical
  trace, route-root parent, and session IDs from its opaque context. Raw Desktop
  session IDs are not exposed to the edge or persisted trace metadata.
- **Settings -> Environment -> Rotate token** replaces the exact active
  workspace/sandbox/agent token. Desktop ends tracked in-app agents before
  withdrawing the old edge credential, rebuilds the server-owned registry, and
  refreshes the endpoint-bound OpenShell provider. The renderer never receives
  either token.
- Deleting a sandbox in Desktop first blocks new launches and ends tracked
  agents, then withdraws the edge before deleting every matching OpenShell
  provider and encrypted scoped token. Surviving profiles are rebuilt with
  unchanged tokens. If cleanup fails, Desktop does not delete the sandbox; the
  operation stays fail-closed and can be retried.
- The active route policy is `incumbent-only`: one direct Anthropic target with
  no candidate weight or model override. **Settings -> Environment -> Restore
  incumbent** atomically reapplies that approved registry and replaces only the
  gateway. Tokens, signed conversation keys, agent processes, collector data,
  and the FUSE workspace stay unchanged.
- The native Claude executable is `/usr/local/bin/claude-real`; the
  `/usr/local/bin/claude` wrapper enforces initialized, writable FUSE storage
  and performs the final `flush-all`.

## Interactive terminal

The desktop launch is an extension of the README's manual connect flow:

1. Electron writes a consume-once session marker outside the FUSE mount. It
   contains the agent conversation selector plus the signed Haloop context.
2. `openshell sandbox connect <name>` opens the normal forced SSH TTY.
3. The sandbox `.bashrc` consumes the marker and starts Claude or OpenClaw
   automatically from `/sandbox/work`, with the signed context installed only
   in that agent process's custom Haloop header.
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
remain a shell. Agent inference launched from that diagnostic shell has no
Desktop-issued conversation assertion and is rejected by the required edge.

## Persistence and lifecycle

Claude's `HOME` and cwd are `/sandbox/work`. All normal project files, Claude
settings, and transcripts therefore traverse the supervisor-mounted FUSE
filesystem and PostgreSQL durability path. Deleting a sandbox removes its
container but retains the database workspace for the same workspace ID. The
Desktop deletion path also revokes that sandbox's Haloop profiles before the
container is removed. Removing the last profile stops the managed gateway and
collector but retains the private trace store.

A confirmed **Settings -> Sandbox -> Reset distro** is the full integration
removal path. Desktop blocks new agent route preparation, waits for work already
entering the route, closes tracked agents, withdraws the Haloop edge, removes
every endpoint-bound provider and encrypted scoped token, then removes the
collector, plaintext registry, and private Docker network before unregistering
WSL. If runtime corruption prevents managed provider cleanup, Desktop first
terminates the dedicated distro, erases all encrypted host tokens, and lets
unregister destroy its inaccessible provider store. Failure to stop the distro
or erase those tokens aborts unregister. The reset deletes distro-local traces
and packages; it does not delete the external PostgreSQL FUSE workspace.

Warm reconnects reuse a Ready container only when its image contract matches,
the bridge exists, and `openrind-shell-fused health` reports `writable`.
Navigation detaches the renderer while the main process retains the live PTY
and bounded raw scrollback; returning to a session reattaches without restarting
Claude.

The main process also emits trusted Haloop AGENT lifecycle spans for normal
completion, process crashes, explicit Desktop cancellation, sandbox deletion,
and app shutdown. These events retain the server-owned route identity and are
best-effort after launch, so a collector interruption cannot terminate model
traffic that is already in flight.

## Troubleshooting

- **Gateway missing:** use **Settings -> Sandbox -> Restart gateway**. Do not
  start a second stock gateway.
- **Local image missing/outdated:** use the runtime-image builder to rebuild
  `openrind-shell-fuse:local`, `haloop-gateway:local`, and
  `haloop-collector:local` in the dedicated OpenShell WSL Docker daemon. Source
  mode intentionally never pulls these local images.
- **Haloop unavailable:** open **Settings -> Environment** and inspect the
  required Haloop route status. If an active route is shown, use **Restart
  Haloop** to restart only the Desktop-managed gateway and private collector;
  the FUSE sandbox and its workspace are not recreated. Resolve any reported
  private-network, fixed-port, image, or authentication error before retrying;
  Desktop does not bypass Haloop.
- **Candidate routing must be rolled back:** use **Restore incumbent** and
  confirm the bounded gateway replacement. Existing agents stay connected and
  keep their conversation identity, but a model request already in flight may
  need to be retried. Restore requires a healthy version-matched collector; use
  **Restart Haloop** first when full-service repair is needed. If restore fails,
  fix the reported ownership, image, or health problem and retry; never switch
  the sandbox directly to Anthropic.
- **Trace capture incomplete:** model routing never switches to a direct
  provider. Inspect the collector status and trusted-span counters in
  **Settings -> Environment**, restart Haloop, and launch a new agent request.
- **Conversation context expired:** close the affected agent process and launch
  it again from Desktop. Signed contexts are intentionally bounded to seven
  days; reattaching preserves an existing process and does not refresh the
  header already held by that process.
- **Scoped token may be compromised:** use **Rotate token** on the active route.
  The sandbox and FUSE workspace remain intact, but all affected agents must be
  relaunched. Desktop ends tracked in-app sessions automatically; close and
  relaunch any external agent terminal yourself. Rotation failures stay on the
  mandatory Haloop path and do not restore the invalidated token.
- **Sandbox deletion fails during credential cleanup:** the sandbox is
  intentionally left in place and new launches remain on the mandatory Haloop
  path. Resolve the reported OpenShell provider or managed-container ownership
  error, then retry deletion; do not bypass cleanup with a raw OpenShell delete.
- **Distro reset fails during integration cleanup:** no new agent is launched
  during the failed attempt. Resolve the reported WSL termination or encrypted
  credential-storage error and use **Reset distro** again; do not unregister the
  distro manually while scoped credentials remain stored.
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
