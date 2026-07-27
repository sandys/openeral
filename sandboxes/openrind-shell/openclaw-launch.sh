#!/bin/bash
# openclaw-launch.sh — owns the whole OpenClaw lifecycle inside the sandbox.
#
# Invoked by setup.sh (and re-runnable by hand as `openclaw-launch`). Replaces the
# previous "prepare the sandbox, then hand the user an interactive
# `openclaw onboard`" flow, which reliably stranded the TUI on "connecting".
#
# What changed and why
# --------------------
# 1. No onboarding. Onboarding is interactive, needs a browser on headless Linux
#    (it prints a dashboard URL and waits), and refuses to persist anything until
#    a live model completion succeeds. We write a valid config ourselves instead
#    (openclaw-config.mjs) so OpenClaw's state routing goes straight to the TUI.
#    The old gate `[ ! -s .../auth-profiles.json ]` also re-ran onboarding on
#    EVERY launch: auth profiles moved to openclaw-agent.sqlite, so that JSON file
#    is never created and the test was always true.
# 2. `openclaw gateway run` with a real config instead of `--allow-unconfigured`.
#    Unconfigured + container => gateway.bind defaults to `auto` (0.0.0.0), and
#    only true 127.0.0.1 connections get the loopback trust that auto-approves
#    device pairing. A pairing-pending connect retries silently forever, which is
#    exactly what "stuck on connecting" looks like.
# 3. The gateway is verified end to end (readiness AND an authenticated RPC round
#    trip) before the terminal is handed over, and pending pairing requests are
#    auto-approved.
# 4. If any of that fails, we fall back to `openclaw tui --local` — the embedded
#    runtime, no gateway, no WebSocket, no pairing. The user always gets a working
#    agent instead of a spinner.
# 5. OPENCLAW_HANDSHAKE_TIMEOUT_MS is no longer inflated to 10 minutes. That only
#    made a genuinely stuck handshake indistinguishable from a slow one.
#
# Deliberately NOT using `set -e`: every step below has an explicit degraded path.
# Aborting mid-flight is what leaves a blank terminal.
set -uo pipefail

OPENRIND_SHELL_DIR="${OPENRIND_SHELL_DIR:-/opt/openrind-shell}"
OPENCLAW_CONFIG_SEEDER="$OPENRIND_SHELL_DIR/openclaw-config.mjs"

export HOME=/home/agent

# A bad port override must fall back, never propagate. This value is written into
# gateway.port AND handed to `openclaw gateway run --port`, so a garbage one costs
# more than it looks: the gateway binds a port the TUI is not looking at, which
# presents as "stuck on connecting" with a perfectly healthy gateway.
#
# The clamp has to happen HERE rather than only in openclaw-config.mjs: the
# re-export below is what the seeder reads, so clamping first means the seeder can
# never see the raw value and the two can never disagree about the port. (The
# seeder keeps its own equivalent check — it is also run standalone.)
OPENCLAW_PORT_DEFAULT=18789
OPENCLAW_PORT="${OPENRIND_SHELL_OPENCLAW_PORT:-$OPENCLAW_PORT_DEFAULT}"
openclaw_port_ok() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  # Bound the digit count before the numeric compare so a 40-digit string cannot
  # overflow the shell's integer parsing.
  [ "${#1}" -le 5 ] || return 1
  [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le 65535 ]
}
if ! openclaw_port_ok "$OPENCLAW_PORT"; then
  printf 'openclaw-launch: ignoring OPENRIND_SHELL_OPENCLAW_PORT=%s (want an integer 1-65535); using %s\n' \
    "$OPENCLAW_PORT" "$OPENCLAW_PORT_DEFAULT" >&2
  OPENCLAW_PORT="$OPENCLAW_PORT_DEFAULT"
fi
OPENCLAW_PORT="$((10#$OPENCLAW_PORT))"
export OPENCLAW_PORT
export OPENRIND_SHELL_OPENCLAW_PORT="$OPENCLAW_PORT"

OPENCLAW_STATE_DIR_DEFAULT="$HOME/.openclaw"
GW_LOG="${OPENCLAW_GATEWAY_LOG:-/tmp/openclaw-gateway.log}"
GW_PID_FILE=/tmp/openclaw-gateway.pid
LAUNCH_LOG="${OPENCLAW_LAUNCH_LOG:-/tmp/openclaw-launch.log}"
STAGE_DIR=/tmp/openclaw-plugin-runtime-deps
COMPILE_CACHE=/tmp/openclaw-compile-cache

