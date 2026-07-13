# BUILD.md — Local development for Openrind Shell

This file is for **contributors and developers** who want to modify Openrind Shell, build the sandbox image locally, or run the test suite. End users should follow [README.md](./README.md) — the published GHCR image is the supported path.

---

## Prerequisites

- Node.js 18 or later
- pnpm (`npm install -g pnpm`)
- Docker (for building the sandbox image and running E2E tests)
- A reachable PostgreSQL instance (for integration tests — Supabase, local postgres container, or any other)

---

## Clone and build

```bash
git clone https://github.com/openrind/openrind-shell.git
cd openrind-shell/openrind-shell-js
pnpm install
pnpm build
```

This compiles TypeScript into `openrind-shell-js/dist/`. The `dist/bin/openrind-shell.js` script is what `npx openrind-shell` resolves to when the package is published, and what the sandbox image runs internally.

---

## Run the CLI without a sandbox

The `openrind-shell-js` package exposes a CLI that launches Claude Code locally, starts the OpenShell gateway, and creates a sandbox — all wrapped into one command. For day-to-day development this is quicker than invoking `openshell` by hand each time.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
npx openrind-shell
```

By default this **pulls the published GHCR image** `ghcr.io/openrind/openrind-shell/sandbox:just-bash`. To use a locally-built image instead, add `--dev`:

```bash
npx openrind-shell --dev        # uses openrind-shell-sandbox:dev (you must build it first)
npx openrind-shell -d           # shorthand
```

**Build the dev image locally:**

```bash
# From the repo root
docker build -f sandboxes/openrind-shell/Dockerfile -t openrind-shell-sandbox:dev .
```

Override the dev image name via env var (if you tagged it differently):

```bash
OPENRIND_SHELL_DEV_IMAGE=my-image:tag npx openrind-shell --dev
```

---

## CLI subcommands (local development)

All subcommands accept `--dev`/`-d` to target the local dev image.

| Command | Description |
|---|---|
| `npx openrind-shell` | Launch Claude Code (published image) |
| `npx openrind-shell --dev` | Launch Claude Code (local dev image) |
| `npx openrind-shell --agent openclaw` | Launch OpenClaw instead of Claude Code |
| `npx openrind-shell presign` | Show the currently stored Openrind Gateway presign |
| `npx openrind-shell presign renew` | Create a new permanent Openrind Gateway presign and store it |
| `npx openrind-shell stats` | API usage statistics (cost, tokens, model distribution, cache hit rate) |
| `npx openrind-shell analyze` | Analyze session history and produce ranked optimization proposals |
| `npx openrind-shell apply` | Auto-apply proposals from `analyze` — patches `CLAUDE.md`, creates `CONTEXT.md`, compacts memory |
| `npx openrind-shell apply --dry-run` | Preview `apply` changes without writing |
| `npx openrind-shell apply --proposal <id>` | Apply a single proposal (`model-routing`, `context-file`, `lazy-reading`, `readme-updates`, `memory-compact`) |
| `npx openrind-shell memory refresh` | Rewrite Claude's native project memory files |
| `npx openrind-shell memory refresh --query "..."` | Focus memory refresh on a specific topic |
| `npx openrind-shell -- <args>` | Pass arguments straight to Claude (e.g. `npx openrind-shell -- -p 'hello'`) |

**Options shared by `stats`, `analyze`, `apply`:**

```
--workspace <id>    Workspace ID (default: hostname)
--days <n>          Days of history to look back (default: 7)
--project-root <p>  Project root for analyze/apply (default: cwd)
--json              Output as JSON (analyze only)
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `OPENRIND_GATEWAY_API_KEY` | (optional) | Openrind Gateway key — enables cost tracking (Claude Code only) |
| `DATABASE_URL` | (optional) | PostgreSQL connection string — enables persistence and `pg` |
| `OPENRIND_SHELL_AGENT` | `claude` | Agent to launch: `claude` or `openclaw`. Injected via the `openclaw` provider; not set directly. |
| `OPENRIND_SHELL_WORKSPACE_ID` | hostname | Workspace identifier |
| `OPENRIND_SHELL_HOME` | `/tmp/openrind-shell-<id>` | Local workspace directory |
| `OPENRIND_SHELL_SANDBOX_IMAGE` | `ghcr.io/openrind/openrind-shell/sandbox:just-bash` | Override the production sandbox image |
| `OPENRIND_SHELL_DEV_IMAGE` | `openrind-shell-sandbox:dev` | Override the dev sandbox image (used with `--dev`/`-d`) |

