#!/bin/bash
set -euo pipefail

# setup.sh — Openrind Shell sandbox entry point
#
# Called by: openshell sandbox create ... -- openrind-shell [--shell]
# (or, equivalently, -- /opt/openrind-shell/setup.sh — the `openrind-shell` name is a
# /usr/local/bin shim installed in the Dockerfile.)
#
# Steps:
#   1. Run database migrations
#   2. Seed the workspace
#   3. Start openrind-shell-bash daemon
#   4. Exec the selected agent (Claude Code or OpenClaw), or drop to bash (--shell)

# OpenShell's Node HTTP proxy path currently emits an experimental Undici warning
# in some environments. Keep setup output clean and, more importantly, keep
# warning text out of shell-captured values such as the OpenrindGateway presign URL.
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"

# ── Clean-terminal log redirect ──────────────────────────────────────────────
# The desktop app connects its interactive terminal via `exec openrind-shell`,
# which runs THIS script. Its informational bootstrap chatter ("running
# migrations", "restored N entries", "daemon ready", …) would otherwise scroll
# ABOVE the agent TUI. Send stdout to a log file so the terminal only ever shows
# the agent, and restore the real terminal (saved on fd 3) right before exec'ing
# the agent (see the tty-restore lines just before each agent launch below).
#   - stderr is deliberately LEFT on the terminal, so genuine failures (e.g. an
#     unreachable DATABASE_URL) are still visible to the user.
#   - Skipped in setup-only mode (OPENRIND_SHELL_SETUP_ONLY=1 — the desktop
#     loading-screen prewarm), where the caller already redirects the whole run
#     to a log and tails it for on-screen progress.
SETUP_LOG="${OPENRIND_SHELL_SETUP_LOG:-/tmp/openrind-shell-setup.log}"
if [ -z "${OPENRIND_SHELL_SETUP_ONLY:-}" ]; then
  exec 3>&1
  exec >>"$SETUP_LOG"
fi

# Use /opt/openrind-shell directly if accessible, otherwise copy to /home/agent
if [ -r /opt/openrind-shell/dist/db/embedded.js ]; then
  OPENRIND_SHELL_DIR=/opt/openrind-shell
  echo "setup: using /opt/openrind-shell directly"
