#!/usr/bin/env node
/**
 * openclaw-config.mjs — deterministic seeding of ~/.openclaw/openclaw.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * OpenClaw refuses to run a gateway unless `gateway.mode` is set, and bare
 * `openclaw` routes on config state: missing/empty config starts onboarding,
 * INVALID config starts the classic onboarding + doctor path, and only a VALID
 * config opens the agent TUI. Relying on `openclaw onboard` inside a sandbox is
 * what made the previous flow hang:
 *
 *   - headless onboarding prints a dashboard URL and waits for a browser that
 *     will never open (no `--tui` flag was passed);
 *   - onboarding refuses to persist anything until a LIVE model completion
 *     succeeds, so a cold/blocked network leaves no config behind at all;
 *   - `openclaw gateway --allow-unconfigured` then ran with NO config, which in
 *     a detected container defaults `gateway.bind` to `auto` (0.0.0.0) instead
 *     of loopback. Non-loopback connects lose the "trusted local loopback"
 *     property that auto-approves device pairing, and a pairing-pending connect
 *     is documented as `retryable: true` / `pauseReconnect: false` — the client
 *     retries forever and the TUI sits on "connecting" with no error.
 *
 * So we stop asking OpenClaw to configure itself and write a known-good config
 * ourselves, every launch, idempotently.
 *
 * CREDENTIAL POLICY
 * -----------------
 * The Anthropic API key is NEVER written here. OpenClaw's documented provider
 * auth order is auth-profiles/sqlite -> environment -> models.providers.*.apiKey,
 * so exporting ANTHROPIC_API_KEY in the process environment is sufficient. That
 * keeps the raw key out of a file which /home/agent sync would persist into
 * PostgreSQL.
 *
 * `models.providers.anthropic.baseUrl` IS written when an Openrind Gateway presign
 * is active. That is required (not merely convenient): a custom provider baseUrl
 * is also OpenClaw's network-trust decision — it allowlists that exact
 * scheme://host:port through the guarded fetch path. `ANTHROPIC_BASE_URL` alone
 * is not part of OpenClaw's supported environment contract. The same URL already
 * persists in ~/.openrind-shell/presign.json, so this adds no new exposure.
 *
 * SAFETY
 * ------
 * This script rewrites a config file in place. It refuses to run unless the
 * target is unambiguously the sandbox agent home (/home/agent) or an explicit
 * path was passed, so it can never be run from a checkout and clobber a
 * developer's own ~/.openclaw/openclaw.json. It also always keeps one rolling
 * backup of the previous contents.
 *
 * USAGE
 *   node openclaw-config.mjs --tier full|core|minimal [--json]
 *   node openclaw-config.mjs --config /path/to/openclaw.json --tier core
 *
 * The caller (openclaw-launch.sh) writes the richest tier first and re-runs with
 * a smaller tier if `openclaw config validate` rejects it, so an OpenClaw build
 * that does not know one of the hardening keys degrades instead of dying.
 *
 * ENVIRONMENT
 *   OPENCLAW_CONFIG_PATH            config file to write (default $HOME/.openclaw/openclaw.json)
 *   OPENRIND_SHELL_OPENCLAW_PORT    gateway port (default 18789; ignored unless an integer 1-65535)
 *   OPENRIND_SHELL_OPENCLAW_MODEL   agents.defaults.model.primary override
 *   OPENRIND_GATEWAY_PROXY_URL      normalized presign base URL (no /v1 suffix)
 *   OPENRIND_SHELL_OPENCLAW_WORKSPACE  agents.defaults.workspace override
 */