---

## Test suite

```bash
cd openrind-shell-js
pnpm check                    # typecheck + lints + unit tests
```

### Integration tests (require PostgreSQL)

```bash
export DATABASE_URL='postgresql://...'
node test-integration.mjs
node test-memory-refresh.mjs
```

### Docker image verification (requires Docker + PostgreSQL)

```bash
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh
```

Builds the image, runs checks inside it as the sandbox user: permissions, migrations, daemon, dist/ artifacts, user .npmrc preservation.

### Setup.sh flow inside container (requires Docker + PostgreSQL)

```bash
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh
```

Exercises the actual `setup.sh` code path end-to-end inside the container.

### Real Claude Code persistence (requires PostgreSQL + ANTHROPIC_API_KEY)

```bash
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh
```

Launches Claude Code through the built binary, has it write a file, deletes the home directory, relaunches, and verifies the file is restored from PostgreSQL.

### OpenClaw code path (requires Docker + PostgreSQL)

```bash
# Exercise setup.sh with OPENRIND_SHELL_AGENT=openclaw
DATABASE_URL='...' OPENRIND_SHELL_AGENT=openclaw bash ../tests/test_setup_e2e.sh
```

Verifies that setup.sh correctly seeds `/.config` (not `/.claude`), skips Openrind Gateway, and detects the openclaw binary when `OPENRIND_SHELL_AGENT=openclaw` is set.

---

## Custom agents (library usage)

For agents with a single bash tool (not the Claude Code CLI), you can use the just-bash virtual filesystem directly:

```typescript
import { createOpenrindShell, createToolHandler } from 'openrind-shell-js'

const shell = await createOpenrindShell({
  connectionString: process.env.DATABASE_URL,
  workspaceId: 'my-session',
})

const handleBash = createToolHandler(shell)
await shell.exec('cat /db/public/users/.info/count')
await shell.exec('echo hello > /home/agent/notes.txt')
```