else
  echo "setup: copying openrind-shell to writable location..."
  # Use cp instead of tar to avoid permission issues
  mkdir -p /home/agent/openrind-shell
  cp -r /opt/openrind-shell/* /home/agent/openrind-shell/ 2>/dev/null || {
    echo "setup: copy failed, trying with sudo..."
    # If copy fails, try to make /opt/openrind-shell readable
    chmod -R a+rX /opt/openrind-shell 2>/dev/null || true
    cp -r /opt/openrind-shell/* /home/agent/openrind-shell/
  }
  OPENRIND_SHELL_DIR=/home/agent/openrind-shell
fi

# ── Clean-render PTY bridge ────────────────────────────────────────────────────
# Launch the agent through openrind-pty-bridge.py, which owns the real Linux PTY
# the agent renders to and streams its raw bytes to the caller. This keeps the
# Windows ConPTY out of the byte path — the ConPTY re-render was what corrupted
# the TUI (gibberish line over the banner, too-narrow box, misplaced composer).
#
# `openshell sandbox connect` cannot carry env/args into the container, and the
# desktop terminal AND the pop-out OS-terminal launcher run the SAME connect
# command — so we cannot gate the bridge on an env var. Instead the bridge is
# ALWAYS used and auto-detects its mode from the first bytes on stdin: Openrind
# Desktop sends a handshake (framed transport); an external terminal doesn't, so
# the bridge falls back to a transparent raw passthrough. Either way it's a
# clean, ConPTY-free Linux PTY for the agent.
#
# Fall back to a direct exec if python3 or the bridge is missing (older image) —
# the session still launches, just without the clean-render fix.
OPENRIND_PTY_BRIDGE="$OPENRIND_SHELL_DIR/openrind-pty-bridge.py"
openrind_pty_exec() {
  if command -v python3 >/dev/null 2>&1 && [ -f "$OPENRIND_PTY_BRIDGE" ]; then
    exec python3 "$OPENRIND_PTY_BRIDGE" "$@"
  fi
  exec "$@"
}

# Workspace ID defaults to sandbox ID (set by OpenShell supervisor)
export WORKSPACE_ID="${OPENSHELL_SANDBOX_ID:-default}"

# Capture the sandbox user's real HOME before we override it when launching agents.
# `openshell sandbox connect` gives a shell with this HOME (typically /sandbox),
# not /home/agent. We write a .bashrc there so reconnect sessions automatically
# set HOME=/home/agent and export OpenrindGateway env vars.
SANDBOX_USER_HOME="${HOME:-/sandbox}"

# Agent kind — injected by the `openclaw` generic provider as OPENRIND_SHELL_AGENT=openclaw.
# OpenShell wraps ALL generic provider credentials as openshell:resolve:env:* placeholders,
# so OPENRIND_SHELL_AGENT may arrive as a placeholder string rather than the literal "openclaw".
# Since OPENRIND_SHELL_AGENT is only ever set by the openclaw provider, any non-empty value
# (literal or placeholder) means openclaw is active.
case "${OPENRIND_SHELL_AGENT:-}" in
  openclaw|openshell:resolve:env:*)
    export OPENRIND_SHELL_AGENT="openclaw"
    ;;
  *)
    export OPENRIND_SHELL_AGENT="claude"
    ;;
esac

# OpenClaw's runtime npm-via-git installs reference git+ssh://git@github.com/…
# URLs (e.g. whiskeysockets/libsignal-node). The OpenShell sandbox policy only
# permits github.com:443 (HTTPS) for /usr/bin/git — port 22 (SSH) is blocked
# at the network layer and surfaces as "Temporary failure in name resolution"
# from npm/git. Configure git to rewrite the ssh forms to https so the existing
# github_ssh_over_https policy stanza handles the traffic.
#
# IMPORTANT: Use HOME=/home/agent explicitly — all OpenClaw plugin staging and
# TUI operations run with HOME=/home/agent. Writing to the default $HOME
# (the container initial HOME, typically /sandbox) means the rewrites land in
# the wrong .gitconfig file and are invisible to npm/git when they install
# plugin deps, causing a ~10 min hang on every "hi" (SSH port 22 blocked).
# We also re-apply these after syncToFs so a workspace-restored .gitconfig
# cannot overwrite our additions (see the block after the restore step below).
#
# CRITICAL: use --add. Without it, the three calls collapse onto a single
# single-value key and only the LAST rewrite (git+ssh://) survives — the
# ssh:// rewrite that npm-via-git actually needs gets silently dropped, and
# every plugin install retries SSH:22 (blocked) for ~30 min before failing.
if [ "${OPENRIND_SHELL_AGENT}" = "openclaw" ]; then
  mkdir -p /home/agent
  HOME=/home/agent git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
  # After the rewrite, git tunnels through OpenShell's TLS-terminating proxy
  # which presents a self-signed CA cert git does not trust ("server certificate
  # verification failed. CAfile: none"). The sandbox network policy already
  # gates which hosts are reachable, so leaving verify on adds no protection
  # but blocks every plugin install.
  HOME=/home/agent git config --global http.sslVerify false 2>/dev/null || true
fi

# OpenrindGateway API host. Defaults to the hosted service; override with
# OPENRIND_GATEWAY_API_BASE=http://<host-ip>:8080 (or similar) to point at a
# self-hosted control plane during local end-to-end testing.
export OPENRIND_GATEWAY_API_BASE="${OPENRIND_GATEWAY_API_BASE:-https://app.openrind.com}"

# DATABASE_URL is REQUIRED. Resolution order:
#   1. DATABASE_URL / OPENRIND_SHELL_DATABASE_URL / POSTGRES_URL already set in env — use it,
#      unless it's an OpenShell placeholder (which happens when the URL was
#      delivered via `openshell provider create --credential`; the provider
#      framework wraps every credential as a placeholder that only HTTP L7
#      inspection can resolve, and pg cannot use it).
#   2. Uploaded plaintext file at /sandbox/db-url (via `openshell sandbox
#      create --upload /tmp/db-url:/sandbox/db-url`). This is the only
#      documented way to deliver a usable raw-TCP credential into the sandbox.
#      --upload copies the source filename into the target directory, so
#      either `/sandbox/db-url` (file) or `/sandbox/db-url/<name>` (dir) works.
export DATABASE_URL="${DATABASE_URL:-${OPENRIND_SHELL_DATABASE_URL:-${POSTGRES_URL:-}}}"
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
    fi
    if [ -n "$DB_URL_FILE" ]; then
      # Trim leading/trailing whitespace and CR (Windows line endings) — defensive
      # against `echo "$URL" > file` adding a trailing newline that Postgres rejects.
      DATABASE_URL="$(tr -d '\r' < "$DB_URL_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      export DATABASE_URL
      echo "setup.sh: loaded DATABASE_URL from uploaded $DB_URL_FILE"
    fi
    ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  echo "setup.sh: error: DATABASE_URL is required." >&2
  echo "setup.sh:   Upload your PostgreSQL connection string when creating the sandbox:" >&2
  echo "setup.sh:     echo \"\$DATABASE_URL\" > /tmp/db-url" >&2
  echo "setup.sh:     openshell sandbox create --upload /tmp/db-url:/sandbox/db-url ..." >&2
  echo "setup.sh:   Or place it at /sandbox/openrind-shell-input/db-url alongside the API key." >&2
  echo "setup.sh:   See README.md for the full command." >&2
  exit 1
fi

# ANTHROPIC_API_KEY file-based delivery for OpenClaw.
# OpenShell provider credentials arrive as openshell:resolve:env:* placeholders
# that the HTTP proxy resolves only for Claude Code's binary. OpenClaw's embedded
# gateway is a separate Node process; passing the placeholder to it causes
# Anthropic to reject every API call. Read the real key from an uploaded file
# instead so the literal value is exported into ANTHROPIC_API_KEY before exec'ing openclaw.
case "${ANTHROPIC_API_KEY:-}" in
  ''|openshell:resolve:env:*)
    ANTHROPIC_KEY_FILE=""
    if [ -f /sandbox/anthropic-api-key ]; then
      ANTHROPIC_KEY_FILE=/sandbox/anthropic-api-key
    elif [ -d /sandbox/anthropic-api-key ]; then
      # openshell --upload always places files INSIDE the destination directory
      # (e.g. --upload /tmp/my-key:/sandbox/anthropic-api-key puts the file at
      # /sandbox/anthropic-api-key/my-key). Pick any single file inside.
      ANTHROPIC_KEY_FILE="$(find /sandbox/anthropic-api-key -maxdepth 1 -type f | head -1)"
    elif [ -f /sandbox/openrind-shell-input/anthropic-api-key ]; then
      ANTHROPIC_KEY_FILE=/sandbox/openrind-shell-input/anthropic-api-key
    fi
    if [ -n "$ANTHROPIC_KEY_FILE" ]; then
      # Trim leading/trailing whitespace and CR (Windows line endings) — defensive
      # against `echo "$KEY" > file` adding a trailing newline. A key with a stray
      # newline is sent literally to Anthropic, which rejects it with 401; openclaw
      # then surfaces this as a generic "run aborted / timeout" in the TUI.
      ANTHROPIC_API_KEY="$(tr -d '\r' < "$ANTHROPIC_KEY_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      export ANTHROPIC_API_KEY
      echo "setup.sh: loaded ANTHROPIC_API_KEY from uploaded $ANTHROPIC_KEY_FILE"
    fi
    ;;
esac

# OpenrindGateway integration — both agents (Claude Code AND OpenClaw).
# Each agent gets its own presign with a distinct metadata.labels entry so the
# OpenrindGateway vendor portfolio can attribute token spend, COGS, and revenue to
# the right agent. Both agents read ANTHROPIC_BASE_URL at startup and route
# their /v1/messages calls through the OpenrindGateway proxy.

# Priority:
#   1. OPENRIND_GATEWAY_PROXY_URL already set → normalize and use it.
#   2. Uploaded presign JSON or URL under /sandbox/openrind-shell-input → normalize and use it.
#   3. OPENRIND_GATEWAY_PROXY_URL stored from previous session → reuse.
#   4. OPENRIND_GATEWAY_API_KEY + raw ANTHROPIC_API_KEY present → create a new permanent presign
#      (expires_in=-1, max_uses=-1, cost_limit=$10), store in workspace, reuse on next launch.
#
OPENRIND_GATEWAY_PRESIGN_FILE=/home/agent/.openrind-shell/presign.json

normalize_openrind_gateway_proxy_url() {
  node -e '
const raw = (process.argv[1] || "").trim();
if (!raw) process.exit(0);

try {
  // Accept the hosted shape (https://proxy.openrind.com/openrind-gateway-proxy/t/...)
  // and any self-hosted shape (http(s)://<any-host>/openrind-gateway-proxy/t/...).
  const match = raw.match(/https?:\/\/[^\s"'\''<>]+\/openrind-gateway-proxy\/t\/[^\s"'\''<>]+/);
  const candidate = match ? match[0] : raw;
  const url = new URL(candidate);
  url.pathname = url.pathname.replace(/\/v1\/.*$/, "");
  url.search = "";
  url.hash = "";
  const normalized = url.toString().replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+\/openrind-gateway-proxy\/t\/[^/]+$/.test(normalized)) {
    throw new Error("unexpected OpenrindGateway proxy URL shape");
  }
  process.stdout.write(normalized);
} catch (err) {
  process.stderr.write((err && err.message) || String(err));
  process.exit(1);
}
' "$1"
}

if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ]; then
  OPENRIND_GATEWAY_PROXY_URL="$(normalize_openrind_gateway_proxy_url "$OPENRIND_GATEWAY_PROXY_URL" 2>/dev/null || true)"
  export OPENRIND_GATEWAY_PROXY_URL
fi

if [ -z "${OPENRIND_GATEWAY_PROXY_URL:-}" ]; then
  OPENRIND_GATEWAY_UPLOAD_FILE=""
  for candidate in \
    /sandbox/openrind-gateway-presign \
    /sandbox/openrind-gateway-url \
    /sandbox/openrind-shell-input/presign.json \
    /sandbox/openrind-shell-input/openrind-gateway-url
  do
    if [ -f "$candidate" ]; then
      OPENRIND_GATEWAY_UPLOAD_FILE="$candidate"
      break
    fi
  done
  if [ -z "$OPENRIND_GATEWAY_UPLOAD_FILE" ] && [ -d /sandbox/openrind-shell-input ]; then
    OPENRIND_GATEWAY_UPLOAD_FILE="$(find /sandbox/openrind-shell-input -type f \( -name presign.json -o -name openrind-gateway-url \) | head -1)"
  fi
  if [ -n "$OPENRIND_GATEWAY_UPLOAD_FILE" ]; then
    OPENRIND_GATEWAY_UPLOADED_URL="$(node -e "
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
" "$OPENRIND_GATEWAY_UPLOAD_FILE" 2>/dev/null || true)"
    OPENRIND_GATEWAY_PROXY_URL="$(normalize_openrind_gateway_proxy_url "$OPENRIND_GATEWAY_UPLOADED_URL" 2>/dev/null || true)"
    if [ -n "$OPENRIND_GATEWAY_PROXY_URL" ]; then
      echo "setup.sh: using uploaded OpenrindGateway presign from $OPENRIND_GATEWAY_UPLOAD_FILE"
      export OPENRIND_GATEWAY_PROXY_URL
    fi
  fi
fi

if [ -z "${OPENRIND_GATEWAY_PROXY_URL:-}" ] && [ -f "$OPENRIND_GATEWAY_PRESIGN_FILE" ]; then
  OPENRIND_GATEWAY_STORED_URL="$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  if (d && d.url) process.stdout.write(d.url);
} catch {}
" "$OPENRIND_GATEWAY_PRESIGN_FILE" 2>/dev/null || true)"
  OPENRIND_GATEWAY_PROXY_URL="$(normalize_openrind_gateway_proxy_url "$OPENRIND_GATEWAY_STORED_URL" 2>/dev/null || true)"
  if [ -n "$OPENRIND_GATEWAY_PROXY_URL" ]; then
    echo "setup.sh: reusing stored OpenrindGateway presign from $OPENRIND_GATEWAY_PRESIGN_FILE"
    export OPENRIND_GATEWAY_PROXY_URL
  fi
fi

if [ -z "${OPENRIND_GATEWAY_PROXY_URL:-}" ] && [ -n "${OPENRIND_GATEWAY_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  case "${ANTHROPIC_API_KEY:-}" in
    openshell:resolve:env:*)
      echo "setup.sh: skipping OpenrindGateway presign creation because ANTHROPIC_API_KEY is an OpenShell placeholder; upload a host-created presign.json to /sandbox/openrind-shell-input instead" >&2
      ;;
    *)
  echo "setup.sh: creating a permanent OpenrindGateway presign for $OPENRIND_SHELL_AGENT..."
  mkdir -p "$(dirname "$OPENRIND_GATEWAY_PRESIGN_FILE")"
  OPENRIND_GATEWAY_PRESIGN_ERR=/tmp/openrind-shell-openrind-gateway-presign.err
  rm -f "$OPENRIND_GATEWAY_PRESIGN_ERR"
  set +e
  OPENRIND_GATEWAY_FULL_PRESIGN_URL="$(NODE_NO_WARNINGS=1 node -e "
const fetch = globalThis.fetch;
(async () => {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 30000);
  try {
    const apiBase = (process.env.OPENRIND_GATEWAY_API_BASE || 'https://app.openrind.com').replace(/\/+$/, '');
    const agent = process.env.OPENRIND_SHELL_AGENT === 'openclaw' ? 'openclaw' : 'claude-code';
    const r = await fetch(apiBase + '/v1/presign', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENRIND_GATEWAY_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: process.env.ANTHROPIC_API_KEY,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000,
        // metadata.labels is what OpenrindGateway's vendor portfolio classifier
        // reads. 'tags' on the request body is NOT a presign-schema field
        // and would be silently dropped.
        metadata: {
          source: 'openrind-shell-sandbox',
          client: agent,
          labels: ['openrind-shell', agent],
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
" "$OPENRIND_GATEWAY_PRESIGN_FILE" 2>"$OPENRIND_GATEWAY_PRESIGN_ERR")"
  rc=$?
  if [ $rc -eq 0 ] && [ -n "$OPENRIND_GATEWAY_FULL_PRESIGN_URL" ]; then
    OPENRIND_GATEWAY_PROXY_URL="$(normalize_openrind_gateway_proxy_url "$OPENRIND_GATEWAY_FULL_PRESIGN_URL" 2>"$OPENRIND_GATEWAY_PRESIGN_ERR")"
    rc=$?
  else
    OPENRIND_GATEWAY_PROXY_URL=""
  fi
  set -e
  if [ $rc -eq 0 ] && [ -n "$OPENRIND_GATEWAY_PROXY_URL" ]; then
    echo "setup.sh: presign stored at $OPENRIND_GATEWAY_PRESIGN_FILE"
    export OPENRIND_GATEWAY_PROXY_URL
  else
    echo "setup.sh: presign creation failed — continuing without OpenrindGateway" >&2
    if [ -s "$OPENRIND_GATEWAY_PRESIGN_ERR" ]; then
      echo "  detail: $(cat "$OPENRIND_GATEWAY_PRESIGN_ERR")" >&2
    fi
    OPENRIND_GATEWAY_PROXY_URL=""
  fi
  rm -f "$OPENRIND_GATEWAY_PRESIGN_ERR"
      ;;
  esac
fi

# Export ANTHROPIC_BASE_URL once the proxy URL is resolved so every downstream
# child process inherits it: the openclaw gateway started via `setsid env ...`,
# the openclaw / claude exec at the end of this script, and any node -e blocks
# that read process.env.ANTHROPIC_BASE_URL while writing config files.
# Claude Code ALSO has it explicitly passed in its exec; OpenClaw needs it set
# in the parent shell because its gateway is launched as a background process
# that inherits this env.
if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ]; then
  export ANTHROPIC_BASE_URL="$OPENRIND_GATEWAY_PROXY_URL"
fi

# Apply proxy to Claude Code settings if we have one. OpenClaw has no
# ~/.claude/settings.json — it picks up ANTHROPIC_BASE_URL from the env at
# launch (see the OpenClaw exec block further down).
#
# ANTHROPIC_AUTH_TOKEN is set to a dummy value so Claude Code does not prompt
# for re-authentication when ANTHROPIC_API_KEY is absent (e.g. on reconnect).
# OpenrindGateway authenticates via the presign token embedded in ANTHROPIC_BASE_URL,
# not via the Bearer token Claude sends, so any non-empty value works here.
if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ] && [ "$OPENRIND_SHELL_AGENT" != "openclaw" ]; then
  echo "setup.sh: writing OpenrindGateway proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.OPENRIND_GATEWAY_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
delete s.env.ANTHROPIC_API_KEY;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: OpenrindGateway proxy written to ~/.claude/settings.json');
"
fi

echo "setup.sh: running migrations, seeding, and restoring workspace..."

# Migrations, the workspace seed, and the /home/agent restore all share ONE
# database connection in ONE Node process. Each previously ran in its own
# `node -e`, and because the sandbox can only reach PostgreSQL through the HTTP
# CONNECT tunnel, every one of those processes paid a full cold handshake
# (proxy TCP + CONNECT + TLS + SCRAM auth) — three times over. That per-connection
# handshake to a remote database is what made the "connecting to the database"
# step slow. One shared pool means the handshake happens ONCE instead of three
# times (and one Node startup instead of three). OPENRIND_SHELL_DIR, WORKSPACE_ID,
# OPENRIND_SHELL_AGENT, and DATABASE_URL are read from the environment via a quoted
# heredoc, so the SQL's $1/$2 placeholders survive verbatim (no shell interpolation).
export OPENRIND_SHELL_DIR
OPENRIND_SHELL_DB_BOOTSTRAP=/tmp/openrind-shell-db-bootstrap.mjs
cat > "$OPENRIND_SHELL_DB_BOOTSTRAP" <<'OPENRIND_SHELL_DB_BOOTSTRAP_EOF'
const dir = process.env.OPENRIND_SHELL_DIR;
const workspaceId = process.env.WORKSPACE_ID;

// Log the DB target (redacted) before connecting so a slow/hung connect still
// shows where it was pointed.
try {
  const u = new URL(process.env.DATABASE_URL);
  console.log('setup.sh: using external PostgreSQL at ' + u.hostname + ':' + (u.port || '5432'));
} catch {
  console.log('setup.sh: using external PostgreSQL at (unparseable)');
}

const { getDatabaseConnection } = await import(dir + '/dist/db/embedded.js');
const { runMigrations } = await import(dir + '/dist/db/migrations.js');
const ws = await import(dir + '/dist/db/workspace-queries.js');
const { syncToFs, createHomeSyncOptions } = await import(dir + '/dist/sync.js');

let pool;
try {
  ({ pool } = await getDatabaseConnection());
} catch (err) {
  // A bad/unreachable DATABASE_URL is the #1 failure — print every hint we have.
  const msg = (err && (err.message || err.toString())) || '(no message)';
  const code = err && err.code ? ' code=' + err.code : '';
  const hint = err && err.code === 'ENOTFOUND'
      ? '  (DATABASE_URL host is not resolvable from the sandbox — ensure it is a public hostname like Supabase, not a loopback IP)'
    : err && err.code === 'ECONNREFUSED'
      ? '  (DATABASE_URL host refused the connection — check port and firewall)'
    : err && /password/i.test(msg)
      ? '  (credential rejected — re-check DATABASE_URL)'
      : '';
  console.error('setup.sh: database connection failed:', msg + code);
  if (hint) console.error(hint);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
}

try {
  await runMigrations(pool);
  console.log('setup.sh: migrations complete');

  try {
    await pool.query(
      "INSERT INTO _openrind.workspace_config (id, display_name, config) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING",
      [workspaceId, 'sandbox'],
    );
  } catch {}

  // Seed root, agent config dirs, and default security settings.
  const defaultSettings = JSON.stringify({
    permissions: {
      allow: [
        'Bash(npm run *)',
        'Bash(npm test *)',
        'Bash(git status)',
        'Bash(git diff *)',
        'Bash(git log *)',
        'Bash(git commit *)',
        'Bash(ls *)',
        'Bash(cat *)',
        'Bash(grep *)',
      ],
      deny: [
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(~/.azure/**)',
        'Read(~/.npmrc)',
        'Read(~/.git-credentials)',
        'Edit(~/.bashrc)',
        'Edit(~/.zshrc)',
        'Bash(curl *)',
        'Bash(wget *)',
        'Bash(nc *)',
        'Bash(ssh *)',
        'Bash(git push *)',
        'Read(*.env)',
        'Read(.env.*)',
      ],
    },
    enableAllProjectMcpServers: false,
  }, null, 2);

  const agentKind = process.env.OPENRIND_SHELL_AGENT || 'claude';
  const autoDirs = agentKind === 'openclaw'
    ? ['/', '/.config', '/.openclaw']
    : ['/', '/.claude', '/.claude/projects'];
  const seedFiles = agentKind === 'openclaw'
    ? {}
    : { '/.claude/settings.json': defaultSettings };

  await ws.seedFromConfig(pool, workspaceId, { autoDirs, seedFiles });
  console.log('setup.sh: workspace seeded');

  const count = await syncToFs(pool, workspaceId, '/home/agent', createHomeSyncOptions({ prune: false }));
  console.log('setup.sh: restored ' + count + ' workspace entr' + (count === 1 ? 'y' : 'ies'));
} catch (err) {
  console.error('setup.sh: database bootstrap failed:', (err && err.message) || err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
OPENRIND_SHELL_DB_BOOTSTRAP_EOF

node "$OPENRIND_SHELL_DB_BOOTSTRAP" || { rm -f "$OPENRIND_SHELL_DB_BOOTSTRAP"; exit 1; }
rm -f "$OPENRIND_SHELL_DB_BOOTSTRAP"

# Re-apply git URL rewrites after the workspace restore. syncToFs is authoritative
# and may overwrite /home/agent/.gitconfig with an older version that lacks the
# ssh-to-https rewrites. Writing them again here guarantees the pre-stage
# (openclaw status --deep) and every subsequent npm/git operation finds them.
# --unset-all + --add (see top-of-file block) keeps all three rewrites alive.
if [ "${OPENRIND_SHELL_AGENT}" = "openclaw" ]; then
  HOME=/home/agent git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global http.sslVerify false 2>/dev/null || true
fi

# Re-apply runtime settings after the restore step. syncToFs intentionally makes
# PostgreSQL authoritative, so freshly generated settings must be written after it.
if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ] && [ "$OPENRIND_SHELL_AGENT" != "openclaw" ]; then
  echo "setup.sh: writing OpenrindGateway proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.OPENRIND_GATEWAY_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
delete s.env.ANTHROPIC_API_KEY;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: OpenrindGateway proxy written to ~/.claude/settings.json');
"
fi

# Persist ANTHROPIC_BASE_URL to the shell environment so reconnect sessions
# (openshell sandbox connect) also route through OpenrindGateway even if
# ~/.claude/settings.json is reset by `claude init` or similar.
if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ]; then
  mkdir -p /home/agent/.openrind-shell
  printf 'export ANTHROPIC_BASE_URL="%s"\nexport ANTHROPIC_AUTH_TOKEN="dummy"\nunset ANTHROPIC_API_KEY\n' \
    "$OPENRIND_GATEWAY_PROXY_URL" > /home/agent/.openrind-shell/env.sh
  BASHRC=/home/agent/.bashrc
  if ! grep -q 'openrind-shell/env.sh' "$BASHRC" 2>/dev/null; then
    printf '\n[ -f ~/.openrind-shell/env.sh ] && . ~/.openrind-shell/env.sh\n' >> "$BASHRC"
  fi
fi

# openshell sandbox connect gives a shell with HOME=$SANDBOX_USER_HOME (e.g. /sandbox),
# not /home/agent. Always patch that shell's .bashrc so reconnect sessions use
# the correct HOME — without this openclaw cannot find its config or gateway
# auth token regardless of whether OpenrindGateway is active.
# Best-effort only (|| true): if HOME points somewhere unwritable (e.g. /root
# when invoked via a bare `docker exec` without the app's env), a failed
# .bashrc append must not abort the whole setup under `set -e`.
if [ "$SANDBOX_USER_HOME" != "/home/agent" ] && [ -n "$SANDBOX_USER_HOME" ] && [ -w "$SANDBOX_USER_HOME" ]; then
  CONNECT_BASHRC="$SANDBOX_USER_HOME/.bashrc"
  if ! grep -q 'openrind-shell-connect' "$CONNECT_BASHRC" 2>/dev/null; then
    printf '\n# openrind-shell-connect: set agent HOME for sandbox connect sessions\nexport HOME=/home/agent\n[ -f /home/agent/.openrind-shell/env.sh ] && . /home/agent/.openrind-shell/env.sh\n' \
      >> "$CONNECT_BASHRC" || true
  fi
  # Apply the same openclaw runtime env to reconnect sessions so manual
  # `openclaw` invocations don't re-pay startup overhead or hit TLS-verify
  # failures during plugin staging.
  if ! grep -q 'openrind-shell-openclaw-env' "$CONNECT_BASHRC" 2>/dev/null; then
    printf '\n# openrind-shell-openclaw-env: runtime env for manual openclaw invocations\nexport OPENCLAW_NO_RESPAWN=1\nexport NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache\nexport GIT_SSL_NO_VERIFY=true\nexport npm_config_strict_ssl=false\n' \
      >> "$CONNECT_BASHRC" || true
  fi
fi

echo "setup.sh: flushing /home/agent to workspace..."
node -e "
  import('$OPENRIND_SHELL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { syncFromFs, createHomeSyncOptions } = await import('$OPENRIND_SHELL_DIR/dist/sync.js');
    const { pool } = await getDatabaseConnection();
    const count = await syncFromFs(pool, process.env.WORKSPACE_ID, '/home/agent', createHomeSyncOptions());
    await pool.end();
    console.log('setup.sh: flushed ' + count + ' workspace entr' + (count === 1 ? 'y' : 'ies'));
  }).catch(err => {
    console.error('setup.sh: flush failed:', err.message);
    process.exit(1);
  });
"

# Configure Socket.dev registry if SOCKET_TOKEN provider is available.
# The token value is a placeholder (openshell:resolve:env:SOCKET_TOKEN) —
# the OpenShell proxy resolves it to the real token in auth headers.
#
# Uses a separate openrind-shell-managed file (/tmp/openrind-shell-npmrc), NOT the user's
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

echo "setup.sh: starting openrind-shell-bash daemon..."
# The daemon is a long-lived background process that OUTLIVES this script (it
# keeps syncing the workspace during the whole agent session). It inherits the
# terminal on stderr at fork time, so without this redirect its diagnostics
# would paint over the agent's TUI. Send its output to a dedicated log — the
# clean-terminal redirect near the top only covers THIS shell's stdout, not a
# child that already captured the tty on fd 2.
node "$OPENRIND_SHELL_DIR/openrind-shell-bash.mjs" --daemon \
  >>"${OPENRIND_SHELL_DAEMON_LOG:-/tmp/openrind-shell-bash.log}" 2>&1 &
DAEMON_PID=$!

# Wait for socket to appear
_d=0
while [ $_d -lt 300 ]; do
  [ -S /tmp/openrind-shell-bash.sock ] && break
  [ $_d -eq 50 ] && echo "setup.sh: waiting for daemon to initialize..." >&2
  sleep 0.1
  _d=$((_d+1))
done

if [ -S /tmp/openrind-shell-bash.sock ]; then
  echo "setup.sh: daemon ready (pid $DAEMON_PID)"
  # Clean up daemon on exit
  trap "kill $DAEMON_PID 2>/dev/null; rm -f /tmp/openrind-shell-bash.sock" EXIT
else
  echo "setup.sh: warning: daemon not ready after 30s — using standalone mode" >&2
  unset DAEMON_PID
  trap "rm -f /tmp/openrind-shell-bash.sock" EXIT
fi

if [ "$OPENRIND_SHELL_AGENT" = "openclaw" ]; then
  # ── OpenClaw: user-driven, interactive onboarding ────────────────────────
  # setup.sh used to onboard OpenClaw NON-interactively here: it wrote a
  # hardcoded auth-profiles.json (plus a fallback profile), pre-filled
  # openclaw.json with credentials + a custom provider, auto-started the
  # gateway, waited on /readyz, ran doctor --fix, and finally exec'd the TUI.
  # That machinery kept freezing. This path throws all of it out and instead
  # reproduces a NORMAL local install: setup.sh only prepares the sandbox so
  # onboarding can work offline-restricted, then hands the terminal to the
  # user. They run `openclaw onboard`, choose how to sign in, watch it report
  # everything OK, then run `openclaw` — exactly like on their own machine.
  # No credentials, auth profiles, gateway, or model config are written here.

  # OpenClaw is baked into the image (see Dockerfile). Fallback install handles
  # stale images.
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "setup.sh: OpenClaw not found in image — falling back to runtime install (slow)..." >&2
    SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error openclaw@latest 2>&1 | tail -40
    if ! command -v openclaw >/dev/null 2>&1; then
      echo "setup.sh: ERROR: OpenClaw install failed" >&2
      exit 1
    fi
  fi

  # Runtime environment that lets the NORMAL onboarding actually succeed inside
  # the network-restricted sandbox. This is infrastructure only — it carries no
  # credentials and makes no auth decisions:
  #   - seed OpenClaw's bundled runtime deps + V8 compile cache from the
  #     image-baked copies so first-run staging doesn't hang trying to
  #     npm-install from hosts the sandbox network blocks;
  #   - route git over https (port 22 is blocked) and relax TLS for the
  #     TLS-terminating proxy so any git-based plugin fetch during onboarding
  #     works;
  #   - keep HOME=/home/agent (persisted to PostgreSQL) so the user's onboarding
  #     survives across sessions.
  export GIT_SSL_NO_VERIFY=true
  export npm_config_strict_ssl=false
  export OPENCLAW_NO_RESPAWN=1
  export NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache
  # Long WS handshake so a slow first connect does not drop the user's
  # gateway/TUI into the plugin-reload retry loop (see openclaw-hang-diagnosis.md).
  export OPENCLAW_HANDSHAKE_TIMEOUT_MS=600000
  mkdir -p /tmp/openclaw-compile-cache /tmp/openclaw-plugin-runtime-deps /home/agent/.openclaw

  if [ -d /opt/openclaw-compile-cache ] && [ -n "$(ls -A /opt/openclaw-compile-cache 2>/dev/null)" ]; then
    echo "setup.sh: seeding OpenClaw V8 compile cache from image..."
    cp -rn /opt/openclaw-compile-cache/. /tmp/openclaw-compile-cache/ 2>/dev/null || true
  fi
  if [ -d /opt/openclaw-plugin-cache ] && [ -n "$(ls -A /opt/openclaw-plugin-cache 2>/dev/null)" ]; then
    echo "setup.sh: seeding OpenClaw plugin runtime deps from image..."
    cp -rn /opt/openclaw-plugin-cache/. /tmp/openclaw-plugin-runtime-deps/ 2>/dev/null || true
  fi
  # Expose the seeded deps at OpenClaw's DEFAULT location so onboarding and the
  # TUI find them without OPENCLAW_PLUGIN_STAGE_DIR being exported (exporting it
  # into the TUI process triggers an event-loop-saturating re-staging loop).
  # The target is a symlink into /tmp, which is never synced to the DB (see
  # sync.ts HOME_SYNC_EXCLUDE_PATH_PREFIXES), so nothing under the persisted
  # /home/agent is ever a multi-GB npm cache.
  ln -sfn /tmp/openclaw-plugin-runtime-deps /home/agent/.openclaw/plugin-runtime-deps

  # A small diagnostic the user can run if onboarding or the TUI misbehaves.
  mkdir -p /home/agent/.openrind-shell
  cat > /home/agent/.openrind-shell/diagnose-openclaw.sh <<'DIAG_EOF'
#!/bin/bash
echo "=== openclaw version ==="; openclaw --version 2>&1 || true
echo; echo "=== env (relevant) ==="
env | grep -E '^(HOME|ANTHROPIC_|OPENCLAW_|NODE_COMPILE_CACHE|GIT_SSL_NO_VERIFY|npm_config_)' | sed 's/\(ANTHROPIC_API_KEY=\).*/\1***REDACTED***/'
echo; echo "=== ~/.openclaw/openclaw.json ==="
if [ -f /home/agent/.openclaw/openclaw.json ]; then
  sed 's/\("ANTHROPIC_API_KEY":[[:space:]]*"\)[^"]*/\1***REDACTED***/' /home/agent/.openclaw/openclaw.json
