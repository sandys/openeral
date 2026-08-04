# Openrind Desktop × Openrind Shell

How to run **Claude Code** (or **OpenClaw**) inside an Openrind Shell sandbox,
embedded directly in an Openrind Desktop workspace.

Openrind Shell (https://github.com/openrind/openrind-shell) is a pre-built
OpenShell sandbox image — `ghcr.io/openrind/openrind-shell/sandbox:just-bash` —
that runs Claude Code as a foreground TTY process with a
PostgreSQL-backed `/home/agent`. Openrind Desktop wraps the install, lifecycle,
and TTY plumbing so a banker can pick "Claude Code" as their agent and
have it just work.

---

## Prerequisites

- Windows 11 (build 22000 or later) with WSL2 enabled
- The Openrind Desktop OpenShell installer has run successfully
  (Settings → Sandbox → all green)
- Docker Engine running inside the `openrind-desktop-openshell` distro
  (auto-installed by the installer)
- A reachable PostgreSQL connection string — Supabase, Neon, or any
  firm-internal Postgres reachable from inside the WSL distro
- An Anthropic API key (`sk-ant-...`)

---

## Step 1 — configure credentials

Openrind Shell needs two credentials at session start:

1. **`DATABASE_URL`** — a `postgresql://...` connection string. Openrind Shell
   creates the `_openrind` schema there on first run; the sandbox's
   `/home/agent` is persisted to that schema and restores across
   sessions and machines as long as you reuse the same workspace.

2. **`ANTHROPIC_API_KEY`** — only required for the **OpenClaw** profile.
   Claude Code can use the OpenShell provider system instead, but
   configuring the key here is fine for both.

3. **`OPENRIND_GATEWAY_API_KEY`** *(optional)* — enables token + cost metering.
   When set, Openrind Desktop mints a permanent OpenrindGateway presign on the host at
   sandbox-create time, uploads it to `/sandbox/openrind-shell-input/presign.json`,
   **and writes the proxy base URL straight into the agent's launch
   environment** — `ANTHROPIC_BASE_URL` is appended to `/sandbox/.bashrc`
   (the shell OpenShell starts the agent from) and, for Claude Code, merged
   into `~/.claude/settings.json`. The agent's `/v1/messages` calls are then
   routed through OpenrindGateway. Leave unset to talk to Anthropic directly.
   Applies to both agents.

   > Why not rely on `setup.sh`? The published sandbox image's entrypoint is
   > `/bin/bash`, and OpenShell's supervisor launches the agent as
   > `bash -i` → `claude`. That sources `/sandbox/.bashrc` but never runs the
   > image's `/opt/openrind-shell/setup.sh`, so the uploaded presign is not consumed
   > on its own. The base URL we strip for the agent must NOT include the
   > trailing `/v1/messages` the minted presign URL carries — the agent
   > re-appends it, and a doubled `/v1/messages/v1/messages` is rejected by the
   > proxy with "Path not authorized".

Open **Settings → Sandbox**:

- Pick **OpenShell** as the sandbox backend
- In the **Openrind Shell configuration** panel, click **Configure** on each
  credential row, paste the value, click **Save**. Values are encrypted at
  rest via the OS keyring (Keychain / DPAPI / libsecret) and never leave the
  main process after they're saved
- Click **Test** next to `DATABASE_URL` to verify reachability. A
  transient `postgres:16-alpine` container runs `psql -tAc "select 1"`;
  green if it succeeds

---

## Step 2 — create a sandbox

Openrind Shell terminals are sandboxes, not workspaces. A workspace is always the
regular chat experience — the create-workspace flow deliberately coerces any
Openrind Shell profile back to the Openrind Desktop image, so there is no launch-profile
choice there (and none in Settings either).

Open the **sandbox manager** (**Sandboxes → ⋯ → New sandbox**):

- Choose the agent: **Claude Code** or **OpenClaw**
- Name the sandbox
- Click **Create**

---

## Step 3 — open the sandbox

Click the sandbox in the sidebar's **Sandboxes** section. The session pane
shows an embedded terminal with a three-step bootstrap indicator:

1. **Pulling image + creating sandbox** — `docker pull
   ghcr.io/openrind/openrind-shell/sandbox:just-bash` (lazy, only on first use
   per WSL distro) and `openshell sandbox create --from <image>
   --upload <credentials>:/sandbox/openrind-shell-input --provider claude
   --auto-providers --detach -- openrind-shell`
2. **Mounting terminal** — xterm.js initializes
3. **Opening PTY** — `wsl.exe -d openrind-desktop-openshell -- openshell
   sandbox connect <name>` runs inside a real PTY (node-pty)

When all three steps complete (green dots), Claude Code's welcome
banner appears. Type to interact normally.

---

## Step 4 — verify persistence

The Postgres-backed `/home/agent` is Openrind Shell's headline feature. To
see it work:

```text
You ▸ Create a file called founder-demo.md with the text "hello from openrind-desktop"
Claude ▸ <creates the file>
```

Close the workspace tab. Reopen it — the bootstrap reconnects to the
**existing** sandbox (the toolbar shows "Reconnecting to <name>"). Ask:

```text
You ▸ What's in founder-demo.md?
Claude ▸ hello from openrind-desktop
```

The Postgres `_openrind.workspace_files` table holds the file. Same
workspace ID + same `DATABASE_URL` on a different laptop = same
restored home directory.

---

## Toolbar reference

The thin bar above the terminal shows the sandbox status and three
actions:

- **Pop out** — opens the same sandbox in a separate Windows Terminal
  window. Both connections share the same shell history (Openrind Shell
  `openrind-shell-bash` daemon multiplexes via Unix socket). Useful for
  power users who want Windows Terminal's full features (tabs,
  splits, copy/paste shortcuts).