This path uses [just-bash](https://github.com/vercel-labs/just-bash) with PostgreSQL-backed virtual mounts at `/db` (read-only) and `/home/agent` (read-write).

---

## Project structure

```
openrind-shell-js/                  # TypeScript package
  src/bin/openrind-shell.ts         # executable wrapper for npm/npx
  src/cli.ts                  # CLI parsing and command dispatch
  src/sync.ts                 # PostgreSQL ↔ filesystem sync
  src/shell.ts                # createOpenrindShell() for custom agents
  src/pg-fs/                  # Read-only /db filesystem
  src/workspace-fs/           # Read-write /home/agent filesystem
  src/memory/                 # Claude project-memory refresh
  src/optimize/               # analyze / apply / stats subcommands
  src/db/                     # SQL queries, migrations
  src/safety.ts               # Command safety analysis
  lint.mjs                    # structural lint rules

sandboxes/openrind-shell/           # OpenShell sandbox image
  Dockerfile                  # Stock base + Node.js + openrind-shell-js
  setup.sh                    # Sandbox entry point
  policy.yaml                 # Network policy

tests/                        # End-to-end test scripts
  test_sandbox_e2e.sh         # Docker image verification
  test_setup_e2e.sh           # setup.sh flow inside container
  test_claude_e2e.sh          # Real Claude Code persistence
```

---

## Publishing a new image

Images are built and pushed by GitHub Actions on push to the `just-bash` branch (see `.github/workflows/publish-images.yml`). The tag `ghcr.io/openrind/openrind-shell/sandbox:just-bash` always tracks the latest successful build on that branch.

To test before pushing:

```bash
docker build -f sandboxes/openrind-shell/Dockerfile -t openrind-shell-sandbox:dev .
bash tests/test_sandbox_e2e.sh
bash tests/test_setup_e2e.sh
ANTHROPIC_API_KEY='...' DATABASE_URL='...' bash tests/test_claude_e2e.sh
```

---

## Architecture

```
  ┌─────────────────────── Sandbox ─────────────────────────┐
  │  $HOME = isolated workspace                                │
  │  Claude Code (Read, Write, Edit, Bash, Glob, Grep)         │
  │                      │                                     │
  │                 file watcher                               │
  │                      │                                     │
  │  openrind-shell-js sync ───▼──────────────────────────────────┐  │
  │  pg.Pool wrapped in a CONNECT-tunneled Duplex           │  │
  │  (DATABASE_URL → Supabase / Neon / external Postgres)   │  │
  │  ───────────────────────────────────────────────────────┘  │
  └────────────────────────┬───────────────────────────────────┘
                           │  (all egress via OpenShell HTTP CONNECT proxy)
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   api.anthropic.com   Openrind Gateway      Supabase pg wire protocol
   (x-api-key          (cost tracking  (CONNECT tunnel; pg negotiates
    placeholder         proxy)          its own TLS end-to-end)
    resolved at proxy)
```

Every outbound connection from the sandbox goes through OpenShell's HTTP CONNECT proxy at `10.200.0.1:3128` — kernel-level iptables reject any other TCP.

### How pg reaches Supabase

pg doesn't speak HTTP CONNECT. `openrind-shell-js/src/db/http-connect-socket.ts` wraps a raw `net.Socket` in a `Duplex`: when pg calls `.connect(port, host)`, the Duplex dials the proxy, writes `CONNECT host:port HTTP/1.1`, waits for `200 Connection Established`, and only then emits `'connect'` upward. pg's own TLS handshake runs end-to-end inside the tunnel, so Supabase credentials never reach the proxy.

### Why credentials come through `--upload`, not `--provider`

OpenShell's `SecretResolver` unconditionally wraps every provider credential as an `openshell:resolve:env:*` placeholder that is only rewritten when the HTTP proxy terminates TLS and inspects request headers. pg uses raw TCP, so it can't resolve placeholders — it would try to literally connect to a host named `openshell:resolve:env:DATABASE_URL`.

`openshell sandbox create --upload <file>` is the one channel that delivers bytes verbatim. `setup.sh` reads `/sandbox/db-url` at startup, exports `DATABASE_URL`, and everything downstream sees the real URL.

### Custom PostgreSQL hosts

The shipped `policy.yaml` allowlists common Supabase pooler regions under the `postgres` network policy. To add a host (different region, Neon, RDS, self-hosted), append its `host:port` entry and rebuild:

```yaml
# sandboxes/openrind-shell/policy.yaml
network_policies:
  postgres:
    endpoints:
      - { host: your-host.example.com, port: 5432, tls: skip }
      - { host: your-host.example.com, port: 6543, tls: skip }
    binaries:
      - { path: /usr/bin/node }
```

Then rebuild and push the image (or use `--dev` with a locally-tagged image).

### `_openrind` schema on Supabase

Migration V6 grants `USAGE` on the schema to `service_role, dashboard_user, authenticated, anon` and `SELECT` on all tables to `service_role, dashboard_user`. Without these, the Supabase Table Editor shows the schema but none of its rows — the tables are owned by `postgres` and only readable there. The V6 grants wrap each role in a try/catch on `42704` (undefined role) so the migration still succeeds on non-Supabase databases where those roles don't exist.
