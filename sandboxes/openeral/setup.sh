#!/bin/bash
set -euo pipefail

# setup.sh — Openrind Shell compatibility-runtime one-shot initializer
#
# Called by: openshell sandbox create ... -- openrind-shell-init
# Legacy openeral aliases remain compatibility shims to this script.
#
# OpenShell runs trailing commands over SSH after the sandbox is Ready; they are
# not PID 1. Therefore this script must initialize and exit. Long-running
# runtime state is owned by a detached daemon started lazily by claude/pg.
#
# Steps:
#   1. Resolve uploaded credentials and persist the DB URL outside synced paths
#   2. Run database migrations
#   3. Seed the workspace
#   4. Hydrate scoped Claude/Openrind compatibility state when enabled
#   5. Write session hints/env and an init marker, then exit

# OpenShell's Node HTTP proxy path currently emits an experimental Undici warning
# in some environments. Keep setup output clean and, more importantly, keep
# warning text out of shell-captured values such as the gateway presign URL.
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
export OPENRIND_SHELL_HOME="${OPENRIND_SHELL_HOME:-${OPENERAL_HOME:-/sandbox}}"
export OPENERAL_HOME="$OPENRIND_SHELL_HOME"
export HOME="$OPENERAL_HOME"

OPENERAL_CMD="$(basename "$0")"
OPENERAL_CLI_SUBCOMMAND=0
case "${1:-}" in
  init|memory|stats|analyze|apply|optimize|presign) OPENERAL_CLI_SUBCOMMAND=1 ;;
esac

# Use /opt/openeral directly if accessible, otherwise copy to the sandbox home.
if [ -r /opt/openrind-shell/dist/db/embedded.js ]; then
  OPENERAL_DIR=/opt/openrind-shell
  [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ] || echo "setup: using /opt/openrind-shell directly"
