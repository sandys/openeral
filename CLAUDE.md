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
  - `openclaw-launch.sh` — owns the whole OpenClaw lifecycle: config seeding,
    gateway start, readiness + authenticated-client verification, device-pairing
    approval, TUI handover, and the `openclaw tui --local` fallback. Re-runnable
    by hand as `openclaw-launch` (`/usr/local/bin` shim from the Dockerfile).
  - `openclaw-config.mjs` — deterministic, idempotent seeder for
    `~/.openclaw/openclaw.json`. Deep-merges an overlay over the existing file in
    three tiers (`full` / `core` / `minimal`) so an OpenClaw build that rejects a
    hardening key degrades instead of failing to boot.
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

### Migrations must stay cheap and lock-free on an already-migrated database

`runMigrations()` runs on EVERY sandbox boot, and several sandboxes routinely share one workspace, so the already-migrated case is the hot path. Three invariants, each pinned by a lint rule:

- **Gate on `_openrind.schema_version`.** The table existed from V1 but was never read or written, so ~22 DDL statements re-ran on every boot — about 4s of pure round-trip latency to a remote database, all of it holding the migration advisory lock, so N concurrent boots serialised into N x 4s.
- **Never issue `CREATE INDEX IF NOT EXISTS` unguarded.** It is not free when the index exists: it takes a ShareLock on the table *before* checking, and ShareLock conflicts with the RowExclusiveLock every INSERT holds. A boot landing on another sandbox's flush (~17s for 775 entries) blocked until `statement_timeout` and died with `57014 canceling statement due to statement timeout` — fatal, sandbox exits 1, which is what "OpenClaw won't start" looked like. Worse, the waiting DDL also queues ahead of every later writer. Guard with `to_regclass` (a catalog lookup, no table lock) via `ensureIndex()`. Verified against the live database: the blocked `CREATE INDEX` timed out while `CREATE TABLE IF NOT EXISTS` (263ms) and `GRANT` (188ms) never blocked — only the index needs the guard.
- **Poll `pg_try_advisory_lock`; never call the blocking `pg_advisory_lock`.** A blocked one is cancelled by `statement_timeout` and *throws*, turning "another sandbox is migrating" into a fatal boot failure. Bound the wait in JS, and on losing the race re-check the version rather than failing. Any DDL that does run gets a short `lock_timeout` so it fails fast instead of stalling concurrent writers.

Measured on the same remote database, before -> after: repeat boot 4250ms -> 350ms; boot during a concurrent flush `57014` at 32.6s -> ok at 1.1s; eight concurrent boots 30.2s -> 1.2s.

## Agent Selection (Claude Code vs OpenClaw)

The sandbox supports two agents controlled by `OPENRIND_SHELL_AGENT`:

- `claude` (default) — Claude Code. Seeds `/.claude` and `/.claude/projects`, writes Openrind Gateway proxy to `~/.claude/settings.json`, execs `claude`.
- `openclaw` — OpenClaw. Seeds `/.config` and `/.openclaw` (no `/.claude`), then execs `openclaw-launch.sh`. `setup.sh` only *prepares* the sandbox (workspace restore, git-over-https rewrites, presign resolution); it never onboards, never starts the gateway, and never execs `openclaw` itself.

`OPENRIND_SHELL_AGENT` is never set directly by users. It is injected into the sandbox by OpenShell's provider framework: the `openclaw` generic provider carries `--credential "OPENRIND_SHELL_AGENT=openclaw"`.

The workspace schema (`_openrind`) is shared — both agents read and write the same `workspace_files` table.

### OpenClaw launch flow

There is no onboarding step. `openclaw-launch.sh`:

1. Seeds `~/.openclaw/openclaw.json` via `openclaw-config.mjs` (tier `full`, stepping down to `core` / `minimal` if `openclaw config validate` rejects a key; if none validate, the file is moved to `.rejected.<ts>` and rewritten from scratch).
2. Starts `openclaw gateway run --port 18789` under `setsid`, with `OPENCLAW_PLUGIN_STAGE_DIR` in the **gateway process only**.
3. Polls `/readyz` for up to 180s (`OPENCLAW_GATEWAY_READY_TIMEOUT`), aborting early if no `openclaw gateway` process is alive. One `doctor --fix` + one retry, never a loop, and the retry only gets the *remaining* budget.
4. Gates on `openclaw health --json` — the authenticated `connect.challenge` → `connect` → `hello-ok` round trip the TUI performs. `/readyz` is only a fast path; if it stays silent while the process lives, the real gate is still tried.
5. Auto-approves pending device-pairing requests, then `exec openclaw tui` with a bounded 120s background pairing watchdog (the TUI mints its own request when it connects).
6. If the gateway never becomes usable, execs `openclaw tui --local` (embedded runtime, no gateway/WebSocket/pairing) after printing why. The only hard failure is an invalid config (exit 78) — local mode does not bypass the invalid-config guard either.

`setup.sh` scrubs `OPENRIND_GATEWAY_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `OPENCLAW_PLUGIN_STAGE_DIR` from the launcher's env. `ANTHROPIC_API_KEY` stays on purpose — it is OpenClaw's provider-auth source.

`OPENRIND_SHELL_SETUP_ONLY` (the desktop loading-screen prewarm) also runs the launcher, so the gateway reaches `/readyz` while the loading screen is up and the user's terminal attaches to an already-ready gateway.

### Provisioning cost — the bootstrap runs once per container

`setup.sh` runs **twice** per OpenClaw session: once as the desktop's loading-screen prewarm (`OPENRIND_SHELL_SETUP_ONLY=1`, which brings the gateway up) and again when the terminal connects and `.bashrc` runs `exec openrind-shell`. The second run used to repeat the entire database bootstrap — migrations, workspace seed, restore, flush — which measured **28s of a ~75s provisioning** against a remote (ap-southeast-2) PostgreSQL with ~770 workspace entries, for no benefit: the first run already materialised `/home/agent` in that container and nothing had touched it in the seconds since.

`BOOTSTRAP_MARKER` (`/tmp/openrind-shell-bootstrap-done`) now records `WORKSPACE_ID:<PID 1 starttime>`. Both halves are load-bearing:

- **WORKSPACE_ID** — sandboxes share a workspace (a brand-new sandbox restores the same ~770 entries), so one workspace must never reuse another's bootstrap.
- **The container run** — `/tmp` *survives* `docker restart` (verified: only `/dev/shm` is recreated). Keying on the file alone skipped the restore after a restart, and another sandbox on the same workspace may have changed PostgreSQL meanwhile. PID 1's starttime changes on every restart, making "same container run" exact.

The marker is written only **after** the flush, so a bootstrap that dies midway is retried in full.

**The sync daemon must start on EVERY run, including the skipped one.** It flushes `/home/agent` to PostgreSQL from its `SIGTERM` handler, and `setup.sh`'s EXIT trap is what sends that SIGTERM — that shutdown flush is the only thing that persists whatever `openclaw-launch.sh` wrote during the prewarm (seeded config, memory sqlite), because the connect run now skips its own flush. Skipping the daemon start to save three seconds would silently lose agent state. A lint rule pins this.

Measured after the change, fresh OpenClaw sandbox: create 1s · Ready ~1s · prewarm 38s (migrations 5, seed 2, restore 8, flush 17, daemon 3, launcher 9) · connect **7s** (was 34s). The remaining flush dominates the prewarm; it is deliberately NOT skipped on the first run, since that is what persists files the image ships but the workspace has not seen.

### Loading-screen prewarm contract — do not break these

The prewarm is driven by `prewarmAgentRuntime()` in `openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs`, which streams this script's output into the overlay. A loading screen that sits on one unchanging line is indistinguishable from a hang, so:

- **The prewarm script must be POSIX `sh`.** `sandboxRunScriptCmd()` pipes it into `sh`, which is dash here. `${PIPESTATUS[0]}` printed `Bad substitution` and exited 2, so *every* healthy OpenClaw prewarm reported failure and the overlay accused a working `DATABASE_URL` of being unreachable. The exit code now travels through a file. `buildPrewarmScript()` is exported via `__testing` and a test rejects bash-only syntax.
- **Announce a slow step BEFORE doing it, never after.** `verify_client()` used to `progress` only on success, leaving the ~27s `devices list` + `health` round trip — the longest silent stretch of a healthy launch — with nothing moving on screen.
- **Every user-visible line needs a rule in `SETUP_PROGRESS_LABELS`,** and `tests/openshell/openrind-shell-progress.test.mjs` pins the wording verbatim: rewording an `echo` here silently drops its step from the overlay. Unmatched lines now fall back to the sandbox's own text via `rawSetupLine()`, so a missing rule degrades instead of freezing.
- **The prewarm gets tighter budgets than the terminal.** It exports `OPENCLAW_GATEWAY_READY_TIMEOUT=120` and `OPENCLAW_LAUNCH_BUDGET=240` (vs 180/420) so the launcher's own degraded path fires *inside* the overlay's 300s ceiling and reports why, instead of being cut off mid-step. Keep inner budget < outer timeout.
- **The outer timeout must settle the promise itself.** Killing `wsl.exe` does not reliably reap the Linux-side process, so a timeout that only called `child.kill()` could leave the overlay waiting past the very deadline it enforced.
- **An image without `openclaw-launch.sh` is preflighted in ~0s.** The published `ghcr.io/openrind/openrind-shell/sandbox:just-bash` predates OpenClaw support (2026.4.29, no launcher, no PTY bridge, 2.5 GB acpx plugin cache); running the OpenClaw path against it is what "stuck on the loading screen for eight minutes" looks like. Point the app at a locally built image with `OPENRIND_DESKTOP_SANDBOX_IMAGE` + `OPENRIND_DESKTOP_SANDBOX_SKIP_PULL=1`.

Measured on the pinned image: setup.sh reaches the launcher in ~24s (remote PostgreSQL, ~750 workspace entries), and the launcher's own prewarm path is ~37s (gateway `/readyz` in 6s, client verification ~27s).

The launcher writes `/home/agent/.openrind-shell/openclaw-env.sh` (single source of truth for the runtime env; `setup.sh`'s reconnect `.bashrc` patch just sources it) and regenerates `/home/agent/.openrind-shell/diagnose-openclaw.sh` on every launch.

Above all the per-step budgets sits `OPENCLAW_LAUNCH_BUDGET` (default 420s), which drops the launch to local mode once it runs out. Treat it as a **soft** budget, not a hard ceiling: it is checked *between* steps, never *inside* a blocking one, so the actual handover can land past it. The ways it overruns, all real:

- `config_valid()` is `timeout 90`, and the tier stepdown can call it for each of `full`/`core`/`minimal` — 270s of validation alone, none of it capped to `budget_left`.
- `openclaw doctor --fix` is `timeout 120` and appears on two separate repair paths, each followed by another full `seed_config`.
- The single gateway retry takes `budget_left` but with a 30s floor (`[ "$remaining" -gt 30 ] || remaining=30`), so it can deliberately overrun by up to 30s rather than retry with a uselessly short window.

The guarantee that *does* hold is that every wait is individually bounded and every step has a degraded path, so the launcher always terminates — not that it terminates by a specific wall-clock deadline. Making the budget hard would mean capping each of the above to `budget_left`; that changes real launch timing and has not been done. Meanwhile the desktop's own 300s prewarm timeout is the actual outer bound for the loading screen, which is why the prewarm passes tighter inner budgets (see the prewarm contract above).

Escape hatches: `OPENRIND_SHELL_OPENCLAW_PORT`, `OPENRIND_SHELL_OPENCLAW_MODEL` (default `anthropic/claude-sonnet-4-6`), `OPENRIND_SHELL_OPENCLAW_WORKSPACE`, `OPENRIND_SHELL_OPENCLAW_DENY_PLUGINS` (comma-separated; `""` disables the denies), `OPENRIND_SHELL_OPENCLAW_MODE` (`gateway` default, `local` for the embedded runtime), `OPENRIND_SHELL_OPENCLAW_HIDE_BANNER`, `OPENCLAW_GATEWAY_READY_TIMEOUT`, `OPENCLAW_LAUNCH_BUDGET`.

`OPENRIND_SHELL_OPENCLAW_PORT` is clamped to an integer 1-65535 in **`openclaw-launch.sh`**, which then re-exports the clamped value — so the seeder never sees the raw one and `gateway.port` can never disagree with `openclaw gateway run --port`. (A disagreement presents as a TUI stuck on "connecting" against a perfectly healthy gateway.) `openclaw-config.mjs` keeps an equivalent check because it is also run standalone. The runtime-install fallback for an image that somehow ships without OpenClaw installs the **same pin as the Dockerfile**, never `@latest`.

The pre-TUI OpenClaw splash (lobster + version + commit + coloured tagline) is shown on purpose — the version string is the fastest way to confirm which OpenClaw a sandbox is running. It was previously suppressed with `OPENCLAW_HIDE_BANNER=1` because the Windows ConPTY re-render smeared it into a gibberish bar; that no longer applies now that the agent runs on a real Linux PTY behind `openrind-pty-bridge.py`. Set `OPENRIND_SHELL_OPENCLAW_HIDE_BANNER=1` to suppress it again if that regresses.

### Why the banner needs two separate fixes to be visible

OpenClaw prints the banner correctly — `["tui"]` carries no `hideBanner` in its command-path policy, so `emitCliBanner()` runs. It was invisible for two unrelated reasons, and both fixes have to stay:

1. **The glyph was stripped.** `supportsDecorativeEmoji()` (OpenClaw's `packages/terminal-core`) drops every decorative emoji — from the banner title *and* from taglines — unless `TERM_PROGRAM` matches its known-good list (`iterm`/`apple_terminal`/`ghostty`/`wezterm`/`vscode`), `WT_SESSION` is set, or the platform is `darwin`. A Linux container with `TERM=xterm-256color` and no `TERM_PROGRAM` matches nothing. `openclaw-launch.sh` therefore exports `TERM_PROGRAM=vscode` when it is unset: Openrind Desktop renders the agent in xterm.js, the same emulator VS Code's integrated terminal uses, and `vscode` is the only entry on that list that does not *also* switch something else on (`ghostty`/`wezterm` additionally enable OSC 9;4 progress; every other `TERM_PROGRAM` consumer in OpenClaw is win32- or darwin-only). Never override a value the user's own terminal already declared. `TERM=dumb` also short-circuits that check, so the launcher forces `xterm-256color` when `TERM` is empty or `dumb`.
2. **The banner was erased seconds later.** `openclaw tui` prints it, then the session display initialises: `clearDisplayedSession()` → `tui.requestRender(true)`, and pi-tui's forced full redraw starts with `ESC[2J ESC[H ESC[3J` — erase display, home, *erase scrollback*. That burst takes the banner and the entire launch progress log off the screen **and out of the scrollback**, so there is nothing left to scroll back to. It is unconditional: pi-tui deliberately sets `previousWidth`/`previousHeight` to `-1` to force the clearing variant, and no flag, config key or env var disables it. Confirmed with `PI_DEBUG_REDRAW=1` on 2026.7.1-2 (`fullRender: terminal width changed (-1 -> 120)`) and by byte capture — exactly one `ESC[2J` in the stream, ~5.3 KB after the banner, immediately before `session agent:main:main`.

The second one is fixed in `openrind-pty-bridge.py`'s `ScrollbackKeeper`, which rewrites `ESC[2J ESC[H` into "park on the last row, linefeed the drawn rows, erase the rest" and drops `ESC[3J`. See the invariants below.

The banner therefore lives in the **scrollback**, ~13 lines above the viewport — not pinned on screen. It cannot be pinned: pi-tui homes to row 0 and paints its own content there, so anything left on the top row is overwritten. Patching pi-tui to skip the forced clear was tried and rejected: `clearDisplayedSession()` also runs on a mid-session session switch, where a non-clearing full render appends the new view below the old one instead of replacing it.

On the pinned 2026.7.x nothing stages bundled deps, so the image cache is empty and the launcher seed is a no-op. It is kept because an older pin DOES stage (via an npm install the network policy restricts). Historically the launcher seeded the ~2.5 GB `/opt/openclaw-plugin-cache` tree into `/tmp` on every launch even though the TUI no longer walks it. Do not optimise that copy away: `acpx` is not the only plugin with bundled deps, and without the seed OpenClaw stages ~558 MB itself at gateway startup (plugin init 48.2s vs 7.4s) via an npm install that the sandbox network policy restricts — trading a local copy for a possible hang.

### OpenClaw conventions — do not break these

- `gateway.bind` MUST stay `loopback`. OpenClaw defaults it to `auto` (0.0.0.0) inside a detected container, and only real 127.0.0.1 connections get the loopback trust that auto-approves pairing. Anything else = TUI stuck on "connecting" forever.
- `gateway.auth.mode` is `none` (loopback-only), and `gateway.remote`, `gateway.tls`, `gateway.tailscale`, `gateway.auth.token`, `gateway.auth.password`, `plugins.allow` are removed in **every** tier. Each one has its own hang.
- Never pass `OPENCLAW_PLUGIN_STAGE_DIR` to a client process (`tui`, `health`, `devices`, …) — only to the gateway. A client runs its own staging pass and saturates the event loop.
- **OpenClaw is pinned to `2026.7.1-2` and must not be moved back below 2026.7.x.** On 2026.4.29 the `acpx` plugin bundled 35 runtime deps that installed to ~2.5 GB / 95,467 files, and the plugin loader walked that tree on every TUI startup — ~4 minutes at 100% CPU during which the event loop never serviced the already-open WebSocket, so the TUI sat on "connecting" with the model shown as "unknown" even though the gateway was healthy and the socket ESTABLISHED. 2026.7.x removes acpx entirely and stages no bundled deps. Same container, same config, only the version differing: TUI CPU over 15s→60s went `12s→45s (climbing)` → `4s→4s (flat)`, RSS `750–920 MB` → `248 MB`, gateway plugin init `7.3s` → `0.7s`. A Dockerfile gate fails the build if the pin ever resolves to a build that still ships `acpx`.
- `plugins.deny` still lists `acpx` for safety on an older pin, but the seeder filters the list to plugins the installed build actually ships — otherwise `openclaw config validate` warns `plugin not found: acpx (stale config entry ignored)` on every launch. `browser`/`talk-voice`/`phone-control`/`bonjour` are denied because they are unused in a coding sandbox. Do NOT deny `device-pair`, `memory-core`, or `file-transfer` — pairing, agent memory and attachments are load-bearing.
- `plugins.deny` is UNIONED with the restored config, never replaced — replacing it silently re-enables every plugin the user had disabled. Opting out via `OPENRIND_SHELL_OPENCLAW_DENY_PLUGINS=""` must leave the existing list untouched, not write `[]`.
- **Prune the UNIONED deny list against the installed extensions, not just our own additions.** The filter existed but only ran over `DEFAULT_DENY_PLUGINS`, while the restored list came in untouched. A workspace carrying an older, fuller OpenClaw's deny list (2026.7.x ships 69 extensions; earlier builds shipped far more) therefore kept ~40 dead ids alive forever, and OpenClaw printed `plugins.deny: plugin not found: <id> (stale config entry ignored; remove it from plugins config)` for every one of them on every launch. That wall of warnings is what pushed the version banner off the top of the screen — the banner was rendering correctly the whole time. Pruning is safe against the union invariant: an id the build does not ship cannot load, so dropping it re-enables nothing, and it is literally what OpenClaw's warning asks for. Verified: a restored list of 10 ids (6 stale) prunes to `bonjour,browser,phone-control,talk-voice` and `openclaw config validate` returns `warnings: []`.
- Deny plugins via config; never delete a `dist/extensions/<name>` directory the bundled manifest still declares — OpenClaw then aborts with `plugins.deny: plugin not found`.
- **Conversation transcripts live at `~/.openclaw/agents/<agent>/sessions/`, not `~/.openclaw/sessions`.** The latter never exists, so the home-sync exclusion list's literal `/.openclaw/sessions` entry matched nothing and every transcript (`<id>.jsonl`, `<id>.trajectory.jsonl`, `<id>.jsonl.reset.<ts>`) was persisted to PostgreSQL — and restored into the next sandbox, where OpenClaw resumed it. Symptom: a brand-new sandbox opens showing a question the user asked days earlier. `HOME_SYNC_EXCLUDE_PATH_PREFIXES` now uses `/.openclaw/agents/*/sessions`, where `*` matches exactly one path segment (see `prefixMatches()`). `/.openclaw/memory` stays on the sync path on purpose — the goal is to stop verbatim replay, not to make the agent amnesiac. Old rows self-clean: excluded paths never enter `seenPaths`, and the sync daemon flushes with `prune: true`. Assert exclusions with `isExcludedFromSync()` against paths OpenClaw really writes; nothing tested that before, which is how a dead rule survived.
- Never write `ANTHROPIC_API_KEY` into `openclaw.json`. Auth order is auth-profiles/sqlite → env → `models.providers.*.apiKey`, so the exported env var suffices, and `/home/agent` syncs to PostgreSQL.
- Route the proxy through a **dedicated** provider (`models.providers.openrind-gateway`) with `api: "anthropic-messages"`, never `ANTHROPIC_BASE_URL` — the baseUrl is also OpenClaw's guarded-fetch origin-trust decision. It must omit `/v1` (the Anthropic client appends it). Do not override the canonical `anthropic` provider: OpenClaw's schema requires a `models` array on any declared provider, so overriding it means partially redefining the built-in catalog.
- Every declared provider MUST carry a `models: [...]` array. Omitting it fails `openclaw config validate` with `models.providers.<id>.models: expected array, received undefined`, and the gateway then refuses to start (exit 78). First hit on 2026.4.29; still true on 2026.7.1-2.
- Never add an unbounded wait, and never loop a repair step. Every wait gets a budget and a degraded path.
- Always keep the `openclaw tui --local` fallback reachable. A working local agent beats a spinner.
- Do not use `set -e` in `openclaw-launch.sh` — every step has an explicit degraded path; aborting mid-flight is what leaves a blank terminal.

### PTY bridge conventions — do not break these

- The `ScrollbackKeeper` rewrite matches **only** the exact `ESC[2J ESC[H` pair. A bare `ESC[2J` must pass through: ED does not move the cursor, and rewriting it would. (This is also why `clear_screen()` in `openclaw-launch.sh` emits `ESC[3J ESC[2J ESC[H` rather than the more usual `ESC[3J ESC[H ESC[2J` — same end state, but only the first ordering is the pair the bridge recognises, so the launch log is scrolled away instead of erased.)
- **Never call `clear_screen()` immediately before exec'ing the TUI.** Each rewrite scrolls *exactly one screenful*, so a clear right before handover costs a second scroll that the agent does not need — pi-tui's first render issues its own unconditional full clear a few KB later regardless. The banner then lands stranded between the two scrolls: a screenful of blank rows below the launch log and another screenful above the agent UI, which reads as "the banner never rendered". The tell is two `rewrote agent full-screen clear (rows=N)` lines per launch in `/tmp/openrind-pty-bridge.log`; a healthy launch logs exactly one. `clear_screen()` is still correct before the local-mode degraded message, which the user is meant to read on a clean screen before the 5s handover.
- The scroll MUST be one linefeed per row. A linefeed on the bottom row is the only sequence every emulator (xterm, xterm.js, VTE) turns into a scrollback push — `CSI S` is implemented in xterm.js as a line *delete*, so using it would destroy the very content the rewrite exists to save.
- **Push only the rows the agent DREW, then `ESC[2J` the rest.** Scrolling a full screen also pushes the blank tail, which put the banner 29 lines above the viewport instead of 13 — far enough to read as "the banner never rendered". `_used_rows` counts linefeeds and absolute `CUP` rows since the last clear; the trailing erase is what makes a wrong estimate safe (too short and the erase cleans up, too long and a couple of blank lines get pushed). Either way the agent still gets the blank screen it asked for.
- **The rewrite is budgeted (`MAX_SCROLL_REWRITES`, default 4); later clears pass through verbatim.** Preserving *every* clear is self-defeating. Only the first few have anything above them worth saving — banner, launch log, a degraded-mode explanation; every later full redraw repaints the *same* UI, so pushing it into the scrollback evicts the very content the first rewrite saved. The realistic trigger is a **window drag**, not token streaming: pi-tui takes the clearing variant of its full redraw on every dimension change, so a few seconds of resizing would otherwise push hundreds of duplicate frames and shove the banner off the end of xterm.js's 5000-line scrollback. Past the budget the pair is forwarded untouched — exactly what an unbridged terminal does, an in-place erase — so the screen state the agent asked for is identical either way. 4 covers every legitimate case with headroom (healthy launch uses 1; the local-mode fallback uses 2, the launcher's own `clear_screen()` plus pi-tui's first render). Do NOT swallow the clear past the budget: the agent would then paint over a stale frame.
- The rewrite is framed-mode only. Raw passthrough (`pop out to an OS terminal`) must stay byte-transparent.
- `ESC[3J` from the agent is always dropped — **independently of the rewrite budget**. Erasing the user's scrollback is never needed for the agent's own rendering to be correct.
- The filter buffers partial sequences at read boundaries, so every exit path must release them — `expired()` on idle, `flush()` on teardown — or the agent's last bytes can be swallowed. `tests/test_pty_bridge_scrollback.py` pins this, including a split at every byte offset.
- `TERMINAL_RESET` is written straight to fd 1, deliberately bypassing the keeper: at session start there is nothing of the agent's to preserve and a pristine screen is the point.
- Known, deliberately unfixed: a PTY read that splits *inside* an absolute `CUP` (`ESC[<row>;<col>H`) loses that row from the `_used_rows` estimate, since only the two rewrite patterns are held back across the boundary. Harmless in practice — `_used_rows` is a `max()` over many CUPs plus linefeed counts, the pre-TUI content the estimate actually protects is plain linefed lines rather than CUP-addressed, and the trailing `ESC[2J` bounds the damage. Holding back arbitrary variable-length CSI would delay real bytes for no measurable gain.
- Kill switches: `OPENRIND_SHELL_PTY_KEEP_SCROLLBACK=0` streams the agent's bytes through verbatim; `OPENRIND_SHELL_PTY_MAX_SCROLL_REWRITES=<n>` retunes the budget (`0` disables the rewrite but still drops `ESC[3J`).

### Openrind Gateway integration

Openrind Gateway is supported for **both agents**. The presign is stored at `~/.openrind-shell/presign.json` with `metadata.labels: ['openrind-shell', '<agent>']` — `claude-code` or `openclaw` — and is created against `OPENRIND_GATEWAY_API_BASE` (defaults to `https://app.openrind.com`; override for local stacks). The proxy URL regex accepts both `https://proxy.openrind.com/...` and self-hosted shapes (`http(s)://<host>/openrind-gateway-proxy/t/...`).

How each agent consumes the proxy URL:

- **Claude Code** — `setup.sh` writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json` and passes it explicitly in the `exec` env.
- **OpenClaw** — `ANTHROPIC_BASE_URL` is NOT used; it is not part of OpenClaw's supported environment contract. `openclaw-config.mjs` declares a dedicated provider `models.providers.openrind-gateway` carrying the normalized proxy URL as `baseUrl`, `api: "anthropic-messages"`, and a `models: [...]` array, then points `agents.defaults.model.primary` at `openrind-gateway/<model>`. That baseUrl is also what allowlists the exact `scheme://host:port` through OpenClaw's guarded fetch path. The URL must omit `/v1`. The stock `anthropic` provider is left untouched, so a no-proxy sandbox uses `anthropic/<model>` and keeps its normal beta headers and service tier. The API key is never written to the config — Openrind Gateway authenticates via the presign token in the URL and ignores the inbound `x-api-key`.

Claude Code's flow also persists `ANTHROPIC_BASE_URL` to `/home/agent/.openrind-shell/env.sh`, which the sandbox `.bashrc` sources on reconnect. OpenClaw's runtime env lives in `/home/agent/.openrind-shell/openclaw-env.sh`, written by `openclaw-launch.sh` and sourced by the same `.bashrc` patch.

When adding features that differ by agent, gate on `OPENRIND_SHELL_AGENT` in `setup.sh` (bash) and `process.env.OPENRIND_SHELL_AGENT` in Node.js.

## Build & test for OpenClaw

```bash
# Syntax + invariants (no Docker required)
bash -n sandboxes/openrind-shell/setup.sh
bash -n sandboxes/openrind-shell/openclaw-launch.sh
node --check sandboxes/openrind-shell/openclaw-config.mjs
python3 -c "import ast; ast.parse(open('sandboxes/openrind-shell/openrind-pty-bridge.py').read())"
grep -q "bind: 'loopback'" sandboxes/openrind-shell/openclaw-config.mjs

# PTY bridge scrollback filter (pure unit test, <1s). -B keeps __pycache__ out of
# sandboxes/, which the Dockerfile COPYs wholesale.
python3 -B tests/test_pty_bridge_scrollback.py

# Config seeder against a scratch path (it also creates sibling workspace/ and
# logs/ dirs, so never point --config at the repo root)
mkdir -p /tmp/oc
node sandboxes/openrind-shell/openclaw-config.mjs --config /tmp/oc/openclaw.json --tier full --json
node sandboxes/openrind-shell/openclaw-config.mjs --config /tmp/oc/openclaw.json --tier minimal --json

# Full OpenClaw setup path (requires Docker + PostgreSQL)
DATABASE_URL='...' OPENRIND_SHELL_AGENT=openclaw bash tests/test_setup_e2e.sh
```

Inside a running sandbox:

```bash
~/.openrind-shell/diagnose-openclaw.sh   # regenerated every launch
openclaw-launch                          # re-run the exact launch flow
```

See `openclaw-hang-diagnosis.md` for the failure-mode table.

## Hard Rules

- **Never fix forward from the middle.** Stop and restart the flow from scratch.
- **Never delete, move, or overwrite user files without explicit permission.**
- **If a file appears risky, stop and ask first.**
- **Never hardcode credentials, connection strings, or secrets into files.** Always read from environment variables at runtime.

## Commit Style

Descriptive, imperative mood. Look at `git log --oneline` for examples.