# Bounded budgets. Every wait in this script terminates.
GW_READY_TIMEOUT="${OPENCLAW_GATEWAY_READY_TIMEOUT:-180}"
CLIENT_VERIFY_ATTEMPTS=3
PAIRING_WATCHDOG_SECONDS=120

# Hard ceiling on the whole launch. Individual steps are already bounded, but
# their worst cases compose; this makes "the terminal is handed over within N
# seconds, whatever happens" a single guarantee rather than an emergent property.
# Exceeding it is not a failure — it drops to local mode, which still works.
LAUNCH_STARTED_AT="$(date +%s)"
LAUNCH_BUDGET="${OPENCLAW_LAUNCH_BUDGET:-420}"
budget_left() { echo $((LAUNCH_BUDGET - ($(date +%s) - LAUNCH_STARTED_AT))); }
budget_exhausted() { [ "$(budget_left)" -le 0 ]; }

log() { printf 'openclaw-launch: %s\n' "$*" >>"$LAUNCH_LOG"; }
warn() { printf 'openclaw-launch: %s\n' "$*" >&2; }
# Progress goes to stderr, which setup.sh leaves attached to the terminal. The
# screen is wiped before the TUI execs, so this cannot bleed into the agent UI.
progress() { printf 'openclaw: %s\n' "$*" >&2; }

mkdir -p "$OPENCLAW_STATE_DIR_DEFAULT" "$OPENCLAW_STATE_DIR_DEFAULT/logs" \
  "$COMPILE_CACHE" "$STAGE_DIR" /home/agent/.openrind-shell 2>/dev/null || true

# ── Runtime environment ───────────────────────────────────────────────────────
# Container hygiene, all documented OpenClaw switches:
#   NO_RESPAWN            our supervisor owns the pid; never hand off to a
#                         detached update child.
#   SKIP_CHANNELS         no WhatsApp/Telegram/Slack transports in a sandbox, and
#                         channels are one of the three things /readyz waits on.
#   SKIP_CANVAS_HOST      no canvas plugin host.
#   SKIP_GMAIL_WATCHER    the gateway otherwise auto-starts a Gmail watcher.
#   DISABLE_BONJOUR       bridge networking drops multicast; advertising retries.
#   OFFLINE               do not fetch the pinned fd/ripgrep helper binaries; the
#                         hosts are not in policy.yaml, so the fetch would stall.
#   EXEC_SHELL_SNAPSHOT   the snapshot spawns `process.execPath -e <script>` from
#                         a login shell; pointless here and pure startup cost.
#   NODE_COMPILE_CACHE    reuse the V8 bytecode cache baked into the image.
export OPENCLAW_NO_RESPAWN=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_OFFLINE=1
export OPENCLAW_EXEC_SHELL_SNAPSHOT=0
export NODE_COMPILE_CACHE="$COMPILE_CACHE"

# ── Banner ───────────────────────────────────────────────────────────────────
# The pre-TUI OpenClaw splash (lobster glyph + version + commit + coloured
# tagline) is SHOWN by default.
#
# It used to be suppressed with OPENCLAW_HIDE_BANNER=1 because the Windows ConPTY
# re-render smeared that line into a gibberish bar above the agent UI. That
# rationale is gone: the agent now runs on a real Linux PTY hosted by
# openrind-pty-bridge.py, so ConPTY is out of the byte path entirely, and the
# bridge additionally emits a terminal-mode reset before the agent's first byte.
# Suppressing the banner also hid a useful signal — the version string is the
# fastest way to confirm which OpenClaw a sandbox is actually running.
#
# Set OPENRIND_SHELL_OPENCLAW_HIDE_BANNER=1 to suppress it again if the smearing
# ever regresses.
if [ -n "${OPENRIND_SHELL_OPENCLAW_HIDE_BANNER:-}" ]; then
  export OPENCLAW_HIDE_BANNER=1
  log "banner suppressed via OPENRIND_SHELL_OPENCLAW_HIDE_BANNER"
fi