else
  echo "(missing — run: openclaw onboard)"
fi
echo; echo "=== auth profile ==="
ls -la /home/agent/.openclaw/agents/main/agent/auth-profiles.json 2>&1 || echo "(missing — run: openclaw onboard)"
echo; echo "=== gateway /readyz ==="
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:18789/readyz 2>&1 || echo "(unreachable — start it with: openclaw)"
DIAG_EOF
  chmod +x /home/agent/.openrind-shell/diagnose-openclaw.sh

  # Setup-only mode (desktop loading-screen prewarm): the runtime is prepared;
  # the user onboards interactively once their terminal connects. No gateway is
  # started here anymore.
  if [ -n "${OPENRIND_SHELL_SETUP_ONLY:-}" ]; then
    echo "setup.sh: setup-only mode — OpenClaw runtime prepared; onboarding is user-driven on connect"
    exit 0
  fi

  # Restore the real terminal (the top of this script redirected stdout to a
  # log) so OpenClaw's own interactive UI is what the user sees.
  exec 1>&3 3>&-

  # Launch OpenClaw's CODING AGENT on the clean, ConPTY-free PTY (openrind_pty_exec):
  #   1. First run walks the user through `openclaw onboard` (user-driven auth).
  #   2. Bring the gateway up ourselves — the container has no systemd, so nothing
  #      else starts it — reusing a healthy one from a previous session (setsid
  #      keeps it alive across PTY disconnects) and waiting for /readyz.
  #   3. exec `openclaw tui`, the thin client that renders the coding agent.
  #
  # We must NOT exec bare `openclaw`: as of 2026.4.x that opens the "Crestodian"
  # ring-zero setup/repair concierge, NOT the coding agent. `openclaw tui`
  # connects to the gateway started above and shows the agent.
  #
  # OPENCLAW_PLUGIN_STAGE_DIR is passed ONLY to the gateway (its bundled deps are
  # seeded into that dir); it must never reach the TUI/client process or OpenClaw
  # runs a staging loop that saturates the event loop and freezes the terminal.
  openrind_pty_exec env \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openrind-shell-bash \
    NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache \
    OPENCLAW_NO_RESPAWN=1 \
    OPENCLAW_HANDSHAKE_TIMEOUT_MS=600000 \
    GIT_SSL_NO_VERIFY=true \
    npm_config_strict_ssl=false \
    bash -c '
      if [ ! -s /home/agent/.openclaw/agents/main/agent/auth-profiles.json ]; then
        openclaw onboard || true
      fi
      if ! curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then
        echo "Starting OpenClaw (first run can take a minute)..."
        setsid env OPENCLAW_SKIP_ONBOARDING=1 OPENCLAW_HANDSHAKE_TIMEOUT_MS=600000 OPENCLAW_NO_RESPAWN=1 NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache GIT_SSL_NO_VERIFY=true npm_config_strict_ssl=false OPENCLAW_PLUGIN_STAGE_DIR=/tmp/openclaw-plugin-runtime-deps openclaw gateway --port 18789 --allow-unconfigured </dev/null >/tmp/openclaw-gateway.log 2>&1 &
        _gd=0
        while [ $_gd -lt 300 ]; do
          curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1 && break
          sleep 1
          _gd=$((_gd+1))
        done
      fi
      exec openclaw tui'