import {
  chmodSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const TIERS = ['full', 'core', 'minimal'];

const args = process.argv.slice(2);
const tierArg = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : 'full';
const tier = TIERS.includes(tierArg) ? tierArg : 'full';
const asJson = args.includes('--json');
const explicitConfig = args.includes('--config') ? args[args.indexOf('--config') + 1] : '';

const home = process.env.HOME || '/home/agent';
const configPath = explicitConfig || process.env.OPENCLAW_CONFIG_PATH || join(home, '.openclaw', 'openclaw.json');

// Guard: only ever write the sandbox agent home unless a path was named.
if (!explicitConfig && !process.env.OPENCLAW_CONFIG_PATH && home !== '/home/agent') {
  process.stderr.write(
    `openclaw-config: refusing to write ${configPath}\n` +
      `  This script is for the Openrind Shell sandbox (HOME=/home/agent).\n` +
      `  Pass --config <path> or set OPENCLAW_CONFIG_PATH to target another file.\n`,
  );
  process.exit(2);
}
// A bad port override must fall back, never propagate. This value is written into
// gateway.port AND handed to `openclaw gateway run --port`, so a garbage one costs
// more than it looks: `openclaw config validate` rejects the whole config, which
// walks the launcher down to a needlessly degraded tier, or the gateway binds
// something nobody probes while every client still talks to 18789 — i.e. the
// "connecting" hang again, from a typo. `Infinity` is the case the old
// `Number(x) || 18789` guard could not catch at all: it is truthy, so it passed
// straight through, and JSON.stringify serializes it as `null`.
const DEFAULT_PORT = 18789;
const portOverride = (process.env.OPENRIND_SHELL_OPENCLAW_PORT || '').trim();
const parsedPort = Number(portOverride);
const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
if (portOverride && !portValid) {
  process.stderr.write(
    `openclaw-config: ignoring OPENRIND_SHELL_OPENCLAW_PORT=${portOverride} ` +
      `(want an integer 1-65535); using ${DEFAULT_PORT}\n`,
  );
}
const port = portValid ? parsedPort : DEFAULT_PORT;
// Derive sibling paths from the config file's own directory (the state dir) so
// every path stays consistent when --config points somewhere else.
const stateDir = dirname(configPath);
const workspace = process.env.OPENRIND_SHELL_OPENCLAW_WORKSPACE || join(stateDir, 'workspace');
const logFile = join(stateDir, 'logs', 'openclaw.log');

// Accept either a bare model id or a full provider/model ref; only the model id
// matters, because the provider it is attached to depends on whether the Openrind
// Gateway proxy is active (see modelsOverlay).
const PROXY_PROVIDER_ID = 'openrind-gateway';
const modelRef = process.env.OPENRIND_SHELL_OPENCLAW_MODEL || 'anthropic/claude-sonnet-4-6';
const modelId = modelRef.includes('/') ? modelRef.slice(modelRef.lastIndexOf('/') + 1) : modelRef;
const proxyUrl = (process.env.OPENRIND_GATEWAY_PROXY_URL || '').trim();
const providerId = proxyUrl ? PROXY_PROVIDER_ID : 'anthropic';
const model = `${providerId}/${modelId}`;

// Plugins denied in the `full` tier. Override with a comma-separated list, or set
// it empty to deny nothing (e.g. if you actually want ACP inside the sandbox and
// are willing to pay the tree-walk).
const DEFAULT_DENY_PLUGINS = ['acpx', 'bonjour', 'browser', 'phone-control', 'talk-voice'];
const requestedDeny =
  process.env.OPENRIND_SHELL_OPENCLAW_DENY_PLUGINS === undefined
    ? DEFAULT_DENY_PLUGINS
    : process.env.OPENRIND_SHELL_OPENCLAW_DENY_PLUGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

// Only deny plugins the installed build actually ships. Denying an absent id is
// not fatal, but OpenClaw emits
//   "plugins.deny: plugin not found: <id> (stale config entry ignored)"
// on every config validate. 2026.7.x dropped acpx, so keeping it unconditionally
// would warn forever; filtering keeps the default list valid across versions
// without losing the protection on an older pin that still ships it.
const EXTENSIONS_DIR = '/usr/lib/node_modules/openclaw/dist/extensions';
let installedPlugins = null;
try {
  installedPlugins = new Set(readdirSync(EXTENSIONS_DIR));
} catch {
  installedPlugins = null; // unknown (not the sandbox image) -> do not filter
}
/**
 * Drop ids the installed build does not ship.
 *
 * Applied to the FINAL deny list, not just to our own additions. The restored
 * config carries whatever a previous (fuller) OpenClaw denied, and 2026.7.x
 * ships 69 extensions where older builds shipped far more — so the union kept
 * ~40 dead ids alive and OpenClaw printed
 *   plugins.deny: plugin not found: <id> (stale config entry ignored; remove it
 *   from plugins config)
 * for every one of them, on every launch. That wall of warnings is what pushed
 * the version banner off the top of the screen.
 *
 * Safe with respect to the union invariant below: an id the build does not ship
 * cannot be loaded, so removing it re-enables nothing. It is exactly the
 * "remove it from plugins config" that OpenClaw's own warning asks for.
 */
const keepInstalled = (ids) =>
  installedPlugins ? ids.filter((p) => installedPlugins.has(p)) : ids;

const denyPlugins = keepInstalled(requestedDeny);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, overlay) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function unsetPath(obj, dotted) {
  const parts = dotted.split('.');
  const last = parts.pop();
  let node = obj;
  for (const part of parts) {
    if (!isPlainObject(node[part])) return false;
    node = node[part];
  }
  if (!(last in node)) return false;
  delete node[last];
  return true;
}