- **Delete sandbox** — tears the sandbox container down. The
  Postgres-backed `/home/agent` files persist; reopening the workspace
  creates a fresh sandbox that restores them.
- **Reconnect** — appears when the PTY disconnects unexpectedly
  (closed Windows Terminal pop-out, EDR killed the process, etc.).
  Tears down the old PTY and opens a fresh one against the same
  sandbox.


---

## Claude Code vs OpenClaw

| | Claude Code (default) | OpenClaw |
|---|---|---|
| Profile | `openrind-shell-claude` | `openrind-shell-openclaw` |
| Image | `ghcr.io/openrind/openrind-shell/sandbox:just-bash` | `ghcr.io/openrind/openrind-shell/sandbox:just-bash` |
| API key delivery | OpenShell provider system or uploaded file | Uploaded file only (OpenClaw's embedded gateway can't resolve provider placeholders) |
| OpenrindGateway cost tracking | Supported via `OPENRIND_GATEWAY_API_KEY` | Supported via `OPENRIND_GATEWAY_API_KEY` |
| First-run latency | ~30s (image pull + sandbox create) | ~3 min (additional npm-package staging — pre-baked in newer images) |

Pick at workspace-create time. The profile is fixed for the workspace's
lifetime — switch by creating a new workspace.

---

## Troubleshooting

### "DATABASE_URL is not configured"

Open Settings → Sandbox → Openrind Shell configuration. Set DATABASE_URL.

### "ANTHROPIC_API_KEY is required for OpenClaw"

Same — set the second credential. Claude profile doesn't need this.

### "OpenShell is not ready"

The WSL distro, Docker, OpenShell CLI, or gateway is missing or
unhealthy. Settings → Sandbox → Doctor panel surfaces the failing
component.

### "Could not reach PostgreSQL"

Most common causes:

- `host.docker.internal` not reachable from inside the WSL distro on
  certain Windows network configs. Use an external Postgres (Supabase,
  Neon) or the firm-internal one.
- Wrong password or URL shape — verify by running `psql "$DATABASE_URL"
  -c "select 1"` outside Openrind Desktop first
- Firm firewall blocks the Postgres port (5432 / 6543) — escalate to IT

### Pop-out terminal won't open

Openrind Desktop tries Windows Terminal (`wt.exe`) first, falls back to
`cmd.exe`. If both fail, your firm's GPO may block UAC-elevated
processes. Use the embedded terminal — it works without the pop-out.

### Session disconnects mid-task

Click **Reconnect**. The sandbox stays alive across the PTY drop; only
the wsl.exe child died. Common causes:

- EDR (CrowdStrike / SentinelOne) killed wsl.exe — escalate to IT for
  an allowlist entry on `%LOCALAPPDATA%\Openrind Desktop\Openrind Desktop.exe`
- Laptop went to sleep — Windows can reset WSL2's utility VM. Hyper-V
  power settings can mitigate

