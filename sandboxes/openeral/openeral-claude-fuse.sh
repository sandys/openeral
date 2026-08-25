#!/bin/sh
set -eu

RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-${OPENERAL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}}"
if [ -f "$RUNTIME_DIR/session.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/session.env"
fi

export HOME="${OPENRIND_SHELL_CLAUDE_HOME:-/sandbox/claude-home}"
export OPENRIND_SHELL_HOME=/sandbox/work
export OPENRIND_SHELL_RUNTIME_DIR="$RUNTIME_DIR"
export OPENRIND_SHELL_STATE_DIR="$RUNTIME_DIR"
export OPENRIND_SHELL_DB_URL_FILE="$RUNTIME_DIR/database-url"
export OPENRIND_SHELL_INIT_MARKER="$RUNTIME_DIR/init.done"
export OPENRIND_SHELL_REQUIRE_POSTGRES_TLS=1
export OPENERAL_HOME=/sandbox/work
export OPENERAL_RUNTIME_DIR="$RUNTIME_DIR"
export OPENERAL_STATE_DIR="$RUNTIME_DIR"
export OPENERAL_DB_URL_FILE="$RUNTIME_DIR/database-url"
export OPENERAL_INIT_MARKER="$RUNTIME_DIR/init.done"
export OPENERAL_REQUIRE_POSTGRES_TLS=1
export SHELL="${SHELL:-/bin/bash}"
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
# Claude Code is installed by the immutable sandbox image. Disable update,
# telemetry, feedback, and crash-report traffic that is unrelated to an
# interactive agent session; in particular this avoids first-launch cache work
# on the PostgreSQL-backed HOME. This is an Anthropic-supported environment
# control and does not create settings, accept trust, or skip onboarding. Claude
# writes that state to its local named-volume HOME, not the PostgreSQL FUSE mount.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"

unset STRINGCOST_API_KEY
unset OPENRIND_GATEWAY_API_KEY
unset ANTHROPIC_AUTH_TOKEN

if [ ! -x /usr/local/bin/claude-real ]; then
  echo "openrind-shell: claude-real is missing from the sandbox image" >&2
  exit 127
fi

# Keep successful marker verification out of Claude's terminal. The command's
# diagnostics are still surfaced verbatim when initialization is missing or
# stale, but a healthy reconnect paints Claude as the first application output.
ENSURE_LOG="${RUNTIME_DIR}/claude-init-ensure.log"
set +e
openrind-shell init --ensure >"$ENSURE_LOG" 2>&1
ENSURE_STATUS=$?
set -e
if [ "$ENSURE_STATUS" -ne 0 ]; then
  cat "$ENSURE_LOG" >&2
  exit "$ENSURE_STATUS"
fi
rm -f "$ENSURE_LOG"

HEALTH="$(openrind-shell-fused health 2>/dev/null || true)"
STATE="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).state || "") } catch {}' "$HEALTH")"
if [ "$STATE" != writable ]; then
  echo "openrind-shell: FUSE storage is not writable (state: ${STATE:-unavailable})" >&2
  exit 1
fi

case "$PWD" in
  /|/sandbox) cd /sandbox/work ;;
esac

# Keep the terminal on Claude's stdin. A non-interactive shell gives an
# asynchronous command /dev/null as stdin (POSIX; dash ignores a plain <&0),
# so save the wrapper's stdin on fd 3 first and hand that to the child.
exec 3<&0
/usr/local/bin/claude-real "$@" <&3 3<&- &
CHILD=$!

forward_int() { kill -INT "$CHILD" 2>/dev/null || true; }
forward_term() { kill -TERM "$CHILD" 2>/dev/null || true; }
forward_hup() { kill -HUP "$CHILD" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM
trap forward_hup HUP

set +e
while true; do
  wait "$CHILD"
  STATUS=$?
  kill -0 "$CHILD" 2>/dev/null || break
done
set -e
trap - INT TERM HUP

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-shell: final FUSE flush failed; check 'openrind-shell-fused health' before deleting the sandbox" >&2
  [ "$STATUS" -ne 0 ] || STATUS=1
fi
exit "$STATUS"
