#!/bin/bash
set -euo pipefail

export HOME=/sandbox/openclaw-home
export OPENRIND_SHELL_HOME=/sandbox/work
export OPENRIND_SHELL_OPENCLAW_HOME=/sandbox/openclaw-home
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
export OPENCLAW_NO_RESPAWN=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_EXEC_SHELL_SNAPSHOT=0
export OPENCLAW_LOG_LEVEL="${OPENCLAW_LOG_LEVEL:-error}"
export DEBUG="${DEBUG:-}"
export PI_DEBUG_REDRAW=0
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/openrind-openclaw-compile-cache}"

install -d -m 0700 "$HOME/.openclaw" "$HOME/.openclaw/logs" "$NODE_COMPILE_CACHE"
cd "$OPENRIND_SHELL_HOME"

# Keep the persistent user-owned config, enforcing only the sandbox plumbing:
# local embedded mode, the FUSE workspace, and a first-run model when absent.
node /opt/openrind-shell/configure-openclaw-fuse.mjs

args=(tui --local)
case "${1:-}" in
  ""|default) ;;
  *[!A-Za-z0-9._-]*)
    echo "openrind-openclaw: ignoring invalid session key" >&2
    ;;
  *) args+=(--session "$1") ;;
esac

# OPENCLAW_PLUGIN_STAGE_DIR makes the client restage plugins during terminal
# input and was the source of severe keystroke latency in the previous flow.
unset OPENCLAW_PLUGIN_STAGE_DIR
export SHELL=/bin/bash

# Keep the real terminal on OpenClaw's stdin while retaining a small parent that
# can issue the same final FUSE durability barrier as the Claude wrapper.
exec 3<&0
openclaw "${args[@]}" <&3 3<&- &
child=$!

forward_int() { kill -INT "$child" 2>/dev/null || true; }
forward_term() { kill -TERM "$child" 2>/dev/null || true; }
forward_hup() { kill -HUP "$child" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM
trap forward_hup HUP

set +e
while true; do
  wait "$child"
  status=$?
  kill -0 "$child" 2>/dev/null || break
done
set -e
trap - INT TERM HUP

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-openclaw: final FUSE flush failed; check openrind-shell-fused health before deleting the sandbox" >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