/**
 * OpenClaw writes JSON5 (comments + trailing commas are legal), so a plain
 * JSON.parse can fail on a file OpenClaw itself produced. Try strict JSON, then
 * a comment/trailing-comma strip, and only then give up. Giving up is not a
 * failure: the caller backs the file up and we start from a clean object, which
 * is the documented recovery for a clobbered config anyway.
 */
function readExisting(file) {
  if (!existsSync(file)) return { config: {}, existed: false, unreadable: false };
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { config: {}, existed: true, unreadable: true };
  }
  if (!raw.trim()) return { config: {}, existed: true, unreadable: false };
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) return { config: parsed, existed: true, unreadable: false };
  } catch {
    /* fall through to the JSON5-lite pass */
  }
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Drop // comments but never the // in a scheme (guarded by the preceding :).
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    const parsed = JSON.parse(stripped);
    if (isPlainObject(parsed)) return { config: parsed, existed: true, unreadable: false };
  } catch {
    /* unreadable */
  }
  return { config: {}, existed: true, unreadable: true };
}

// ── Overlay: the keys Openrind Shell always owns ────────────────────────────────
//
// gateway.bind MUST be pinned to "loopback". OpenClaw's documented default flips
// to `auto` (0.0.0.0) inside a detected container, and only connections to a
// real 127.0.0.1 listener get the loopback semantics that silently auto-approve
// device pairing. This one key is the difference between "TUI attaches" and
// "TUI retries pairing forever showing connecting".
//
// gateway.auth.mode "none" is documented as legal and intended for trusted local
// loopback setups. It removes the whole AUTH_TOKEN_MISSING / AUTH_TOKEN_MISMATCH
// / stale-device-token failure class, which is worth more here than a shared
// secret between two processes in the same single-tenant container that is only
// reachable on 127.0.0.1.
function gatewayOverlay() {
  return { gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'none' } } };
}