# Two separate things kept the banner from being *visible* even though OpenClaw
# was printing it. Only one of them lives here.
#
# 1. The glyph. OpenClaw's supportsDecorativeEmoji() (packages/terminal-core)
#    strips every decorative emoji — from the banner title AND from taglines —
#    unless TERM_PROGRAM matches its known-good list (iterm / apple_terminal /
#    ghostty / wezterm / vscode), WT_SESSION is set, or the platform is darwin.
#    A Linux container with TERM=xterm-256color and no TERM_PROGRAM matches
#    nothing, so the lobster was silently dropped and the banner arrived as bare
#    text. Openrind Desktop renders the agent in xterm.js — the same emulator
#    VS Code's integrated terminal uses — so `vscode` is both an accurate claim
#    and the safest entry on that list: it is the only one that does not also
#    switch on something we cannot render. (ghostty/wezterm additionally enable
#    OSC 9;4 progress reporting; every other TERM_PROGRAM consumer in OpenClaw
#    is win32-only or darwin-only, so `vscode` changes nothing else on Linux.)
#    Never override a value the user's own terminal already declared: a pop-out
#    terminal knows its own capabilities better than we do.
#
# 2. Survival. `openclaw tui` prints the banner and then erases it about 5 KB
#    later, when the session display initialises. That one is fixed in
#    openrind-pty-bridge.py — see the ScrollbackKeeper comment there.
if [ -z "${TERM_PROGRAM:-}" ]; then
  export TERM_PROGRAM=vscode
  log "TERM_PROGRAM=vscode (xterm.js) so OpenClaw keeps its decorative glyphs"
fi
# supportsDecorativeEmoji() also bails out on TERM=dumb, and a colourless banner
# has no red tagline left to see. The bridge already defaults TERM; this only
# covers a caller that pinned it to something inert.
case "${TERM:-}" in
  '' | dumb)
    log "TERM was '${TERM:-}' — forcing xterm-256color so the banner keeps colour"
    export TERM=xterm-256color
    ;;
esac
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
# Enough for a cold container, short enough that a broken handshake fails fast
# and this script's fallback can act on it.
export OPENCLAW_HANDSHAKE_TIMEOUT_MS="${OPENCLAW_HANDSHAKE_TIMEOUT_MS:-60000}"
# Pin the port for every client so nothing depends on discovery or on the
# gateway's recorded runtime port.
export OPENCLAW_GATEWAY_PORT="$OPENCLAW_PORT"
# github.com:22 is blocked by policy; the egress proxy terminates TLS with a CA
# git does not trust. Needed by any git-backed plugin dependency fetch.
export GIT_SSL_NO_VERIFY=true
export npm_config_strict_ssl=false

# ── Plugin + bytecode cache seeding ──────────────────────────────────────────
# Seed the bundled runtime-dep cache if the image has one. On the pinned OpenClaw
# (2026.7.x) nothing stages bundled deps, so /opt/openclaw-plugin-cache is empty
# and this is a no-op — keep it anyway: it costs nothing when empty and is what
# makes an older pin (which DOES stage, via npm the network policy restricts)
# resolve every spec locally instead of hanging.
seed_caches() {
  if [ -d /opt/openclaw-compile-cache ] && [ -n "$(ls -A /opt/openclaw-compile-cache 2>/dev/null)" ]; then
    cp -rn /opt/openclaw-compile-cache/. "$COMPILE_CACHE"/ 2>/dev/null || true
    log "seeded V8 compile cache from image"
    progress "seeding the OpenClaw bytecode cache"
  fi
  if [ -d /opt/openclaw-plugin-cache ] && [ -n "$(ls -A /opt/openclaw-plugin-cache 2>/dev/null)" ]; then
    cp -rn /opt/openclaw-plugin-cache/. "$STAGE_DIR"/ 2>/dev/null || true
    log "seeded plugin runtime deps from image"
    progress "seeding OpenClaw plugin dependencies"
  fi

  # Expose the staged deps at OpenClaw's DEFAULT location so the TUI finds them
  # without OPENCLAW_PLUGIN_STAGE_DIR in its environment. Passing that variable
  # to a client process makes it run its own staging loop on every keystroke and
  # saturates the event loop. The symlink target is under /tmp, which the
  # workspace sync excludes, so the persisted home never holds an npm cache.
  local prd="$OPENCLAW_STATE_DIR_DEFAULT/plugin-runtime-deps"
  if [ -d "$prd" ] && [ ! -L "$prd" ]; then
    log "replacing stale plugin-runtime-deps directory with a symlink into /tmp"
    rm -rf "$prd"
  fi
  ln -sfn "$STAGE_DIR" "$prd" 2>/dev/null || true
}

