#!/bin/sh
set -eu

if [ -f /tmp/openrind-shell-session.env ]; then
  # shellcheck disable=SC1091
  . /tmp/openrind-shell-session.env
elif [ -f /tmp/openeral-session.env ]; then
  # shellcheck disable=SC1091
  . /tmp/openeral-session.env
fi

export HOME="${HOME:-/sandbox}"
export PATH="$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
export SHELL="${SHELL:-/bin/bash}"
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"

# These are setup-only credentials. Claude should see the provider API key
# placeholder when present, but not the StringCost management key.
unset STRINGCOST_API_KEY
unset OPENRIND_GATEWAY_API_KEY
unset ANTHROPIC_AUTH_TOKEN

if [ ! -x /usr/local/bin/claude-real ]; then
  echo "openrind-shell: claude-real is missing; the sandbox image did not install Claude Code correctly" >&2
  exit 127
fi

if command -v openrind-shell >/dev/null 2>&1; then
  openrind-shell init --ensure
fi

if command -v openrind-shell-daemon-ensure >/dev/null 2>&1; then
  openrind-shell-daemon-ensure
fi

# Ensure bundled skills are present in Claude's home
COMPAT_SKILLS_SRC=""
[ -d /opt/openrind-shell/skills ] && COMPAT_SKILLS_SRC=/opt/openrind-shell/skills
[ -z "$COMPAT_SKILLS_SRC" ] && [ -d /sandbox/.skills ] && COMPAT_SKILLS_SRC=/sandbox/.skills
if [ -n "$COMPAT_SKILLS_SRC" ]; then
  mkdir -p "$HOME/.claude/skills" 2>/dev/null || true
  for skill_dir in "$COMPAT_SKILLS_SRC"/*; do
    if [ -d "$skill_dir" ]; then
      skill_name="$(basename "$skill_dir")"
      if [ ! -d "$HOME/.claude/skills/$skill_name" ]; then
        cp -r "$skill_dir" "$HOME/.claude/skills/" 2>/dev/null || true
      fi
    fi
  done
fi

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
  if kill -0 "$CHILD" 2>/dev/null; then
    continue
  fi
  break
done
set -e

trap - INT TERM HUP

/usr/local/bin/openrind-shell-bash --flush >/dev/null 2>&1 || true

exit "$STATUS"
