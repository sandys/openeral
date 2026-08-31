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

sync_bundled_skills() {
  local src="$1"
  local dst="$2"
  [ -d "$src" ] || return 0
  node - "$src" "$dst" << 'EOF'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [,, srcBase, dstBase] = process.argv;
if (!srcBase || !dstBase || !fs.existsSync(srcBase)) process.exit(0);

function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

try {
  fs.mkdirSync(dstBase, { recursive: true });
  const entries = fs.readdirSync(srcBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const srcDir = path.join(srcBase, skillName);
    const dstDir = path.join(dstBase, skillName);
    const manifestPath = path.join(dstDir, '.managed-manifest.json');

    let oldManifest = {};
    if (fs.existsSync(manifestPath)) {
      try {
        oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        oldManifest = {};
      }
    }

    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }

    const newManifest = {};

    function syncDir(currentSrc, currentDst, relPrefix = '') {
      fs.mkdirSync(currentDst, { recursive: true });
      const items = fs.readdirSync(currentSrc, { withFileTypes: true });
      for (const item of items) {
        if (item.name === '.managed-manifest.json' || item.name === '.git') continue;
        const srcItemPath = path.join(currentSrc, item.name);
        const dstItemPath = path.join(currentDst, item.name);
        const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;

        if (item.isDirectory()) {
          syncDir(srcItemPath, dstItemPath, relPath);
        } else if (item.isFile()) {
          const srcHash = hashFile(srcItemPath);
          if (!srcHash) continue;
          newManifest[relPath] = srcHash;

          if (!fs.existsSync(dstItemPath)) {
            fs.copyFileSync(srcItemPath, dstItemPath);
          } else {
            const dstHash = hashFile(dstItemPath);
            if (dstHash !== srcHash) {
              const prevHash = oldManifest[relPath];
              if (!prevHash || dstHash === prevHash) {
                fs.copyFileSync(srcItemPath, dstItemPath);
              }
            }
          }
        }
      }
    }

    syncDir(srcDir, dstDir);
    fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + '\n');
  }
} catch (err) {
  console.error('sync_bundled_skills warning:', err.message);
}
EOF
}

# Ensure bundled skills are present in Claude's home
COMPAT_SKILLS_SRC=""
[ -d /opt/openrind-shell/skills ] && COMPAT_SKILLS_SRC=/opt/openrind-shell/skills
[ -z "$COMPAT_SKILLS_SRC" ] && [ -d /sandbox/.skills ] && COMPAT_SKILLS_SRC=/sandbox/.skills
if [ -n "$COMPAT_SKILLS_SRC" ]; then
  sync_bundled_skills "$COMPAT_SKILLS_SRC" "$HOME/.claude/skills"
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