# ── Config seeding, with tier fallback ───────────────────────────────────────
# Write the richest config first. If this OpenClaw build rejects one of the
# hardening keys, step down a tier rather than shipping a config that makes the
# gateway refuse to start (exit 78) or routes bare `openclaw` into onboarding.
CONFIG_VALIDATE_OUT=/tmp/openclaw-config-validate.json
config_valid() {
  if timeout 90 openclaw config validate --json </dev/null >"$CONFIG_VALIDATE_OUT" 2>&1; then
    return 0
  fi
  # A build without `openclaw config validate` must not be read as "config is
  # broken" — that would send a perfectly good launch down the failure path.
  if grep -qiE "unknown (command|option)|unrecognized|did you mean" "$CONFIG_VALIDATE_OUT" 2>/dev/null; then
    log "openclaw config validate unavailable in this build — skipping validation"
    return 0
  fi
  return 1
}

seed_config() {
  local tier
  for tier in full core minimal; do
    if ! node "$OPENCLAW_CONFIG_SEEDER" --tier "$tier" >>"$LAUNCH_LOG" 2>&1; then
      log "config seeder failed at tier=$tier"
      continue
    fi
    if config_valid; then
      log "config valid at tier=$tier"
      progress "config valid at tier=$tier"
      return 0
    fi
    log "config rejected at tier=$tier: $(head -c 400 "$CONFIG_VALIDATE_OUT" 2>/dev/null)"
  done

  # Nothing we wrote validates. Do not fix forward from a partially-good file:
  # preserve it and restart the flow from an empty config.
  local cfg="$OPENCLAW_STATE_DIR_DEFAULT/openclaw.json"
  if [ -f "$cfg" ]; then
    mv "$cfg" "$cfg.rejected.$(date +%s)" 2>/dev/null || true
    log "moved rejected config aside and retrying from scratch"
  fi
  if node "$OPENCLAW_CONFIG_SEEDER" --tier minimal >>"$LAUNCH_LOG" 2>&1 && config_valid; then
    log "config valid at tier=minimal after reset"
    return 0
  fi
  warn "OpenClaw config could not be validated; see /tmp/openclaw-config-validate.json"
  return 1
}