// Declare the proxy as its OWN provider rather than overriding the canonical
// `anthropic` one. Two reasons, both learned the hard way:
//
//   1. OpenClaw's schema REQUIRES a `models` array on any declared provider
//      (2026.4.29 rejects `{ baseUrl, api }` with
//      "models.providers.anthropic.models: expected array, received undefined").
//      Since we must enumerate models either way, enumerating them under a new id
//      is strictly safer than partially redefining the built-in Anthropic catalog.
//   2. It leaves the stock `anthropic` provider untouched, so direct
//      api.anthropic.com traffic keeps its normal beta headers and service tier.
//
// Without a proxy we declare nothing at all and just use `anthropic/<model>`.
function modelsOverlay() {
  const models = { mode: 'merge' };
  if (!proxyUrl) return { models };
  models.providers = {
    [PROXY_PROVIDER_ID]: {
      // Must NOT include /v1 — the Anthropic client appends it. This value is
      // also OpenClaw's guarded-fetch origin-trust decision for model requests.
      baseUrl: proxyUrl,
      api: 'anthropic-messages',
      models: [
        {
          id: modelId,
          name: modelId,
          input: ['text', 'image'],
        },
      ],
    },
  };
  return { models };
}

function overlayForTier(name) {
  const minimal = deepMerge(gatewayOverlay(), modelsOverlay());
  if (name === 'minimal') return minimal;

  const core = deepMerge(minimal, {
    agents: { defaults: { workspace, model: { primary: model } } },
    logging: { file: logFile },
  });
  if (name === 'core') return core;

  // Everything below trades sandbox-irrelevant features for a gateway that
  // reaches /readyz quickly and never blocks on a host the network policy
  // denies. /readyz specifically stays red while plugin sidecars, channels and
  // hooks settle, so those are the highest-leverage switches.
  return deepMerge(core, {
    // ── The single most important entry here is `acpx`. ────────────────────
    // acpx (ACP harnesses: driving Claude Code / Codex / Gemini as sub-agents)
    // declares 35 bundled runtime deps whose transitive install is ~2.5 GB /
    // 95,000 files (@anthropic-ai 250 MB, @zed-industries 204 MB, @openai
    // 202 MB, @lancedb, @opentelemetry, @jimp, ...). OpenClaw's plugin loader
    // walks that tree on TUI startup, which on a cold page cache burns ~4
    // minutes at 100% CPU BEFORE the TUI accepts its gateway handshake. The
    // user sees "connecting" the whole time, because the event loop never gets
    // a chance to service the WebSocket that is already open. Measured in a
    // live sandbox: TUI start 07:05:17, first RPC 07:09:13.
    //
    // Nothing in an Openrind Shell coding sandbox uses ACP, a browser (no
    // Chromium is installed), voice, phone control, or mDNS. device-pair,
    // memory-core and file-transfer are deliberately NOT denied: pairing,
    // agent memory and attachments are all load-bearing.
    //
    // deny (not extension deletion) is the safe lever: removing an extension
    // directory that the bundled manifest still declares makes OpenClaw abort
    // with "plugins.deny: plugin not found".
    //
    // NOTE: the value here is a placeholder. plugins.deny is finalised AFTER the
    // merge (see applyDenyUnion) because it must be UNIONED with whatever the
    // restored config already denied — deepMerge replaces arrays, and replacing
    // this one would silently re-enable every plugin the user had turned off.
    plugins: {},
    // models.pricing drives a background OpenRouter + LiteLLM catalog fetch.
    // Neither host is in policy.yaml, so leaving it on means a guaranteed
    // stalled fetch on every gateway boot.
    models: { pricing: { enabled: false } },
    // No browser binary is installed in this image; no chat channels exist in a
    // sandbox; nothing should schedule agent turns behind the user's back.
    browser: { enabled: false },
    hooks: { enabled: false },
    cron: { enabled: false },
    agents: { defaults: { heartbeat: { every: '0m' } } },
    // Docker bridge networking drops multicast; advertising just retries.
    discovery: { mdns: { mode: 'off' } },
    // The image pins its OpenClaw version on purpose. A startup update check is
    // a blocking npm registry round trip that can only ever make things worse.
    update: { checkOnStart: false, auto: { enabled: false } },
  });
}