### Terminal output looks garbled, torn, or misaligned

Don't guess at which layer is broken — capture the bytes and find out.
There is no menu entry for this (it is a debugging tool, not a feature).
Open **View → Toggle DevTools** and run:

```js
const b = window.__OPENRIND_DESKTOP_ELECTRON__;
const [s] = await b.invokeDesktop("openrindPtyList");
await b.invokeDesktop("openrindPtyDumpBuffer", s.id);
```

That writes a byte-exact `.raw` plus a replayable asciinema `.cast` to
`%LOCALAPPDATA%\Openrind Desktop\logs\openrind-shell-dumps\` and reveals the
folder. Replay the artifact with the app out of the picture:

```bash
cat <dump>.raw                  # any known-good terminal
asciinema play <dump>.cast      # with the original timing
```

- **Renders correctly outside the app, wrong inside** — the bug is on our
  side: the renderer, the Unicode/width addons, or the terminal geometry.
  Note whether the pane is on the GPU renderer or fell back to the DOM one
  (a `WebGL context lost` warning in DevTools means it fell back).
- **Wrong in both** — the bytes were already corrupt before xterm.js saw
  them, so the fault is upstream in the byte path (the container-side
  `openrind-pty-bridge.py`, or the agent itself). Nothing in the renderer
  can un-corrupt them.

One known upstream cause: if `OPENRIND_DESKTOP_PTY_CONPTY=1` is set, the PTY
runs through the Windows Pseudoconsole, which re-serializes its own screen
model and mangles full-screen TUIs. That variable is a last-resort escape
hatch only — unset it and reconnect.

### "Files disappear after sandbox delete"

That means DATABASE_URL wasn't actually configured or Postgres
persistence didn't kick in. Check the Postgres `_openrind` schema —
should have a `workspace_files` row for each path. If empty, the
sandbox ran in Openrind Shell's local-only mode (rare; usually a sign that
the credential file didn't get uploaded correctly).

---

## Architecture (for IT)

```
┌─────────────────────────────────────────────────────────────┐
│  Openrind Desktop (Electron desktop app)                            │
│  Renderer: xterm.js full-pane session view                  │
│  Main process: node-pty bridge + Electron IPC               │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ IPC: openrind-shell:pty-data / openrind-shell:pty-exit
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  main.mjs                                                   │
│  - openrindCredentials  (safeStorage-encrypted DATABASE_URL │
│                          / ANTHROPIC_API_KEY)               │
│  - openrind-shell.createOpenrindShellSandbox  (image pull, provider    │
│                                     create, --upload)       │
│  - openrind-shell-pty.openSession  (node-pty.spawn → wsl.exe)     │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ wsl.exe -d openrind-desktop-openshell
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  WSL2 distro: openrind-desktop-openshell                            │
│  - Ubuntu 24.04 + Docker Engine + OpenShell CLI             │
│  - openshell sandbox create --from ghcr.io/sandys/...       │
│                              --upload .../sandbox/openrind-shell-input│
│                              --provider claude --auto-providers │
│                              --detach -- openrind-shell           │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Openrind Shell sandbox container (privileged)                    │
│  - setup.sh reads /sandbox/openrind-shell-input/db-url + key      │
│  - Runs DB migrations against the _openrind schema          │
│  - Restores /home/agent from Postgres                       │
│  - Starts openrind-shell-bash daemon (Unix socket on /tmp/...)    │
│  - exec claude (or openclaw)                                │
└─────────────────────────────────────────────────────────────┘
```

Credentials never reach the renderer once saved. They flow renderer →
IPC → main → `safeStorage.encryptString` → JSON file at
`~/.openrind-desktop/openrind-shell-credentials.json` (mode 0o600). When a sandbox is
created, `openrind-shell.mjs` decrypts the values, writes them to a temp
directory at `os.tmpdir()/openrind-shell-input-<random>/`, passes the
directory via `--upload`, and cleans the temp dir in a `finally` block.

Once inside the sandbox, Openrind Shell's `setup.sh` reads the files from
`/sandbox/openrind-shell-input/` and uses them to bootstrap the agent.

For deeper details on Openrind Shell itself (OpenrindGateway integration, custom
images, the openrind-shell-bash daemon's protocol), see the upstream README
at https://github.com/openrind/openrind-shell.