# ── Gateway ──────────────────────────────────────────────────────────────────
gateway_live() { curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$OPENCLAW_PORT/healthz" 2>/dev/null; }
gateway_ready() { curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$OPENCLAW_PORT/readyz" 2>/dev/null; }
# `setsid` forks, so the `$!` of the spawn is a pid that exits immediately and
# tells us nothing about the gateway. Match the real process instead.
# If pgrep is unavailable, assume alive: a false "dead" reading would abort a
# perfectly good startup, while a false "alive" one only costs us the readiness
# budget we were going to spend anyway.
gateway_process_alive() {
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -f 'openclaw gateway' >/dev/null 2>&1
}

spawn_gateway() {
  log "starting gateway on 127.0.0.1:$OPENCLAW_PORT"
  progress "starting the OpenClaw gateway"
  # setsid detaches the gateway from this PTY's session so closing the terminal
  # (or the TUI exiting) does not SIGHUP it — a reconnect then finds it ready.
  # OPENCLAW_PLUGIN_STAGE_DIR is passed HERE ONLY, never to a client.
  setsid env \
    OPENCLAW_PLUGIN_STAGE_DIR="$STAGE_DIR" \
    openclaw gateway run --port "$OPENCLAW_PORT" \
    </dev/null >>"$GW_LOG" 2>&1 &
}

# Returns 0 once /readyz answers. Bails early if the gateway process is gone
# (e.g. exit 78, OpenClaw's documented "invalid configuration" code) instead of
# burning the whole budget on a corpse.
wait_for_gateway() {
  local budget="${1:-$GW_READY_TIMEOUT}"
  local waited=0
  while [ "$waited" -lt "$budget" ]; do
    if gateway_ready; then
      log "gateway ready after ${waited}s"
      progress "gateway ready after ${waited}s"
      pgrep -f 'openclaw gateway' 2>/dev/null | head -1 >"$GW_PID_FILE"
      return 0
    fi
    # 20s grace for process spawn + Node boot before trusting the liveness check.
    if [ "$waited" -ge 20 ] && ! gateway_process_alive && ! gateway_live; then
      log "no gateway process alive after ${waited}s — see $GW_LOG"
      return 1
    fi
    if budget_exhausted; then
      log "overall launch budget (${LAUNCH_BUDGET}s) exhausted while waiting for the gateway"
      return 1
    fi
    # waited advances in 2s steps, so this reports every 30s.
    [ $((waited % 30)) -eq 0 ] && [ "$waited" -gt 0 ] &&
      progress "waiting for the gateway to become ready (${waited}s/${budget}s)"
    sleep 2
    waited=$((waited + 2))
  done
  log "gateway did not reach /readyz within ${budget}s"
  return 1
}

start_gateway() {
  if gateway_ready; then
    log "reusing already-ready gateway on :$OPENCLAW_PORT"
    progress "reusing already-ready gateway"
    return 0
  fi
  # Something is bound but not ready: let it finish rather than racing a second
  # instance into EADDRINUSE.
  if gateway_live; then
    log "gateway is live but not ready yet — waiting"
    wait_for_gateway && return 0
  else
    spawn_gateway
    wait_for_gateway && return 0
  fi

  # One repair attempt, then one retry. Never more: a loop here is how a launch
  # turns into a ten-minute stall.
  if budget_exhausted; then
    log "launch budget exhausted — skipping the doctor --fix retry"
    return 1
  fi
  log "attempting doctor --fix before a single gateway retry"
  progress "gateway did not come up — running one repair pass"
  timeout 120 openclaw doctor --fix --yes --non-interactive </dev/null >>"$LAUNCH_LOG" 2>&1
  seed_config
  gateway_ready && return 0
  gateway_live || spawn_gateway
  # The retry gets whatever is left of the overall budget, never a fresh full one.
  local remaining
  remaining="$(budget_left)"
  [ "$remaining" -gt 30 ] || remaining=30
  wait_for_gateway "$remaining"
}

# ── Device pairing ───────────────────────────────────────────────────────────
# Loopback connects are documented to auto-approve pairing, but a pairing-pending
# connect is retryable and silent, so if that ever does not hold the symptom is an
# infinite "connecting". Approving pending requests is cheap insurance.
#
# `openclaw devices list --json` has no published schema, so the extractor walks
# the whole document and collects anything that looks like a pending request id.
approve_pending_devices() {
  local ids
  ids="$(timeout 25 openclaw devices list --json 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let doc;
  try { doc = JSON.parse(raw); } catch { return; }
  const ids = new Set();
  const approved = /^(approved|active|trusted)$/i;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const id = node.requestId ?? node.pairingId ?? node.id;
    const state = String(node.status ?? node.state ?? node.pairing ?? "");
    const looksPending =
      node.approvedAt == null && node.approved !== true && !approved.test(state);
    if (typeof id === "string" && id && looksPending && ("requestId" in node || /pend/i.test(state))) {
      ids.add(id);
    }
    Object.values(node).forEach(walk);
  };
  walk(doc);
  process.stdout.write([...ids].join("\n"));
});
' 2>/dev/null)"
  [ -n "$ids" ] || return 0
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    log "approving pending device pairing request $id"
    timeout 25 openclaw devices approve "$id" </dev/null >>"$LAUNCH_LOG" 2>&1
  done <<<"$ids"
}

# The TUI mints its own pairing request when IT connects, which is after this
# script has exec'd. Keep approving in the background for a bounded window so a
# pairing-pending retry loop resolves itself within a couple of seconds.
start_pairing_watchdog() {
  (
    elapsed=0
    while [ "$elapsed" -lt "$PAIRING_WATCHDOG_SECONDS" ]; do
      approve_pending_devices
      sleep 5
      elapsed=$((elapsed + 5))
    done
  ) </dev/null >/dev/null 2>&1 &
}