// Keys that actively cause the "connecting" hang if a previous session (or a
// restored workspace) left them behind. These are removed in EVERY tier.
//
//   gateway.remote      `openclaw tui` prefers gateway.remote.url over the local
//                       port, so one stale entry sends the TUI to a dead host.
//   gateway.tls         we speak plain ws:// on loopback.
//   gateway.tailscale    no tailnet in the sandbox; a resolved tailnet bind also
//                       downgrades pairing to "remote" (manual approval).
//   gateway.auth.token/  leftovers from an older token-mode config. Documented to
//   .password           fail closed when both are present, and pointless now.
//   plugins.allow       an EXCLUSIVE allowlist: anything omitted stays
//                       unavailable even when tools.allow is "*", which silently
//                       removes the agent's tools.
const ALWAYS_UNSET = [
  'gateway.remote',
  'gateway.tls',
  'gateway.tailscale',
  'gateway.auth.token',
  'gateway.auth.password',
  'plugins.allow',
];

const { config: existing, existed, unreadable } = readExisting(configPath);

// Always keep the previous contents recoverable. An unreadable file gets a
// timestamped copy (it is evidence of a bug worth keeping); a readable one gets a
// single rolling backup so a hand-edited config is never silently lost.
if (existed) {
  const backup = unreadable
    ? `${configPath}.unreadable.${Date.now()}`
    : `${configPath}.openrind-prev`;
  try {
    copyFileSync(configPath, backup);
  } catch {
    /* best effort — never block the launch on a backup */
  }
}

const merged = deepMerge(existing, overlayForTier(tier));

// plugins.deny is a UNION, never a replacement. Two failure modes this avoids:
//   - clobbering a restored deny list re-enables ~100 plugins the user disabled;
//   - opting out (DENY_PLUGINS="") must leave the existing list alone, not write
//     an empty array that re-enables everything.
if (tier === 'full') {
  const previous = Array.isArray(existing?.plugins?.deny) ? existing.plugins.deny : [];
  const union = [...new Set([...previous, ...denyPlugins])];
  // Prune stale ids from the WHOLE list, not just from our additions — see
  // keepInstalled(). Runs even when denyPlugins is empty (DENY_PLUGINS="") so
  // opting out still cleans a restored list rather than leaving it to warn.
  const pruned = keepInstalled(union).sort();
  if (pruned.length > 0) {
    merged.plugins = isPlainObject(merged.plugins) ? merged.plugins : {};
    merged.plugins.deny = pruned;
  } else if (isPlainObject(merged.plugins) && Array.isArray(merged.plugins.deny)) {
    // Nothing left to deny: drop the key instead of writing an empty array.
    delete merged.plugins.deny;
  }
}

const removed = ALWAYS_UNSET.filter((path) => unsetPath(merged, path));

mkdirSync(dirname(configPath), { recursive: true });
mkdirSync(dirname(logFile), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
// writeFileSync's `mode` is only honoured when the file is CREATED. A config
// restored from the workspace, or left by an older image that wrote it 0644, keeps
// its group/world-readable bits forever otherwise — and this file carries the
// Openrind Gateway presign proxy URL, which is itself a bearer credential. chmod
// explicitly, but best effort: a filesystem that cannot chmod must not fail a
// launch whose config is already correctly seeded.
try {
  chmodSync(configPath, 0o600);
} catch {
  /* best effort — tightening permissions is never worth aborting the launch */
}

const result = {
  ok: true,
  tier,
  path: configPath,
  port,
  model,
  workspace,
  proxied: Boolean(proxyUrl),
  createdFresh: !existed || unreadable,
  recoveredUnreadable: unreadable && existed,
  removedKeys: removed,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(
    `openclaw-config: wrote ${configPath} (tier=${tier}, port=${port}, model=${model}, ` +
      `proxy=${result.proxied ? 'yes' : 'no'}${result.recoveredUnreadable ? ', recovered-unreadable' : ''}` +
      `${removed.length ? `, removed=${removed.join(',')}` : ''})\n`,
  );
}
