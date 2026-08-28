#!/bin/bash
set -uo pipefail

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

if ! install -d -m 0700 "$HOME/.openclaw" "$HOME/.openclaw/logs" "$NODE_COMPILE_CACHE"; then
  echo "openrind-openclaw: failed to prepare the OpenClaw home or compile cache" >&2
  exit 1
fi
if ! cd "$OPENRIND_SHELL_HOME"; then
  echo "openrind-openclaw: FUSE workspace is unavailable at $OPENRIND_SHELL_HOME" >&2
  exit 1
fi

# Keep the persistent user-owned config, enforcing only the sandbox plumbing:
# local embedded mode, the FUSE workspace, and a first-run model when absent.
if /usr/bin/node /opt/openrind-shell/configure-openclaw-fuse.mjs; then
  :
else
  status=$?
  echo "openrind-openclaw: failed to configure OpenClaw (status $status)" >&2
  exit "$status"
fi

session_args=()
case "${1:-}" in
  ""|default) ;;
  *[!A-Za-z0-9._-]*)
    echo "openrind-openclaw: ignoring invalid session key" >&2
    ;;
  *) session_args+=("$1") ;;
esac

# OPENCLAW_PLUGIN_STAGE_DIR makes the client restage plugins during terminal
# input and was the source of severe keystroke latency in the previous flow.
unset OPENCLAW_PLUGIN_STAGE_DIR
export SHELL=/bin/bash

# Keep the real terminal on OpenClaw's stdin. The native fixed-target launcher
# remains its kernel-verifiable parent for provider authorization; this shell
# remains outside that trust boundary and owns the final FUSE durability barrier.
if ! exec 3<&0; then
  echo "openrind-openclaw: failed to preserve terminal input" >&2
  exit 1
fi
if [ ! -x /usr/local/bin/openrind-openclaw-agent ]; then
  echo "openrind-openclaw: native OpenClaw launcher is missing or not executable" >&2
  exit 126
fi
/usr/local/bin/openrind-openclaw-agent "${session_args[@]}" <&3 3<&- &
child=$!

forward_int() { kill -INT "$child" 2>/dev/null || true; }
forward_term() { kill -TERM "$child" 2>/dev/null || true; }
forward_hup() { kill -HUP "$child" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM
trap forward_hup HUP

while true; do
  if wait "$child"; then
    status=0
  else
    status=$?
  fi
  # A trapped signal interrupts wait before the child necessarily exits. Retry
  # only while the same child is still alive so its final status remains intact.
  kill -0 "$child" 2>/dev/null || break
done
trap - INT TERM HUP

if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  echo "openrind-openclaw: native launcher failed to start OpenClaw (status $status)" >&2
fi

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-openclaw: final FUSE flush failed; check openrind-shell-fused health before deleting the sandbox" >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