# ── End-to-end client verification ───────────────────────────────────────────
# /readyz proves the server answers; it does NOT prove an authenticated client
# can complete connect.challenge -> connect -> hello-ok. `openclaw health` does
# exactly that round trip, so it is the real gate on whether the TUI will attach.
verify_client() {
  local attempt=0 err=/tmp/openclaw-health.err
  while [ "$attempt" -lt "$CLIENT_VERIFY_ATTEMPTS" ]; do
    if budget_exhausted; then
      log "overall launch budget (${LAUNCH_BUDGET}s) exhausted while verifying the client"
      return 1
    fi
    # Announce BEFORE the round trip, not after it. `openclaw devices list` +
    # `openclaw health` measure ~27s together on a cold gateway, and reporting
    # only on success left that whole stretch with nothing moving on the
    # loading screen — the single longest silent gap in a healthy launch.
    if [ "$attempt" -eq 0 ]; then
      progress "verifying the OpenClaw connection (usually ~30s)"
    else
      progress "verifying the OpenClaw connection (attempt $((attempt + 1)) of $CLIENT_VERIFY_ATTEMPTS)"
    fi
    approve_pending_devices
    if timeout 30 openclaw health --json </dev/null >>"$LAUNCH_LOG" 2>"$err"; then
      log "authenticated gateway round trip ok"
      progress "OpenClaw connection verified"
      return 0
    fi
    # An OpenClaw build without `openclaw health` must not be mistaken for a
    # broken gateway — /readyz already passed at this point.
    if grep -qiE "unknown (command|option)|unrecognized|did you mean" "$err" 2>/dev/null; then
      log "openclaw health unavailable in this build — trusting /readyz"
      return 0
    fi
    log "gateway round trip failed (attempt $((attempt + 1))): $(head -c 300 "$err" 2>/dev/null)"
    attempt=$((attempt + 1))
    sleep 4
  done
  return 1
}

# ── Terminal handover ────────────────────────────────────────
# ED-2 then home, NOT home then ED-2. Both leave the same state (ED never moves
# the cursor), but `ESC[2J ESC[H` is the exact pair openrind-pty-bridge.py rewrites
# into a scroll, so on the desktop this pushes the launch progress log into the
# scrollback instead of erasing it. ESC[3J stays first and is dropped by the same
# filter; outside the desktop it still wipes the scrollback as before.
clear_screen() { printf '\033[3J\033[2J\033[H'; }

# NEVER clear immediately before exec'ing the TUI — see the banner note below.
exec_gateway_tui() {
  start_pairing_watchdog
  # No clear_screen() here on purpose. `openclaw tui` prints the banner and then,
  # ~5 KB later, pi-tui's first render issues its own unconditional full clear
  # (ESC[2J ESC[H ESC[3J) — unconditional because pi-tui forces the clearing
  # variant by setting previousWidth/-Height to -1, with no flag to disable it.
  # So the agent UI arrives on a clean screen whether or not we clear first: this
  # call was redundant for its stated purpose.
  #
  # It was not harmless, though. The bridge rewrites each such clear into a scroll
  # of EXACTLY ONE SCREENFUL, so clearing here made two scrolls where the agent
  # only needs one, with the banner stranded between them — a full screen of blank
  # rows below the launch log and another full screen above the TUI. The bridge
  # log showed the cost plainly: two "rewrote agent full-screen clear (rows=40)"
  # lines per launch. Dropping this one leaves a single scroll, so the banner and
  # the launch log land directly above the agent UI where they can actually be
  # scrolled back to.
  #
  # No --url: with an explicit --url the TUI stops falling back to config
  # credentials and errors on anything missing. OPENCLAW_GATEWAY_PORT already
  # pins the target to 127.0.0.1:$OPENCLAW_PORT.
  # OPENCLAW_PLUGIN_STAGE_DIR must stay unset for client processes.
  exec env -u OPENCLAW_PLUGIN_STAGE_DIR \
    SHELL=/usr/local/bin/openrind-shell-bash \
    openclaw tui "$@"
}

exec_local_tui() {
  local reason="$1"
  shift
  # When local mode is the intended default there is nothing to apologise for, so
  # don't burn 5s of the user's time on a banner. The verbose form is only for the
  # genuinely degraded path (gateway mode was requested and failed).
  if [ "${OPENCLAW_MODE:-local}" != "local" ]; then
    clear_screen
    cat <<BANNER
Openrind Shell: falling back to OpenClaw LOCAL mode (embedded agent, no gateway).

  Reason: $reason

  Local mode runs the agent in this process. Everything you need for coding
  works; only gateway-only extras (chat channels, remote nodes, /steer) are
  unavailable.

  Logs:   $GW_LOG
          $LAUNCH_LOG
  Retry the gateway at any time with:  openclaw-launch

BANNER
    sleep 5
  fi
  # As in exec_gateway_tui: no clear before the exec. pi-tui clears on its first
  # render regardless, and clearing here would cost a second full-screen scroll
  # that buries the banner (and, on this path, the explanation above it).
  exec env -u OPENCLAW_PLUGIN_STAGE_DIR \
    SHELL=/usr/local/bin/openrind-shell-bash \
    openclaw tui --local "$@"
}