else
  [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ] || echo "setup: copying openeral to writable location..."
  # Use cp instead of tar to avoid permission issues
  mkdir -p "$OPENERAL_HOME/openeral"
  cp -r /opt/openeral/* "$OPENERAL_HOME/openeral/" 2>/dev/null || {
    echo "setup: copy failed, trying with sudo..."
    # If copy fails, try to make /opt/openeral readable
    chmod -R a+rX /opt/openeral 2>/dev/null || true
    cp -r /opt/openeral/* "$OPENERAL_HOME/openeral/"
  }
  OPENERAL_DIR="$OPENERAL_HOME/openeral"
fi

# Workspace ID defaults to sandbox ID (set by OpenShell supervisor). The old
# WORKSPACE_ID name remains an alias so existing sandboxes mount the same data.
export OPENRIND_SHELL_WORKSPACE_ID="${OPENRIND_SHELL_WORKSPACE_ID:-${OPENERAL_WORKSPACE_ID:-${WORKSPACE_ID:-${OPENSHELL_SANDBOX_ID:-default}}}}"
export OPENERAL_WORKSPACE_ID="$OPENRIND_SHELL_WORKSPACE_ID"
export WORKSPACE_ID="$OPENRIND_SHELL_WORKSPACE_ID"

# Fix the PGlite data directory to a stable path so every Node.js process
# in this script uses the same embedded database. Keep runtime state outside
# the sync root so scoped filesystem sync never persists secrets or PGlite files.
export OPENRIND_SHELL_STATE_DIR="${OPENRIND_SHELL_STATE_DIR:-${OPENERAL_STATE_DIR:-/tmp/openrind-shell}}"
export OPENRIND_SHELL_DATA_DIR="${OPENRIND_SHELL_DATA_DIR:-${OPENERAL_DATA_DIR:-$OPENRIND_SHELL_STATE_DIR/data}}"
export OPENRIND_SHELL_DB_URL_FILE="${OPENRIND_SHELL_DB_URL_FILE:-${OPENERAL_DB_URL_FILE:-$OPENRIND_SHELL_STATE_DIR/database-url}}"
export OPENRIND_SHELL_INIT_MARKER="${OPENRIND_SHELL_INIT_MARKER:-${OPENERAL_INIT_MARKER:-$OPENRIND_SHELL_STATE_DIR/init.done}}"
export OPENERAL_STATE_DIR="$OPENRIND_SHELL_STATE_DIR"
export OPENERAL_DATA_DIR="$OPENRIND_SHELL_DATA_DIR"
export OPENERAL_DB_URL_FILE="$OPENRIND_SHELL_DB_URL_FILE"
export OPENERAL_INIT_MARKER="$OPENRIND_SHELL_INIT_MARKER"
mkdir -p "$OPENERAL_STATE_DIR" "$OPENERAL_DATA_DIR"

read_database_url() {
  tr -d '\r' < "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# When invoked inside an already-running sandbox, expose the openeral-js CLI
# through the same command name used as the sandbox entrypoint. Memory refresh
# writes under ~/.claude, so ensure the lazy sync daemon is running first.
if [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ]; then
  if [ "${1:-}" = "memory" ] && command -v openrind-shell-daemon-ensure >/dev/null 2>&1; then
    /usr/local/bin/openrind-shell init --ensure >/dev/null 2>&1
    openrind-shell-daemon-ensure >/dev/null 2>&1
  fi
  exec env HOME="$OPENERAL_HOME" OPENERAL_HOME="$OPENERAL_HOME" \
    OPENERAL_STATE_DIR="$OPENERAL_STATE_DIR" OPENERAL_DATA_DIR="$OPENERAL_DATA_DIR" \
    OPENERAL_DB_URL_FILE="$OPENERAL_DB_URL_FILE" OPENERAL_INIT_MARKER="$OPENERAL_INIT_MARKER" \
    node "$OPENERAL_DIR/dist/bin/openrind-shell.js" "$@"
fi

# If DATABASE_URL is provided (external PostgreSQL), propagate it so
# getDatabaseConnection() picks it up over PGlite.
#
# Resolution order:
#   1. DATABASE_URL / OPENRIND_SHELL_DATABASE_URL / legacy aliases already set
#      in env — use it,
#      unless it's an OpenShell placeholder (which happens when the URL was
#      delivered via `openshell provider create --credential`; the provider
#      framework wraps every credential as a placeholder that only HTTP L7
#      inspection can resolve, and pg cannot use it).
#   2. Uploaded plaintext file at /sandbox/db-url (via `openshell sandbox
#      create --upload /tmp/db-url:/sandbox/db-url`). This is the only
#      documented way to deliver a usable raw-TCP credential into the sandbox.
#      --upload copies the source filename into the target directory, so
#      either `/sandbox/db-url` (file) or `/sandbox/db-url/<name>` (dir) works.
export DATABASE_URL="${DATABASE_URL:-${OPENRIND_SHELL_DATABASE_URL:-${OPENERAL_DATABASE_URL:-${POSTGRES_URL:-}}}}"
case "${DATABASE_URL:-}" in
  ''|openshell:resolve:env:*)
    DB_URL_FILE=""
    if [ -f /sandbox/db-url ]; then
      DB_URL_FILE=/sandbox/db-url
    elif [ -d /sandbox/db-url ]; then
      DB_URL_FILE="$(find /sandbox/db-url -maxdepth 2 -type f -name db-url | head -1)"
      [ -n "$DB_URL_FILE" ] || DB_URL_FILE="$(find /sandbox/db-url -maxdepth 1 -type f | head -1)"
    elif [ -f /sandbox/openrind-shell-input/db-url ]; then
      DB_URL_FILE=/sandbox/openrind-shell-input/db-url
    elif [ -d /sandbox/openrind-shell-input ]; then
      DB_URL_FILE="$(find /sandbox/openrind-shell-input -type f -name db-url | head -1)"
    elif [ -f /sandbox/openeral-input/db-url ]; then
      DB_URL_FILE=/sandbox/openeral-input/db-url
    elif [ -d /sandbox/openeral-input ]; then
      DB_URL_FILE="$(find /sandbox/openeral-input -type f -name db-url | head -1)"
    elif [ -f "$OPENERAL_DB_URL_FILE" ]; then
      DB_URL_FILE="$OPENERAL_DB_URL_FILE"
    fi
    if [ -n "$DB_URL_FILE" ]; then
      DATABASE_URL="$(read_database_url "$DB_URL_FILE")"
      export DATABASE_URL
      echo "setup.sh: loaded DATABASE_URL from uploaded $DB_URL_FILE"
    fi
    ;;
esac

if [ -n "${DATABASE_URL:-}" ]; then
  case "$DATABASE_URL" in
    postgresql://*|postgres://*)
      case "$DATABASE_URL" in
        *@localhost*|*@127.0.0.1*)
          echo "setup.sh: warning: DATABASE_URL uses localhost — this refers to the sandbox container, not the host machine. Connections may fail." >&2
          ;;
      esac
      printf '%s' "$DATABASE_URL" > "$OPENERAL_DB_URL_FILE"
      chmod 600 "$OPENERAL_DB_URL_FILE" 2>/dev/null || true
      ;;
    *)
      echo "setup.sh: error: DATABASE_URL does not look like a valid PostgreSQL URL (got: $DATABASE_URL)." >&2
      echo "setup.sh: error: deliver PostgreSQL credentials via /sandbox/db-url upload, not a generic provider placeholder." >&2
      exit 1
      ;;
  esac
else
  rm -f "$OPENERAL_DB_URL_FILE" 2>/dev/null || true
fi

# Openrind Gateway integration. STRINGCOST_* remains a legacy input alias.
#
# Priority:
#   1. STRINGCOST_PROXY_URL already set → normalize and use it.
#   2. Uploaded presign JSON or URL from an older launch flow → normalize and use it.
#   3. STRINGCOST_PROXY_URL stored in the sandbox home → reuse.
#   4. STRINGCOST_API_KEY + ANTHROPIC_API_KEY present → create a permanent presign.
#      OpenShell resolves provider placeholders in the authorization header and
#      JSON body because the policy opts into request-body credential rewriting.
OPENRIND_GATEWAY_LEGACY=0
if [ -n "${OPENRIND_GATEWAY_API_KEY:-}" ]; then
  export STRINGCOST_API_KEY="$OPENRIND_GATEWAY_API_KEY"
  OPENRIND_GATEWAY_PRESIGN_ENDPOINT=https://app.openrind.com/v1/presign
else
  OPENRIND_GATEWAY_LEGACY=1
  OPENRIND_GATEWAY_PRESIGN_ENDPOINT=https://app.stringcost.com/v1/presign
fi
STRINGCOST_PROXY_URL="${OPENRIND_GATEWAY_PROXY_URL:-${STRINGCOST_PROXY_URL:-}}"
export OPENRIND_GATEWAY_PRESIGN_ENDPOINT
STRINGCOST_PRESIGN_FILE="$OPENERAL_HOME/.openrind-shell/presign.json"
STRINGCOST_LEGACY_PRESIGN_FILE="$OPENERAL_HOME/.openeral/presign.json"

normalize_stringcost_proxy_url() {
  node -e '
const raw = (process.argv[1] || "").trim();
if (!raw) process.exit(0);

try {
  const match = raw.match(/https:\/\/(?:proxy\.openrind\.com\/openrind-gateway-proxy|proxy\.stringcost\.com\/stringcost-proxy)\/t\/[^\s"'\''<>]+/);
  const candidate = match ? match[0] : raw;
  const url = new URL(candidate);
  url.pathname = url.pathname.replace(/\/v1\/.*$/, "");
  url.search = "";
  url.hash = "";
  const normalized = url.toString().replace(/\/$/, "");
  if (!/^https:\/\/(?:proxy\.openrind\.com\/openrind-gateway-proxy|proxy\.stringcost\.com\/stringcost-proxy)\/t\/[^/]+$/.test(normalized)) {
    throw new Error("unexpected Openrind Gateway proxy URL shape");
  }
  process.stdout.write(normalized);
} catch (err) {
  process.stderr.write((err && err.message) || String(err));
  process.exit(1);
}
' "$1"
}

normalize_stringcost_proxy_url_or_warn() {
  local source="$1"
  local raw="$2"
  local err=/tmp/openrind-shell-gateway-normalize.err
  local normalized
  rm -f "$err"
  if normalized="$(normalize_stringcost_proxy_url "$raw" 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$normalized"
    return 0
  fi
  if [ -n "$raw" ]; then
    local detail=""
    [ -s "$err" ] && detail=": $(cat "$err")"
    echo "setup.sh: ignoring invalid Openrind Gateway proxy URL from $source$detail" >&2
  fi
  rm -f "$err"
  return 0
}

if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "STRINGCOST_PROXY_URL" "$STRINGCOST_PROXY_URL")"
  export STRINGCOST_PROXY_URL
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ]; then
  STRINGCOST_UPLOAD_FILE=""
  for candidate in \
    /sandbox/openrind-gateway-presign \
    /sandbox/openrind-gateway-url \
    /sandbox/openrind-shell-input/presign.json \
    /sandbox/openrind-shell-input/openrind-gateway-url \
    /sandbox/stringcost-presign \
    /sandbox/stringcost-url \
    /sandbox/openeral-input/presign.json \
    /sandbox/openeral-input/stringcost-url
  do
    if [ -f "$candidate" ]; then
      STRINGCOST_UPLOAD_FILE="$candidate"
      break
    fi
  done
  if [ -z "$STRINGCOST_UPLOAD_FILE" ] && [ -d /sandbox/openeral-input ]; then
    STRINGCOST_UPLOAD_FILE="$(find /sandbox/openeral-input -type f \( -name presign.json -o -name stringcost-url \) | head -1)"
  fi
  if [ -n "$STRINGCOST_UPLOAD_FILE" ]; then
    STRINGCOST_UPLOADED_URL="$(node -e "
try {
  const raw = require('fs').readFileSync(process.argv[1], 'utf8').trim();
  if (!raw) process.exit(0);
  try {
    const d = JSON.parse(raw);
    process.stdout.write((d && d.url) || '');
  } catch {
    process.stdout.write(raw);
  }
} catch {}
" "$STRINGCOST_UPLOAD_FILE" 2>/dev/null || true)"
    STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "$STRINGCOST_UPLOAD_FILE" "$STRINGCOST_UPLOADED_URL")"
    if [ -n "$STRINGCOST_PROXY_URL" ]; then
      echo "setup.sh: using uploaded Openrind Gateway presign from $STRINGCOST_UPLOAD_FILE"
      mkdir -p "$(dirname "$STRINGCOST_PRESIGN_FILE")"
      node -e "
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
  url: process.argv[2],
  uploaded_at: new Date().toISOString()
}, null, 2), { mode: 0o600 });
" "$STRINGCOST_PRESIGN_FILE" "$STRINGCOST_PROXY_URL"
      chmod 600 "$STRINGCOST_PRESIGN_FILE" 2>/dev/null || true
      export STRINGCOST_PROXY_URL
    fi
  fi
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ ! -f "$STRINGCOST_PRESIGN_FILE" ] && [ -f "$STRINGCOST_LEGACY_PRESIGN_FILE" ]; then
  STRINGCOST_PRESIGN_FILE_READ="$STRINGCOST_LEGACY_PRESIGN_FILE"
else
  STRINGCOST_PRESIGN_FILE_READ="$STRINGCOST_PRESIGN_FILE"
fi
if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -f "$STRINGCOST_PRESIGN_FILE_READ" ]; then
  STRINGCOST_STORED_URL="$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  if (d && d.url) process.stdout.write(d.url);
} catch {}
" "$STRINGCOST_PRESIGN_FILE_READ" 2>/dev/null || true)"
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "$STRINGCOST_PRESIGN_FILE_READ" "$STRINGCOST_STORED_URL")"
  if [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: reusing stored Openrind Gateway presign from $STRINGCOST_PRESIGN_FILE_READ"
    export STRINGCOST_PROXY_URL
  fi
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -n "${STRINGCOST_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "setup.sh: creating a permanent Openrind Gateway presign..."
  mkdir -p "$(dirname "$STRINGCOST_PRESIGN_FILE")"
  STRINGCOST_PRESIGN_ERR=/tmp/openrind-shell-gateway-presign.err
  rm -f "$STRINGCOST_PRESIGN_ERR"
  set +e
  STRINGCOST_FULL_PRESIGN_URL="$(NODE_NO_WARNINGS=1 node -e "
const fetch = globalThis.fetch;
(async () => {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(process.env.OPENRIND_GATEWAY_PRESIGN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRINGCOST_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: process.env.ANTHROPIC_API_KEY,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000,
        metadata: {
          source: 'openrind-shell-sandbox',
          client: 'claude-code',
          labels: ['openrind-shell', 'claude-code'],
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok) {
      const t = await r.text();
      process.stderr.write('presign failed (' + r.status + '): ' + t + '\n');
      process.exit(1);
    }
    const d = await r.json();
    if (!d || !d.url) {
      process.stderr.write('presign returned no URL\n');
      process.exit(1);
    }
    const fs = require('fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({ url: d.url, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(d.url);
  } catch (e) {
    process.stderr.write('presign error: ' + (e && e.message || String(e)) + '\n');
    process.exit(1);
  }
})();
" "$STRINGCOST_PRESIGN_FILE" 2>"$STRINGCOST_PRESIGN_ERR")"
  rc=$?
  if [ $rc -eq 0 ] && [ -n "$STRINGCOST_FULL_PRESIGN_URL" ]; then
    STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_FULL_PRESIGN_URL" 2>"$STRINGCOST_PRESIGN_ERR")"
    rc=$?
  else
    STRINGCOST_PROXY_URL=""
  fi
  set -e
  if [ $rc -eq 0 ] && [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: presign stored at $STRINGCOST_PRESIGN_FILE"
    export STRINGCOST_PROXY_URL
  else
    echo "setup.sh: presign creation failed — continuing without Openrind Gateway" >&2
    if [ -s "$STRINGCOST_PRESIGN_ERR" ]; then
      echo "  detail: $(cat "$STRINGCOST_PRESIGN_ERR")" >&2
    fi
    STRINGCOST_PROXY_URL=""
  fi
  rm -f "$STRINGCOST_PRESIGN_ERR"
fi

# Apply proxy to Claude Code settings if we have one
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  export OPENRIND_GATEWAY_PROXY_URL="$STRINGCOST_PROXY_URL"
  echo "setup.sh: writing Openrind Gateway proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const home = process.env.OPENERAL_HOME || '/sandbox';
const file = home + '/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
delete s.env.ANTHROPIC_API_KEY;
delete s.env.ANTHROPIC_AUTH_TOKEN;
fs.mkdirSync(home + '/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: Openrind Gateway proxy written to ~/.claude/settings.json');
"
fi

# Uploaded inputs can contain credentials. After they have been loaded into the
# entrypoint environment or copied to the managed presign file, remove them.
if [ -n "${DB_URL_FILE:-}" ] && [ "$DB_URL_FILE" != "$OPENERAL_DB_URL_FILE" ]; then
  rm -f "$DB_URL_FILE" 2>/dev/null || true
fi
[ -z "${STRINGCOST_UPLOAD_FILE:-}" ] || rm -f "$STRINGCOST_UPLOAD_FILE" 2>/dev/null || true

echo "setup.sh: running migrations..."
# Log which DB target we're pointing at (redact credentials from the URL)
if [ -n "${DATABASE_URL:-}" ]; then
  DB_HOST="$(node -e "try { const u = new URL(process.env.DATABASE_URL); console.log(u.hostname + ':' + (u.port || '5432')); } catch { console.log('(unparseable)'); }")"
  echo "setup.sh: using external PostgreSQL at $DB_HOST"
else
  echo "setup.sh: using embedded PGlite at $OPENERAL_DATA_DIR"
fi

node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { runMigrations } = await import('$OPENERAL_DIR/dist/db/migrations.js');
    const { pool } = await getDatabaseConnection();
    await runMigrations(pool);
    await pool.end();
    console.log('setup.sh: migrations complete');
  }).catch(err => {
    // Print EVERY piece of info we have — demo users need something to go on
    const msg = err && (err.message || err.toString()) || '(no message)';
    const code = err && err.code ? ' code=' + err.code : '';
    const hint = err && err.code === 'ENOTFOUND' ? '  (DATABASE_URL host is not resolvable from the sandbox — ensure it is a public hostname like Supabase, not a loopback IP)' :
                 err && err.code === 'ECONNREFUSED' ? '  (DATABASE_URL host refused the connection — check port and firewall)' :
                 err && /password/i.test(msg) ? '  (credential rejected — re-check DATABASE_URL)' : '';
    console.error('setup.sh: migration failed:', msg + code);
    if (hint) console.error(hint);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
"

echo "setup.sh: seeding workspace $WORKSPACE_ID..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const ws = await import('$OPENERAL_DIR/dist/db/workspace-queries.js');
    const { pool } = await getDatabaseConnection();

    try {
      await pool.query(
        \"INSERT INTO _openeral.workspace_config (id, display_name, config) VALUES (\\\$1, \\\$2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING\",
        [process.env.WORKSPACE_ID, 'sandbox']
      );
    } catch {}

    // Seed root, .claude dirs, and default security settings
    const defaultSettings = JSON.stringify({
      permissions: {
        allow: [
          \"Bash(npm run *)\",
          \"Bash(npm test *)\",
          \"Bash(git status)\",
          \"Bash(git diff *)\",
          \"Bash(git log *)\",
          \"Bash(git commit *)\",
          \"Bash(ls *)\",
          \"Bash(cat *)\",
          \"Bash(grep *)\"
        ],
        deny: [
          \"Read(~/.ssh/**)\",
          \"Read(~/.aws/**)\",
          \"Read(~/.azure/**)\",
          \"Read(~/.npmrc)\",
          \"Read(~/.git-credentials)\",
          \"Edit(~/.bashrc)\",
          \"Edit(~/.zshrc)\",
          \"Bash(curl *)\",
          \"Bash(wget *)\",
          \"Bash(nc *)\",
          \"Bash(ssh *)\",
          \"Bash(git push *)\",
          \"Read(*.env)\",
          \"Read(.env.*)\"
        ]
      },
      enableAllProjectMcpServers: false
    }, null, 2);

    await ws.seedFromConfig(pool, process.env.WORKSPACE_ID, {
      autoDirs: ['/', '/.claude', '/.claude/projects', '/.openrind-shell', '/.openeral'],
      seedFiles: {
        '/.claude/settings.json': defaultSettings
      },
    });

    await pool.end();
    console.log('setup.sh: workspace seeded');
  }).catch(err => {
    console.error('setup.sh: seed failed:', err.message);
    process.exit(1);
  });
"

if [ -n "${DATABASE_URL:-}" ]; then
  if NODE_NO_WARNINGS=1 node "$OPENERAL_DIR/dist/bin/openrind-shell.js" init --check-marker; then
    echo "setup.sh: init marker is current; skipping PostgreSQL hydration"
  else
    echo "setup.sh: hydrating Claude state from PostgreSQL..."
    node -e "
      import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
        const { syncToFs } = await import('$OPENERAL_DIR/dist/sync.js');
        const { pool } = await getDatabaseConnection();
        const excludeDirs = new Set(['node_modules', '.git', '.cache', '.openrind-shell-memory-backups', '.openeral-memory-backups']);
        let count = 0;
        for (const prefix of [
          { pathPrefix: '/.claude', pathPrefixKind: 'dir' },
          { pathPrefix: '/.openrind-shell', pathPrefixKind: 'dir' },
          { pathPrefix: '/.openeral', pathPrefixKind: 'dir' },
          { pathPrefix: '/.claude.json', pathPrefixKind: 'file' },
        ]) {
          count += await syncToFs(pool, process.env.WORKSPACE_ID, process.env.OPENERAL_HOME || '/sandbox', { ...prefix, excludeDirs });
        }
        await pool.end();
        console.log('setup.sh: hydrated ' + count + ' item(s)');
      }).catch(err => {
        console.error('setup.sh: hydration failed:', err.message);
        process.exit(1);
      });
    "
  fi
fi

if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  # Hydration may restore an older settings file. Reapply the current presign
  # before the init flush writes scoped state back to PostgreSQL.
  echo "setup.sh: reapplying Openrind Gateway proxy after hydration..."
  node -e "
const fs = require('fs');
const home = process.env.OPENERAL_HOME || '/sandbox';
const presign = home + '/.openrind-shell/presign.json';
fs.mkdirSync(home + '/.openrind-shell', {recursive: true});
fs.writeFileSync(presign, JSON.stringify({ url: process.env.STRINGCOST_PROXY_URL, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
const file = home + '/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
delete s.env.ANTHROPIC_API_KEY;
delete s.env.ANTHROPIC_AUTH_TOKEN;
fs.mkdirSync(home + '/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
"
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "setup.sh: persisting initialized Claude state..."
  node -e "
    import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
      const { syncFromFs } = await import('$OPENERAL_DIR/dist/sync.js');
      const { pool } = await getDatabaseConnection();
      const excludeDirs = new Set(['node_modules', '.git', '.cache', '.openrind-shell-memory-backups', '.openeral-memory-backups']);
      let count = 0;
      for (const prefix of [
        { pathPrefix: '/.claude', pathPrefixKind: 'dir' },
        { pathPrefix: '/.openrind-shell', pathPrefixKind: 'dir' },
        { pathPrefix: '/.openeral', pathPrefixKind: 'dir' },
        { pathPrefix: '/.claude.json', pathPrefixKind: 'file' },
      ]) {
        count += await syncFromFs(pool, process.env.WORKSPACE_ID, process.env.OPENERAL_HOME || '/sandbox', { ...prefix, excludeDirs });
      }
      await pool.end();
      console.log('setup.sh: persisted ' + count + ' item(s)');
    }).catch(err => {
      console.error('setup.sh: init persistence failed:', err.message);
      process.exit(1);
    });
  "
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

# Configure Socket.dev registry if SOCKET_TOKEN provider is available.
# Ensure bundled skills are present in Claude's home for compatibility runtime
COMPAT_SKILLS_SRC=""
[ -d /opt/openrind-shell/skills ] && COMPAT_SKILLS_SRC=/opt/openrind-shell/skills
[ -z "$COMPAT_SKILLS_SRC" ] && [ -d /sandbox/.skills ] && COMPAT_SKILLS_SRC=/sandbox/.skills
if [ -n "$COMPAT_SKILLS_SRC" ]; then
  sync_bundled_skills "$COMPAT_SKILLS_SRC" "$OPENERAL_HOME/.claude/skills"
fi
# The token value is a placeholder (openshell:resolve:env:SOCKET_TOKEN) —
# the OpenShell proxy resolves it to the real token in auth headers.
#
# Uses a separate Openrind Shell-managed file, NOT the user's
# ~/.npmrc, to avoid clobbering user config. Passed to npm via NPM_CONFIG_USERCONFIG.
OPENRIND_SHELL_NPMRC=/tmp/openrind-shell-npmrc
rm -f "$OPENRIND_SHELL_NPMRC"
if [ -n "${SOCKET_TOKEN:-}" ]; then
  echo "setup.sh: configuring npm to use Socket.dev registry..."
  cat > "$OPENRIND_SHELL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=${SOCKET_TOKEN}
NPMRC
  export NPM_CONFIG_USERCONFIG="$OPENRIND_SHELL_NPMRC"
fi

shell_quote_value() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

write_export() {
  local name="$1"
  local value="$2"
  printf 'export %s=' "$name"
  shell_quote_value "$value"
  printf '\n'
}

write_session_env() {
  local session_env=/tmp/openrind-shell-session.env
  {
    write_export HOME "$OPENERAL_HOME"
    write_export SHELL "/bin/bash"
    write_export OPENRIND_SHELL_HOME "$OPENERAL_HOME"
    write_export OPENRIND_SHELL_DIR "$OPENERAL_DIR"
    write_export OPENRIND_SHELL_STATE_DIR "$OPENERAL_STATE_DIR"
    write_export OPENRIND_SHELL_DATA_DIR "$OPENERAL_DATA_DIR"
    write_export OPENRIND_SHELL_DB_URL_FILE "$OPENERAL_DB_URL_FILE"
    write_export OPENERAL_HOME "$OPENERAL_HOME"
    write_export OPENERAL_DIR "$OPENERAL_DIR"
    write_export OPENERAL_STATE_DIR "$OPENERAL_STATE_DIR"
    write_export OPENERAL_DATA_DIR "$OPENERAL_DATA_DIR"
    write_export OPENERAL_DB_URL_FILE "$OPENERAL_DB_URL_FILE"
    write_export OPENRIND_SHELL_WORKSPACE_ID "$WORKSPACE_ID"
    write_export OPENERAL_WORKSPACE_ID "$WORKSPACE_ID"
    write_export WORKSPACE_ID "$WORKSPACE_ID"
    write_export NODE_NO_WARNINGS "$NODE_NO_WARNINGS"
    [ -z "${NPM_CONFIG_USERCONFIG:-}" ] || write_export NPM_CONFIG_USERCONFIG "$NPM_CONFIG_USERCONFIG"
    # Provider credentials are injected into each OpenShell SSH/exec process.
    # Never copy either raw credentials or their placeholders into a file.
    [ -z "${ANTHROPIC_BASE_URL:-}" ] || write_export ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
    [ -z "${STRINGCOST_PROXY_URL:-}" ] || write_export ANTHROPIC_BASE_URL "$STRINGCOST_PROXY_URL"
  } > "$session_env"
  chmod 600 "$session_env" 2>/dev/null || true
  ln -sf "$session_env" /tmp/openeral-session.env
}

write_shell_hint() {
  local snippet='
# Openrind Shell session environment.
[ -f /tmp/openrind-shell-session.env ] && . /tmp/openrind-shell-session.env
case "$-" in
  *i*)
    if [ -z "${OPENRIND_SHELL_HINT_SHOWN:-}" ]; then
      export OPENRIND_SHELL_HINT_SHOWN=1
      echo "Openrind Shell ready. Run '\''claude'\'' to start Claude Code; use /exit or Ctrl-D to return here; run '\''claude -c'\'' to continue."
    fi
    ;;
esac
'
  for profile in "$OPENERAL_HOME/.bashrc"; do
    touch "$profile" 2>/dev/null || continue
    if ! grep -q 'Openrind Shell session environment' "$profile" 2>/dev/null; then
      printf '%s\n' "$snippet" >> "$profile" 2>/dev/null || true
    fi
  done
}

write_session_env
write_shell_hint

# The OpenShell base image installs Claude Code. Openrind Shell renames it to
# claude-real at image build time and exposes its persistence-aware wrapper as
# claude. Installing packages during sandbox startup is intentionally forbidden.
if ! command -v claude-real >/dev/null 2>&1; then
  echo "setup.sh: ERROR: /usr/local/bin/claude-real is missing from the sandbox image" >&2
  exit 1
fi

node "$OPENERAL_DIR/dist/bin/openrind-shell.js" init --write-marker
chmod 600 "$OPENERAL_INIT_MARKER" 2>/dev/null || true

echo ""
echo "Openrind Shell initialized for workspace: $WORKSPACE_ID"
echo "Connect with: openshell sandbox connect ${OPENSHELL_SANDBOX_ID:-<name>}"
echo "Inside the sandbox: run 'claude' to start, '/exit' or Ctrl-D to stop, and 'claude -c' to continue."
echo ""
exit 0