fi

# Claude Code launch (reached only when OPENRIND_SHELL_AGENT != openclaw, since openclaw execs above).
# Install Claude Code if not already present in the image
if ! command -v claude >/dev/null 2>&1; then
  echo "setup.sh: Claude CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -10
  if ! command -v claude >/dev/null 2>&1; then
    echo "setup.sh: ERROR: Claude CLI install failed" >&2
    exit 1
  fi
  echo "setup.sh: Claude CLI installed"
fi

# Claude Code reads ANTHROPIC_BASE_URL from process.env at startup for
# auth-mode selection. Export the proxy here so it's picked up before
# settings.json is consulted. OPENRIND_GATEWAY_API_KEY is only needed for presign
# creation — remove it before handing control to Claude Code.
# Setup-only mode (see the OpenClaw branch above for rationale).
if [ -n "${OPENRIND_SHELL_SETUP_ONLY:-}" ]; then
  echo "setup.sh: setup-only mode — Claude runtime ready, skipping launch"
  exit 0
fi

# Bind Claude Code to the desktop-selected session (create-or-resume), mirroring
# the OpenClaw path. This runs AFTER the workspace restore above, so the
# transcript probe sees conversations restored from PostgreSQL and picks the
# correct flag: --session-id refuses an id whose transcript already exists, and
# --resume refuses one that does not. OPENRIND_DESKTOP_CLAUDE_SESSION is exported by
# the desktop app's .bashrc launch block; the marker file is the fallback for
# other entry paths (consume-on-read — each marker binds exactly one launch).
_cc_sid="${OPENRIND_DESKTOP_CLAUDE_SESSION:-}"
if [ -z "$_cc_sid" ] && [ -f /sandbox/openrind-desktop-current-session ]; then
  _cc_sid="$(cat /sandbox/openrind-desktop-current-session 2>/dev/null | tr -d '\r\n ')"
  rm -f /sandbox/openrind-desktop-current-session 2>/dev/null || true
fi
case "$_cc_sid" in *[!0-9a-fA-F-]*) _cc_sid="" ;; esac
if [ -n "$_cc_sid" ]; then
  if ls /home/agent/.claude/projects/*/"$_cc_sid".jsonl >/dev/null 2>&1; then
    set -- --resume "$_cc_sid" "$@"
  else
    set -- --session-id "$_cc_sid" "$@"
  fi
fi

echo "setup.sh: launching Claude Code..."
# Restore the real terminal for Claude Code's TUI (see the clean-terminal log
# redirect near the top of this script). The claude setup-only exit is above, so
# reaching here always means an interactive-connect run where fd 3 exists.
[ -n "${OPENRIND_SHELL_SETUP_ONLY:-}" ] || exec 1>&3 3>&-
if [ -n "${OPENRIND_GATEWAY_PROXY_URL:-}" ]; then
  openrind_pty_exec env -u OPENRIND_GATEWAY_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openrind-shell-bash \
    ANTHROPIC_BASE_URL="$OPENRIND_GATEWAY_PROXY_URL" \
    claude "$@"
else
  openrind_pty_exec env \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openrind-shell-bash \
    claude "$@"
fi