# ── Diagnostics helper ───────────────────────────────────────────────────────
# Written every launch so it always matches the flow that actually ran.
write_diagnostic_helper() {
  cat >/home/agent/.openrind-shell/diagnose-openclaw.sh <<DIAG
#!/bin/bash
# Generated by openclaw-launch.sh. Run this after a failed OpenClaw launch.
export HOME=/home/agent
echo "=== openclaw version ===";        openclaw --version 2>&1 || true
echo; echo "=== relevant env ==="
env | grep -E '^(HOME|TERM|TERM_PROGRAM|ANTHROPIC_|OPENCLAW_|OPENRIND_SHELL_PTY_|NODE_COMPILE_CACHE|GIT_SSL_NO_VERIFY|npm_config_)' \\
  | sed 's/\\(ANTHROPIC_API_KEY=\\).*/\\1***REDACTED***/'
echo; echo "=== config validate ===";      openclaw config validate --json 2>&1 | head -40
echo; echo "=== gateway /healthz ===";     curl -fsS -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1:$OPENCLAW_PORT/healthz 2>&1 || echo '(unreachable)'
echo; echo "=== gateway /readyz ===";      curl -fsS -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1:$OPENCLAW_PORT/readyz 2>&1 || echo '(unreachable)'
echo; echo "=== gateway probe ===";        timeout 45 openclaw gateway probe --json 2>&1 | head -60
echo; echo "=== pending devices ===";      timeout 25 openclaw devices list 2>&1 | head -30
echo; echo "=== launch log tail ===";      tail -40 $LAUNCH_LOG 2>&1 || true
echo; echo "=== gateway log tail ===";     tail -60 $GW_LOG 2>&1 || true
# Drive mode + whether the banner/launch-log scrollback rewrite actually fired.
echo; echo "=== pty bridge log ===";       tail -20 /tmp/openrind-pty-bridge.log 2>&1 || true
echo; echo "Retry the whole flow with: openclaw-launch"
DIAG
  chmod +x /home/agent/.openrind-shell/diagnose-openclaw.sh 2>/dev/null || true
}

# ── Main ─────────────────────────────────────────────────────────────────────
if ! command -v openclaw >/dev/null 2>&1; then
  warn "OpenClaw not found in image — falling back to a runtime install (slow)"
  # Pinned to the same build as the Dockerfile. `@latest` here made the one path
  # that actually needs reproducibility — an image that somehow shipped without
  # OpenClaw — the only path that ignored the pin, and CLAUDE.md forbids anything
  # below 2026.7.x (2026.4.29's acpx plugin wedges the TUI on "connecting").
  SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error openclaw@2026.7.1-2 >>"$LAUNCH_LOG" 2>&1
  if ! command -v openclaw >/dev/null 2>&1; then
    warn "ERROR: OpenClaw install failed; see $LAUNCH_LOG"
    exit 1
  fi
fi

seed_caches
write_diagnostic_helper
seed_config
CONFIG_OK=$?

# Persist the runtime env so a reconnect shell (`openshell sandbox connect`) and
# a manual `openclaw` invocation behave identically to this launch.
cat >/home/agent/.openrind-shell/openclaw-env.sh <<ENVFILE
# Written by openclaw-launch.sh — runtime env for manual openclaw invocations.
export HOME=/home/agent
export OPENCLAW_GATEWAY_PORT=$OPENCLAW_PORT
export OPENCLAW_NO_RESPAWN=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_OFFLINE=1
export OPENCLAW_EXEC_SHELL_SNAPSHOT=0
export NODE_COMPILE_CACHE=$COMPILE_CACHE
export GIT_SSL_NO_VERIFY=true
export npm_config_strict_ssl=false
ENVFILE

