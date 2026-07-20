# CLAUDE.md

## Documentation layout

- `README.md` — **end-user** docs. Uses ONLY `openshell sandbox create ...` with the published GHCR image. No `npx`, no `pnpm`, no clone steps. This is the supported path for anyone who wants to run Openrind Shell.
- `BUILD.md` — **contributor / developer** docs. All `npx openrind-shell`, `pnpm`, `docker build`, and test-suite commands live here.
- `CLAUDE.md` (this file) — conventions for modifying the codebase.

When editing user docs, **never add `npx`/`pnpm`/`npm install` commands to `README.md`** — those belong in `BUILD.md`.

## Build & Test

```bash
cd openrind-shell-js
pnpm install && pnpm build
pnpm check                    # typecheck + 29 lints + 108 unit tests

# Integration (requires PostgreSQL)
DATABASE_URL='...' node test-integration.mjs

# Docker image verification (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh

# Setup.sh flow inside container (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh

# Real Claude Code persistence (requires PostgreSQL + ANTHROPIC_API_KEY)
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh
```

## Project Structure

- `openrind-shell-js/` — TypeScript package
  - `src/bin/openrind-shell.ts` — executable wrapper for npm/npx and scripts
  - `src/cli.ts` — CLI parsing and command dispatch
  - `src/sync.ts` — PostgreSQL ↔ real filesystem sync
  - `src/pg-fs/` — PgFs: read-only IFileSystem backed by SQL queries
  - `src/workspace-fs/` — WorkspaceFs: read-write IFileSystem backed by workspace_files
  - `src/db/` — SQL queries, migrations, pool, types
  - `src/safety.ts` — command safety analysis via just-bash parse() AST
  - `src/shell.ts` — createOpenrindShell(), createToolHandler()
  - `src/index.ts` — public API
  - `lint.mjs` — 29 structural lint rules
- `sandboxes/openrind-shell/` — OpenShell sandbox image (stock base, no FUSE)
  - `Dockerfile` — Node.js + openrind-shell-js on stock OpenShell base
  - `openrind-shell-bash.mjs` — daemon/client bridge for custom agents
  - `openrind-pty-bridge.py` — PTY host: runs the agent on a real Linux PTY and
    streams raw bytes to Openrind Desktop (keeps Windows ConPTY out of the byte
    path, which was corrupting the Claude/OpenClaw TUI). Auto-detects framed
    (desktop, via an in-band handshake) vs. raw passthrough (external terminal).
  - `setup.sh` — sandbox entry point (execs the agent through openrind-pty-bridge.py)
  - `policy.yaml` — network policy
- `crates/` — original Rust implementation (reference, not used)

## Conventions

- Persistence is optional — CLI works without DATABASE_URL (local-only mode)
- IFileSystem implementations are path-based (no inodes)
- `parsePath()` returns a `PgNode` discriminated union
- SQL queries use `quoteIdent()` for identifiers, `$N` params for values, `::text` casts
- PgFs throws EROFS on all write methods
- WorkspaceFs receives complete content per writeFile() — no write-back buffering
- Command safety: just-bash parse() AST walk with regex fallback
- `pg` command: SQL with parens or quotes must be double-quoted

## Agent Selection (Claude Code vs OpenClaw)

The sandbox supports two agents controlled by `OPENRIND_SHELL_AGENT`:

- `claude` (default) — Claude Code. Seeds `/.claude` and `/.claude/projects`, writes Openrind Gateway proxy to `~/.claude/settings.json`, execs `claude`.
- `openclaw` — OpenClaw. Seeds `/.config` only (no `/.claude`), reads `ANTHROPIC_API_KEY` from env (loaded from the uploaded `/sandbox/anthropic-api-key` file), execs `openclaw` directly. OpenClaw brings up its own embedded gateway.

`OPENRIND_SHELL_AGENT` is never set directly by users. It is injected into the sandbox by OpenShell's provider framework: the `openclaw` generic provider carries `--credential "OPENRIND_SHELL_AGENT=openclaw"`.

The workspace schema (`_openrind`) is shared — both agents read and write the same `workspace_files` table.

### Openrind Gateway integration

Openrind Gateway is supported for **both agents**. The presign is stored at `~/.openrind-shell/presign.json` with `metadata.labels: ['openrind-shell', '<agent>']` — `claude-code` or `openclaw` — and is created against `OPENRIND_GATEWAY_API_BASE` (defaults to `https://app.openrind.com`; override for local stacks). The proxy URL regex accepts both `https://proxy.openrind.com/...` and self-hosted shapes (`http(s)://<host>/openrind-gateway-proxy/t/...`).

How each agent consumes the proxy URL:

- **Claude Code** — `setup.sh` writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json` and passes it explicitly in the `exec` env.
- **OpenClaw** — `setup.sh` exports `ANTHROPIC_BASE_URL` so the background openclaw gateway inherits it, writes it into `~/.openclaw/openclaw.json`'s `env` block (re-applied after the gateway's own config rewrite), and passes it explicitly in the openclaw `exec` env. The real `ANTHROPIC_API_KEY` is retained in `auth-profiles.json` because `openclaw onboard` requires a key value; Openrind Gateway ignores the inbound `x-api-key` since auth is via the proxy URL token.

Both flows also persist `ANTHROPIC_BASE_URL` to `/home/agent/.openrind-shell/env.sh`, which the sandbox `.bashrc` sources on reconnect.

When adding features that differ by agent, gate on `OPENRIND_SHELL_AGENT` in `setup.sh` (bash) and `process.env.OPENRIND_SHELL_AGENT` in Node.js.

## Build & test for OpenClaw

```bash
# Verify setup.sh handles both agents (no Docker required)
bash -n sandboxes/openrind-shell/setup.sh
grep -q 'OPENRIND_SHELL_AGENT' sandboxes/openrind-shell/setup.sh

# Full OpenClaw setup path (requires Docker + PostgreSQL)
DATABASE_URL='...' OPENRIND_SHELL_AGENT=openclaw bash tests/test_setup_e2e.sh
```

## Hard Rules

- **Never fix forward from the middle.** Stop and restart the flow from scratch.
- **Never delete, move, or overwrite user files without explicit permission.**
- **If a file appears risky, stop and ask first.**
- **Never hardcode credentials, connection strings, or secrets into files.** Always read from environment variables at runtime.

## Commit Style

Descriptive, imperative mood. Look at `git log --oneline` for examples.