if [ "$CONFIG_OK" -ne 0 ]; then
  # An invalid config is the one failure with no degraded path: local mode does
  # not bypass the invalid-config guard either. Spend one bounded repair attempt
  # before giving up, since `doctor --fix` is the only lever left after the tier
  # stepdown and the from-scratch rewrite have both failed.
  warn "OpenClaw configuration did not validate — attempting one repair pass..."
  progress "repairing OpenClaw configuration"
  timeout 120 openclaw doctor --fix --yes --non-interactive </dev/null >>"$LAUNCH_LOG" 2>&1
  seed_config
  CONFIG_OK=$?
fi

if [ "$CONFIG_OK" -ne 0 ]; then
  warn "OpenClaw configuration is invalid — refusing to launch into a hang."
  warn "  validation output: $CONFIG_VALIDATE_OUT"
  warn "  diagnostics:       ~/.openrind-shell/diagnose-openclaw.sh"
  warn "  then retry with:   openclaw-launch"
  exit 78
fi

# ── Mode selection ───────────────────────────────────────────────────────────
# Gateway mode is the default: it is the full feature set (channels, nodes,
# /steer) and, on the pinned OpenClaw, it works.
#
# History worth keeping: on 2026.4.29 the gateway-mode TUI client was unusable —
# it opened its WebSocket and then burned 100% CPU for ~4 minutes without
# servicing it, showing "connecting | idle" with the model as "unknown". That was
# never the gateway, the config, or pairing (all verified healthy); it was the
# client walking acpx's ~2.5 GB / 95k-file bundled dep tree on startup. 2026.7.x
# drops acpx and stages nothing, and both modes now settle in seconds:
#
#                     2026.4.29              2026.7.1-2
#   gateway TUI CPU   14s -> 48s climbing    4s -> 4s flat
#   local   TUI CPU   12s -> 45s climbing    6s -> 6s flat
#
# OPENRIND_SHELL_OPENCLAW_MODE=local switches to the embedded runtime (no
# gateway, no WebSocket, no pairing) if the gateway path ever regresses again.
# The automatic fallback below also drops to local on its own.
OPENCLAW_MODE="${OPENRIND_SHELL_OPENCLAW_MODE:-gateway}"

if [ "$OPENCLAW_MODE" = "local" ]; then
  log "mode=local (embedded agent; no gateway) via OPENRIND_SHELL_OPENCLAW_MODE"
  if [ -n "${OPENRIND_SHELL_SETUP_ONLY:-}" ]; then
    # seed_caches/seed_config already ran; starting a gateway nobody will use only
    # wastes loading-screen time and leaves a stray process behind.
    echo "openclaw-launch: setup-only mode — config seeded; local mode needs no gateway"
    exit 0
  fi
  exec_local_tui "OPENRIND_SHELL_OPENCLAW_MODE=local" "$@"
fi

log "mode=gateway"
GATEWAY_OK=1
if start_gateway; then
  if verify_client; then
    GATEWAY_OK=0
  else
    log "gateway is ready but no client could complete an authenticated connect"
  fi
elif gateway_process_alive; then
  # /readyz never answered but the gateway process is up. The HTTP probe is a
  # convenience, not the contract that matters — what decides whether the TUI
  # attaches is an authenticated WebSocket round trip. Give the real gate a
  # chance before writing the gateway off.
  log "readiness probe never answered; trying an authenticated connect anyway"
  progress "readiness probe silent — testing the gateway connection directly"
  verify_client && GATEWAY_OK=0
fi

# Setup-only mode is the desktop's loading-screen prewarm. Bringing the gateway
# up here is the whole point: by the time the user's terminal attaches, /readyz
# is already green and the TUI connects immediately instead of spinning.
if [ -n "${OPENRIND_SHELL_SETUP_ONLY:-}" ]; then
  if [ "$GATEWAY_OK" -eq 0 ]; then
    echo "openclaw-launch: setup-only mode — gateway ready on :$OPENCLAW_PORT"
  else
    echo "openclaw-launch: setup-only mode — gateway not ready; connect will use local mode"
  fi
  exit 0
fi

if [ "$GATEWAY_OK" -eq 0 ]; then
  exec_gateway_tui "$@"
fi

if gateway_live; then
  exec_local_tui "gateway is running but never accepted a client connection" "$@"
else
  exec_local_tui "gateway did not become ready within ${GW_READY_TIMEOUT}s" "$@"
fi
