// OpenEral sandbox lifecycle. The upstream openeral maintainers'
// recipe runs everything (provision + Claude Code REPL) in one
// `openshell sandbox create --tty -- openeral` from an interactive
// shell. We can't do that headlessly: createOpenEralSandbox runs via
// wslRun (piped stdio, no TTY), so passing `-- openeral` as the
// trailing command would deadlock — Claude Code's first-run "Use this
// API key?" prompt has no terminal to read from, ssh eventually
// times out, sandbox create returns exit 1.
//
// Two-step shape we use instead:
//
//   1. `openshell sandbox create --no-tty ... -- /bin/true`
//      Provisions the container, uploads /sandbox/db-url, returns as
//      soon as /bin/true exits (≈ container-ready time).
//
//   2. `openshell sandbox connect <name>`
//      Spawned by openeral-pty.mjs (node-pty) or openeral-terminal.mjs
//      (external terminal emulator). Both give the wsl.exe child a
//      real PTY. connect starts an interactive bash that sources
//      /sandbox/.bashrc, where configureAgentLaunch installed the
//      launch block: Claude Code execs directly; OpenClaw execs
//      `openeral` (the image's setup.sh) so the tested bootstrap runs.
//
// Other invariants:
//   - DATABASE_URL is staged as a FILE (one file, not a directory) in
//     the distro at /tmp/openeral-db-url-<uuid> and uploaded to
//     /sandbox/db-url. The openeral image's setup.sh reads it from
//     there at first `openeral` exec.
//   - ANTHROPIC_API_KEY rides in via env + WSLENV; --auto-providers
//     auto-creates the `claude` provider from it at create time.
//   - No --gateway flag: relies on the active selected gateway, which
//     the installer registers via `gateway add --local --name openshell`
//     and selects via `gateway select`.
//   - The rootfs MUST include openssh-client — openshell shells out
//     to ssh/scp for upload, connect, exec, download.

import { createHash, randomUUID } from "node:crypto";

import { getCliInfo } from "./cli.mjs";
import { getCredential } from "./openeral-credentials.mjs";
import { DISTRO_NAME, ensureWslKeepalive, wslRun, wslSpawn } from "./wsl.mjs";

const SANDBOX_IMAGE = "ghcr.io/openrind/openeral/sandbox:just-bash";
const IMAGE_BY_PROFILE = {
  "openeral-claude": SANDBOX_IMAGE,
  "openeral-openclaw": SANDBOX_IMAGE,
};

// Dev/local override: point the sandbox at a locally-built or alternate image
// without editing source. Set OPENWORK_SANDBOX_IMAGE to a tag reachable by the
// distro's Docker (e.g. a `docker build`-produced local tag). Applies to both
// profiles. Pair with OPENWORK_SANDBOX_SKIP_PULL=1 for local-only tags that
// have no registry to pull from.
function resolveSandboxImageOverride() {
  const override = process.env.OPENWORK_SANDBOX_IMAGE?.trim();
  return override || null;
}

const DEFAULT_PULL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

// StringCost cost-tracking control plane. Defaults to the hosted service;
// override with STRINGCOST_API_BASE=http://<host>:8080 to point at a
// self-hosted stack for local end-to-end testing. Mirrors the same default
// and override the sandbox's setup.sh uses internally.
const STRINGCOST_API_BASE = (
  process.env.STRINGCOST_API_BASE || "https://app.stringcost.com"
).replace(/\/+$/, "");
const STRINGCOST_PRESIGN_TIMEOUT_MS = 30_000;

// Placeholder ANTHROPIC_AUTH_TOKEN for StringCost-proxied Claude Code.
// StringCost authenticates via the presign token embedded in the proxy URL
// and ignores the inbound Authorization header, but Claude Code refuses to
// talk to ANTHROPIC_BASE_URL without *some* token in its env. Any non-empty
// value works and nothing validates it — it is a placeholder, not a secret.
// Compliance: no token-like value may be hardcoded in source. The value is
// sourced from the environment at runtime (OPENWORK_STRINGCOST_AUTH_TOKEN —
// e.g. for self-hosted proxies that do validate the inbound header); when
// unset, a random per-process value is generated instead of a literal, so
// nothing in the codebase looks like — or could ever collide with — a real
// credential.
const STRINGCOST_PLACEHOLDER_AUTH_TOKEN =
  process.env.OPENWORK_STRINGCOST_AUTH_TOKEN || `openwork-${randomUUID()}`;

// Docker pulls happen under user `banker` inside the distro. If Docker
// Desktop's WSL integration ever ran for this distro (or runs again on
// a future boot) it can write a `credsStore: "desktop"` line into
// ~/.docker/config.json that points at /mnt/c/.../docker-credential-desktop.exe.
// Linux docker can't exec a Windows binary — pulls then fail with
// `exec format error`. We route our docker invocations through an empty
// managed config dir so the credential helper is never invoked. The
// images we pull (openeral sandbox, postgres:16-alpine) are public, so
// skipping credentials is correct, not a workaround.
const DOCKER_CONFIG_DIR = "/tmp/openwork-docker-config";

export function imageForProfile(profile) {
  const override = resolveSandboxImageOverride();
  if (override) return override;
  const img = IMAGE_BY_PROFILE[profile];
  if (!img) throw new Error(`Unknown OpenEral profile: ${profile}`);
  return img;
}

/**
 * Pull the OpenEral image into the distro's Docker. Streamed via
 * wslSpawn so a long-running pull shows incremental progress.
 *
 * @param {string} imageRef
 * @param {{ onProgress?: (text: string) => void, timeoutMs?: number }} [options]
 */
export async function pullImage(imageRef, options = {}) {
  const { onProgress, timeoutMs = DEFAULT_PULL_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = wslSpawn([
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} pull ${shellQuote(imageRef)}`,
    ]);
    let lastStderr = "";
    const tail = (chunk) => {
      const text = chunk.toString("utf8");
      lastStderr = text;
      onProgress?.(text);
    };
    child.stdout.on("data", tail);
    child.stderr.on("data", tail);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new Error(`docker pull ${imageRef} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else
        reject(
          new Error(
            `docker pull ${imageRef} failed (exit ${code}): ${lastStderr.trim()}`,
          ),
        );
    });
  });
}

/**
 * Parse the raw openshell sandbox list output into a normalised array.
 * Returns null only when the raw text cannot yield any sandbox list at all.
 *
 * The openshell CLI has emitted several JSON shapes across releases:
 *   - Flat array:                  [...sandbox objects...]
 *   - {sandboxes: [...]}           early releases
 *   - {items: [...]}               v0.0.3x
 *   - {data: [...]}                v0.0.4x
 *   - {results: [...]}             some builds
 *   - {page: ..., items: [...]}    paginated response
 *
 * If none of the known envelope keys match, we fall back to the FIRST
 * Array-valued key found in the object, so future CLI versions with a
 * new envelope key still work without a code change.
 *
 * Each item is either a plain string (name only) or an object that may
 * carry phase/status fields depending on the CLI version.
 */
function parseSandboxList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not valid JSON at all — caller falls back to text search.
    return null;
  }

  // Flat array
  if (Array.isArray(parsed)) return parsed;

  if (parsed && typeof parsed === "object") {
    // Known envelope keys (add new ones here as the CLI evolves)
    for (const key of ["sandboxes", "items", "data", "results", "namespaces"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Generic fallback: return the first array value found
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) {
        console.warn(`[parseSandboxList] using unknown envelope key "${key}"`);
        return parsed[key];
      }
    }
  }

  return null;
}

/**
 * Parse `openshell sandbox list` (plain-text table, no --json flag) to
 * find the PHASE of a specific sandbox. Returns null when the sandbox is
 * absent from the output or the phase column cannot be located.
 *
 * CLI 0.0.42 does NOT support `--json` for `sandbox list` — it exits 0
 * but writes "unexpected argument '--json' found" to stdout. This helper
 * uses the ANSI text table that plain `sandbox list` emits instead.
 *
 * Typical table format (with optional ANSI colour codes):
 *   NAME                               CREATED        PHASE
 *   openeral-test-workspace23edf4545   2 minutes ago  Provisioning
 */
function parseListTextPhase(stdout, sandboxName) {
  // Strip ANSI escape sequences (colour, bold, cursor-movement codes).
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = clean.split(/\r?\n/);

  // Locate the header row to find the column offset of PHASE.
  let phaseOffset = -1;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.includes("NAME") && up.includes("PHASE")) {
      phaseOffset = up.indexOf("PHASE");
      break;
    }
  }

  // Scan every row for the sandbox name.
  for (const line of lines) {
    if (!line.includes(sandboxName)) continue;

    // Use the column offset when the header was found.
    if (phaseOffset >= 0 && line.length > phaseOffset) {
      const phase = line.slice(phaseOffset).trim().split(/\s+/)[0];
      if (phase) return phase;
    }

    // Fallback: split on 2+ consecutive spaces and take the last token
    // (works for table formats where there is no fixed column alignment).
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].trim();
      if (last) return last;
    }
  }

  return null;
}

/**
 * List all sandboxes by parsing the plain `openshell sandbox list` ANSI text
 * table into structured rows `{ name, created, phase }`.
 *
 * CLI 0.0.45 does NOT support `--json` for `sandbox list` (it errors with
 * "unexpected argument '--json' found"), so the JSON path in client.mjs throws
 * and the OpenEral session list comes back empty. This text parser is the
 * reliable source for the Sandboxes manager. Best-effort: returns [] when the
 * gateway is unreachable or no rows parse.
 *
 * @returns {Promise<Array<{ name: string, created: string, phase: string }>>}
 */
export async function listSandboxes() {
  let r;
  try {
    r = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--",
        "bash",
        "-c",
        "timeout 15 openshell sandbox list",
      ],
      { timeout: 25_000 },
    );
  } catch {
    return [];
  }
  if (r.exitCode !== 0) return [];
  // Strip ANSI colour/style codes, then parse by the header's column offsets.
  const clean = r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = clean.split(/\r?\n/);
  let headerLine = null;
  let nameOff = -1;
  let createdOff = -1;
  let phaseOff = -1;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.includes("NAME") && up.includes("PHASE")) {
      headerLine = line;
      nameOff = up.indexOf("NAME");
      createdOff = up.indexOf("CREATED");
      phaseOff = up.indexOf("PHASE");
      break;
    }
  }
  const rows = [];
  let pastHeader = false;
  for (const line of lines) {
    if (!pastHeader) {
      if (line === headerLine) pastHeader = true;
      continue;
    }
    if (!line.trim()) continue;
    let name;
    let created;
    let phase;
    if (nameOff >= 0 && phaseOff > nameOff) {
      const nameEnd = createdOff > nameOff ? createdOff : phaseOff;
      name = line.slice(nameOff, nameEnd).trim();
      created = createdOff >= 0 ? line.slice(createdOff, phaseOff).trim() : "";
      phase = (line.slice(phaseOff).trim().split(/\s+/)[0] ?? "").trim();
    } else {
      // Fallback: split on runs of 2+ spaces.
      const parts = line.trim().split(/\s{2,}/);
      name = (parts[0] ?? "").trim();
      created = parts.length >= 3 ? parts[1].trim() : "";
      phase = (parts[parts.length - 1] ?? "").trim();
    }
    if (name) rows.push({ name, created, phase });
  }
  return rows;
}

/**
 * Poll `openshell sandbox list` until the named sandbox reports a
 * Ready/running phase, or until the timeout elapses.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: Function }} [opts]
 */
async function waitForSandboxReady(name, opts = {}) {
  const { timeoutMs = 120_000, pollMs = 4_000, onProgress } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Track the first time we see a "Provisioning" phase so we can detect
  // sandboxes that are stuck (never transition to Ready).
  let firstProvisioningAt = null;
  const STUCK_PROVISIONING_THRESHOLD_MS = 90_000; // 90 s in Provisioning → stuck
  // Track whether we've seen the sandbox in a "Deleting" phase so we can
  // detect when it disappears and signal the caller to create a fresh one.
  let sawDeleting = false;

  while (Date.now() < deadline) {
    attempt += 1;
    // 20 s outer timeout gives 10 s slack after bash's inner 10 s timer
    // fires, so wsl.exe has time to exit before wslRun's own timer does.
    let r;
    try {
      // Use plain `sandbox list` (no --json). CLI 0.0.42 does not support
      // --json for this subcommand — it exits 0 but writes an error string
      // to stdout, causing parseSandboxList to return null every time.
      // parseListTextPhase reads the phase directly from the ANSI text table.
      r = await wslRun(
        [
          "-d",
          DISTRO_NAME,
          "--",
          "bash",
          "-c",
          "timeout 10 openshell sandbox list",
        ],
        { timeout: 20_000 },
      );
    } catch {
      // Gateway unreachable during polling — report progress and keep
      // waiting; the sandbox may still transition to Ready.
      onProgress?.({
        phase: "waiting",
        message: `Gateway unresponsive (attempt ${attempt}), retrying…`,
      });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (r.exitCode === 0) {
      const phase = parseListTextPhase(r.stdout, name)?.toLowerCase() ?? null;
      if (phase !== null) {
        // Sandbox is visible in the list — check its phase.
        if (!phase || /ready|running/i.test(phase)) return;
        if (/error|failed/i.test(phase)) {
          throw new Error(
            `Sandbox ${name} is in error state (${phase}). Delete it and reconnect.`,
          );
        }
        // Sandbox is being deleted — record that we saw it deleting so when
        // it disappears from the list we know to create fresh rather than
        // treating the absence as "still provisioning".
        if (/delet/i.test(phase)) {
          sawDeleting = true;
          onProgress?.({
            phase: "waiting",
            message: `Sandbox is deleting; waiting for deletion to complete…`,
          });
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        // Detect sandboxes stuck in Provisioning. If the sandbox has been
        // in a provisioning-like state for longer than the threshold, bail
        // out early with a clear error so the renderer can offer a
        // "Delete and start fresh" action rather than spinning forever.
        if (/provision/i.test(phase)) {
          if (!firstProvisioningAt) firstProvisioningAt = Date.now();
          const stuckMs = Date.now() - firstProvisioningAt;
          if (stuckMs > STUCK_PROVISIONING_THRESHOLD_MS) {
            throw new Error(
              `STUCK_PROVISIONING: Sandbox "${name}" has been in "${phase}" state for ` +
                `over ${Math.round(stuckMs / 1000)}s and appears stuck. ` +
                `Delete the sandbox and reconnect to create a fresh one. ` +
                `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
            );
          }
        } else {
          // Phase changed away from Provisioning — reset the timer.
          firstProvisioningAt = null;
        }
        onProgress?.({
          phase: "waiting",
          message: `Sandbox is ${phase} (attempt ${attempt}), waiting…`,
        });
      } else if (sawDeleting) {
        // phase === null and we previously saw "Deleting" → sandbox is gone.
        // Signal the caller to create a fresh sandbox instead of proceeding
        // optimistically (finalizeSandboxLaunch would fail on a deleted sandbox).
        throw new Error(
          `SANDBOX_DELETED: Sandbox "${name}" has finished deleting. ` +
            `A fresh sandbox will be created automatically.`,
        );
      }
      // phase === null and no prior "Deleting" → sandbox not yet visible in
      // the list (still provisioning). Keep polling.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Timed out without confirming Ready — if we last saw a provisioning phase
  // treat it as stuck rather than proceeding optimistically (the exec would
  // fail anyway with "phase: Provisioning").
  if (firstProvisioningAt) {
    throw new Error(
      `STUCK_PROVISIONING: Sandbox "${name}" did not reach Ready state within ${Math.round(timeoutMs / 1000)}s ` +
        `(last observed phase: Provisioning). ` +
        `Delete the sandbox and reconnect to create a fresh one. ` +
        `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
    );
  }
  // Non-provisioning timeout — proceed; exec may succeed if setup.sh just finished.
  onProgress?.({
    phase: "timeout",
    message:
      "Sandbox did not confirm Ready state; attempting to connect anyway.",
  });
}

/**
 * True if a sandbox with this name is registered. Used to short-circuit
 * createOpenEralSandbox when re-opening a workspace.
 *
 * Tolerates the flat-array (`[...]`) and envelope (`{sandboxes:[...]}`,
 * `{items:[...]}`) JSON shapes the upstream CLI has emitted across releases.
 */
export async function sandboxExists(name) {
  if (!name) return false;
  // Wrap with bash timeout so the openshell CLI is force-killed after
  // 15 s if the gateway is unreachable. Without this wrapper the
  // process hangs until wslRun's full timeout fires — making the UI
  // appear frozen. bash exits 124 when it kills the child.
  //
  // wslRun timeout is set to 25 s (10 s slack after bash's 15 s fires).
  // Without the extra slack wsl.exe can outlive the bash timeout and
  // trigger wslRun's own timer — throwing a raw "wsl.exe timed out"
  // error before the exitCode === 124 check below is ever reached.
  // CLI 0.0.42 does NOT support `--json` for `sandbox list` — it exits 0
  // but writes "unexpected argument '--json' found" to stdout, which causes
  // parseSandboxList to return null and the fallback text-includes check to
  // miss the sandbox name (the error message doesn't contain it).
  // `--names` outputs one sandbox name per line and is supported in 0.0.42.
  let r;
  try {
    r = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--",
        "bash",
        "-c",
        "timeout 15 openshell sandbox list --names",
      ],
      { timeout: 25_000 },
    );
  } catch (err) {
    // wslRun throws (never returns r) when its own timer fires.
    // Map any timeout to the user-friendly gateway message so the
    // renderer can show a clear call-to-action instead of a raw stack.
    throw new Error(
      "OpenShell gateway is not responding (sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode === 124) {
    throw new Error(
      "OpenShell gateway is not responding (openshell sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode !== 0) return false;
  // --names outputs one sandbox name per line (no JSON).
  const names = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (names.includes(name)) return true;
  // Fallback: if --names flag is not supported by a future CLI version and the
  // output falls back to a text/JSON format, check whether the raw output
  // contains the sandbox name anywhere (conservative — avoids a spurious create).
  if (names.length === 0 && r.stdout.includes(name)) {
    console.warn(
      `[sandboxExists] --names may be unsupported; found "${name}" via text search.`,
    );
    return true;
  }
  return false;
}

/**
 * Build the wsl.exe env that forwards ANTHROPIC_API_KEY (and, for the
 * openclaw profile, OPENERAL_AGENT) into the Linux side. WSL only
 * forwards env vars whose names appear in WSLENV.
 */
function buildWslEnvForwarding(extra) {
  const forwardedNames = Object.keys(extra);
  const existingWslEnv = process.env.WSLENV ? [process.env.WSLENV] : [];
  return {
    ...process.env,
    ...extra,
    WSLENV: [...existingWslEnv, ...forwardedNames].join(":"),
  };
}

/**
 * Single-quote a string for safe embedding in a bash command.
 * Replaces any embedded ' with the standard `'\''` escape so the value
 * always rides as a single bash token even if it contains spaces or
 * shell metachars.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Derive the `ANTHROPIC_BASE_URL` an agent should use from a StringCost
 * presign URL.
 *
 * The control plane mints a single-path presign whose URL already ends in
 * `/v1/messages` (e.g. `https://proxy.stringcost.com/stringcost-proxy/t/<token>/v1/messages`).
 * Claude Code / OpenClaw append `/v1/messages` themselves, so the base URL
 * we hand them must NOT include it — otherwise the proxy sees
 * `/v1/messages/v1/messages` and rejects it with "Path not authorized".
 *
 * Accepts the hosted shape (proxy.stringcost.com) and any self-hosted
 * `http(s)://<host>/stringcost-proxy/t/<token>` shape. Returns null when the
 * URL doesn't look like a StringCost proxy URL so callers can skip the
 * injection rather than write a garbage base URL.
 *
 * @param {string} presignUrl
 * @returns {string | null}
 */
function stringcostBaseUrlForAgent(presignUrl) {
  if (typeof presignUrl !== "string") return null;
  let url = presignUrl.trim().replace(/\/+$/, ""); // drop trailing slash(es)
  url = url.replace(/\/v1\/messages$/, "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+\/stringcost-proxy\/t\/[^/]+$/.test(url)) return null;
  return url;
}

/**
 * Build an `openshell sandbox exec` command that runs an arbitrary multi-line
 * shell script inside the container without nested-quoting hell: the script is
 * base64-encoded on the host and decoded + piped to `sh` in the sandbox. Only
 * the base64 blob (A–Z a–z 0–9 + / =) crosses the command line, so embedded
 * quotes, newlines, and `$` in the script never need escaping.
 *
 * @param {string} name  Sandbox name
 * @param {string} script  POSIX sh script to run in the container
 * @returns {string}  A `bash -c`-ready command string
 */
function sandboxRunScriptCmd(name, script) {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return (
    `openshell sandbox exec --name ${shellQuote(name)} -- ` +
    `sh -c ${shellQuote(`printf %s ${shellQuote(b64)} | base64 -d | sh`)}`
  );
}

// Container path of the per-connect "which agent conversation to launch"
// marker. The .bashrc launch block (buildLaunchBlock) reads this file each
// time an interactive connect auto-launches the agent; the desktop app
// rewrites it (writeCurrentSessionMarker) before every FRESH connect so the
// launched agent binds to the OpenWork session the user selected. Lives under
// /sandbox (ephemeral, container-scoped) rather than /home/agent so it is
// never captured by the PostgreSQL home sync.
const SESSION_MARKER_PATH = "/sandbox/openwork-current-session";

// Fixed namespace for deriving deterministic Claude Code session UUIDs from
// OpenWork/opencode session ids (which are `ses_...`, not UUIDs). Any random
// but STABLE UUID works — it just has to never change, so the same OpenWork
// session always maps to the same Claude conversation across reconnects and
// across machines (the sandbox home is portable via the DB sync).
const CLAUDE_SESSION_NAMESPACE = "6f9b1e2a-0c3d-4b7a-9e21-8a4c1d5f7b30";

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Derive a deterministic RFC-4122 v5 (name-based, SHA-1) UUID from an
 * arbitrary OpenWork session id. Claude Code's `--session-id`/`--resume`
 * flags require a valid UUID; opencode session ids (`ses_...`) are not, so we
 * hash them into a stable UUID. Deterministic so the same OpenWork session
 * always resolves to the same Claude conversation.
 *
 * @param {string} openworkSessionId
 * @returns {string} lowercase UUID
 */
function deriveClaudeSessionUuid(openworkSessionId) {
  const ns = uuidToBytes(CLAUDE_SESSION_NAMESPACE);
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(String(openworkSessionId), "utf8"))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  return formatUuid(bytes);
}

/**
 * Sanitize an OpenWork session id into a safe OpenClaw `--session <key>`
 * value: OpenClaw session keys are free-form names, but the value is
 * interpolated (unquoted) into the launch block, so restrict it to a shell-
 * and glob-safe alphabet. Falls back to null when nothing usable remains.
 *
 * @param {string} openworkSessionId
 * @returns {string | null}
 */
function sanitizeOpenclawSessionKey(openworkSessionId) {
  const key = String(openworkSessionId ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return key || null;
}

/**
 * Resolve the marker-file value for a given agent + OpenWork session id:
 * a derived UUID for Claude Code, a sanitized key for OpenClaw. Returns null
 * when no specific session was requested (falls back to the agent's default
 * conversation — preserves pre-per-session behavior).
 *
 * @param {string} profile  "openeral-claude" | "openeral-openclaw"
 * @param {string | null | undefined} openworkSessionId
 * @returns {string | null}
 */
export function resolveAgentSessionValue(profile, openworkSessionId) {
  const id = String(openworkSessionId ?? "").trim();
  if (!id) return null;
  return profile === "openeral-openclaw"
    ? sanitizeOpenclawSessionKey(id)
    : deriveClaudeSessionUuid(id);
}

/**
 * Write (or clear) the per-connect session marker inside the container. Call
 * this immediately before a FRESH connect so the .bashrc launch block binds
 * the auto-launched agent to the requested OpenWork session. Passing a null/
 * empty value removes the marker so the agent launches its default
 * conversation. Best-effort: a failure just means the agent launches its
 * default session, so it never blocks the connect.
 *
 * @param {string} name  Sandbox name
 * @param {string | null} value  Resolved marker value (UUID / key) or null
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function writeCurrentSessionMarker(name, value, env) {
  const script = value
    ? `mkdir -p /sandbox && printf %s ${shellQuote(value)} > ${SESSION_MARKER_PATH} && chmod 600 ${SESSION_MARKER_PATH} 2>/dev/null || true`
    : `rm -f ${SESSION_MARKER_PATH} 2>/dev/null || true`;
  await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", sandboxRunScriptCmd(name, script)],
    { timeout: 30_000, env },
  );
}

/**
 * Wait (bounded) for the session marker to be consumed by a connecting
 * shell. The .bashrc launch block deletes the marker right after reading it,
 * so "file gone" means the previous fresh connect has bound its session and
 * it is safe to write the next marker. Agent sessions are concurrent —
 * back-to-back fresh opens against one sandbox would otherwise race on the
 * single marker file and could bind a PTY to the wrong conversation.
 * Best-effort: on timeout (e.g. the previous connect died before its shell
 * ran) the caller proceeds anyway.
 *
 * @param {string} name  Sandbox name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when the marker is confirmed consumed
 */
export async function waitCurrentSessionMarkerConsumed(
  name,
  env,
  timeoutMs = 6_000,
) {
  const script = `if [ -f ${SESSION_MARKER_PATH} ]; then echo present; else echo absent; fi`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await wslRun(
        [
          "-d",
          DISTRO_NAME,
          "--",
          "bash",
          "-c",
          sandboxRunScriptCmd(name, script),
        ],
        { timeout: 15_000, env },
      );
      if (!/present/.test(r.stdout ?? "")) return true;
    } catch {
      // Probe failed (sandbox briefly unreachable) — treat as consumed so a
      // transient exec error never blocks opening a session.
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Ensure the distro has `scp`/`ssh` (openssh-client) before any sandbox op.
 *
 * `openshell sandbox create --upload`, `exec`, `connect`, and `download` all
 * shell out to the local scp/ssh binaries. On a distro imported from a rootfs
 * that predates the openssh-client requirement — or where the docker install
 * phase ran before this dependency was added — those binaries are missing and
 * EVERY sandbox operation dies with a cryptic
 * `Error: × No such file or directory (os error 2)` (Rust's Command::spawn
 * failing to find the binary, not a missing upload source).
 *
 * The installer's docker phase now bakes openssh-client in, but that phase is
 * marked complete on already-provisioned distros and won't re-run — so this
 * guard self-heals existing installs. It's a fast `command -v` check that only
 * apt-installs (root, ~5s) when scp/ssh are actually absent.
 *
 * @param {(evt: {phase: string, message: string}) => void} [onProgress]
 */
async function ensureOpensshClient(onProgress) {
  const present = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      "command -v scp >/dev/null && command -v ssh >/dev/null",
    ],
    { timeout: 15_000 },
  ).catch(() => ({ exitCode: 1 }));
  if (present.exitCode === 0) return;

  onProgress?.({
    phase: "deps",
    message: "Installing openssh-client (required for sandbox file transfer)…",
  });
  const script = [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y openssh-client",
  ].join("\n");
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--user", "root", "--", "bash", "-c", script],
    { timeout: 5 * 60_000 },
  ).catch((err) => ({
    exitCode: -1,
    stdout: "",
    stderr: err?.message ?? String(err),
  }));
  if (r.exitCode !== 0) {
    throw new Error(
      `openssh-client is missing from the "${DISTRO_NAME}" distro and could not be ` +
        `installed automatically — openshell needs scp/ssh to provision sandboxes. ` +
        `Install it manually with: wsl -d ${DISTRO_NAME} --user root -- ` +
        `apt-get install -y openssh-client  ` +
        `(apt error: ${(r.stderr || r.stdout || "unknown").trim().slice(0, 200)})`,
    );
  }
}

/**
 * Configure how the agent starts inside the sandbox: export the StringCost
 * proxy env (when a presign was minted) and auto-launch the agent so the user
 * never has to type `claude`.
 *
 * Why this is needed: the published image's entrypoint is /bin/bash and
 * OpenShell's supervisor starts the agent as an interactive `bash -i`. That
 * sources /sandbox/.bashrc but never runs the image's /opt/openeral/setup.sh,
 * so (a) the uploaded StringCost presign is ignored — the agent talks to
 * Anthropic directly and nothing is metered — and (b) the session drops to a
 * shell prompt instead of launching the agent. We fix both by writing a single
 * managed block to /sandbox/.bashrc:
 *   - export ANTHROPIC_BASE_URL (proxy) + a throwaway ANTHROPIC_AUTH_TOKEN and
 *     unset the OpenShell placeholder ANTHROPIC_API_KEY (StringCost auths via
 *     the token embedded in the proxy URL and bills the real key stored with
 *     the presign);
 *   - auto-launch the agent. The guard (OPENWORK_AGENT_LAUNCHED + a tty
 *     check) makes sure only the top-level interactive shell auto-launches —
 *     nested shells the agent itself spawns inherit OPENWORK_AGENT_LAUNCHED=1
 *     and fall through to a normal shell. Claude Code is exec'd directly;
 *     OpenClaw is launched via `exec openeral` (the image's setup.sh) so the
 *     full tested bootstrap runs — see buildLaunchBlock for the rationale.
 * For Claude Code we also merge ANTHROPIC_BASE_URL into ~/.claude/settings.json
 * so it applies even if a launch isn't an interactive bash.
 *
 * Idempotent (drops any prior block first) and best-effort (a failure leaves
 * the sandbox usable, just without auto-launch / metering).
 *
 * @param {{ name: string, profile: string, proxyBase: string | null,
 *           env: NodeJS.ProcessEnv, onProgress?: Function }} args
 */

/**
 * Pure helper: build the .bashrc block lines for a given agent launch config.
 * Exported via __testing so the block content can be verified without calling
 * wslRun. configureAgentLaunch delegates to this.
 *
 * For openclaw, the block delegates to the image's tested entry point
 * (`openeral` → /opt/openeral/setup.sh) instead of re-implementing the
 * bootstrap inline:
 *   1. Export the real ANTHROPIC_API_KEY (embedded + /sandbox/anthropic-api-key
 *      override), STRINGCOST_PROXY_URL (setup.sh's highest-priority presign
 *      source), and OPENERAL_AGENT=openclaw for setup.sh's agent gate.
 *   2. Reconnect fast path: the gateway from a previous session survives PTY
 *      disconnects (setup.sh starts it with setsid). When /readyz is healthy,
 *      exec the TUI directly — mirrors setup.sh's own final exec.
 *   3. Otherwise kill any zombie gateway and `exec openeral`.
 *
 * History: an earlier version of this block wrote auth-profiles.json and
 * openclaw.json by hand and started the gateway itself. That failed three
 * ways on openclaw 2026.4.29: the hand-written auth profile was rejected
 * ("ignored invalid auth profile entries during store load"), the meta-less
 * config was backed up and overwritten by the gateway ("Config write anomaly:
 * missing-meta-before-write"), and the cold gateway had to stage all 35
 * bundled runtime deps at startup inside the network-restricted sandbox —
 * hanging /readyz past the 600 s budget ("gateway keeps crashing"). setup.sh
 * avoids all three by running `openclaw onboard` (schema-correct profile +
 * foreground plugin staging) BEFORE the gateway starts, and it also brings up
 * the openeral runtime this block previously skipped entirely: DB migrations,
 * workspace seeding, and the openeral-bash daemon.
 *
 * @param {string} profile
 * @param {string | null} proxyBase  StringCost proxy base URL, or null
 * @returns {string}  The bash block content (lines joined by \n)
 */
function buildLaunchBlock(profile, proxyBase, apiKey = null) {
  const isClaude = profile !== "openeral-openclaw";
  const block = ["# >>> openwork launch >>>"];

  if (proxyBase) {
    if (isClaude) {
      block.push(
        // shellQuote: proxyBase originates from sandbox-controlled input
        // (uploaded presign.json) or an HTTP response body — never
        // interpolate it into bash unquoted/double-quoted, where $(...)
        // would execute when .bashrc is sourced.
        `export ANTHROPIC_BASE_URL=${shellQuote(proxyBase)}`,
        `export ANTHROPIC_AUTH_TOKEN=${shellQuote(STRINGCOST_PLACEHOLDER_AUTH_TOKEN)}`,
        // Claude Code auths via the proxy URL token — the real key is not needed.
        "unset ANTHROPIC_API_KEY",
      );
    } else {
      // OpenClaw: setup.sh owns the StringCost wiring. STRINGCOST_PROXY_URL is
      // its highest-priority source — it normalizes the URL, persists the
      // presign to the workspace, and registers the stringcost provider in
      // openclaw.json itself. The presign uploaded to
      // /sandbox/openeral-input/presign.json by configureAgentLaunch remains
      // as setup.sh's file-based fallback.
      // shellQuote: same injection hardening as the claude branch above.
      block.push(`export STRINGCOST_PROXY_URL=${shellQuote(proxyBase)}`);
    }
  }

  if (!isClaude) {
    block.push(
      // Real API key for setup.sh's onboard step. Embed as primary source so
      // the key is available even if the file upload timed out at launch time,
      // then prefer the uploaded file (newer on key rotation). setup.sh reads
      // /sandbox/anthropic-api-key itself only when the env var is empty or an
      // openshell:resolve:env:* placeholder.
      ...(apiKey ? [`export ANTHROPIC_API_KEY=${shellQuote(apiKey)}`] : []),
      "if [ -f /sandbox/anthropic-api-key ]; then",
      "  _fk=\"$(tr -d '[:space:]' < /sandbox/anthropic-api-key)\"",
      '  [ -n "$_fk" ] && export ANTHROPIC_API_KEY="$_fk"',
      "fi",
      // Agent gate for setup.sh — the same value the openclaw generic provider
      // injects in the canonical `openshell sandbox create ... -- openeral` flow.
      "export OPENERAL_AGENT=openclaw",
    );
  }

  // ── Auto-launch guard ───────────────────────────────────────────────────
  block.push(
    'if [ -z "${OPENWORK_AGENT_LAUNCHED:-}" ] && [ -t 0 ]; then',
    "  export OPENWORK_AGENT_LAUNCHED=1",
    // Wipe the terminal (screen + scrollback) so the OpenShell connect
    // handshake / shell-init escape noise is gone before the TUI paints.
    "  printf '\\033[2J\\033[3J\\033[H'",
  );
  if (isClaude) {
    block.push(
      // Native-install check hygiene: configureAgentLaunch symlinks the real
      // binary into ~/.local/bin; this export puts that dir on PATH so the
      // check is fully satisfied. Without BOTH, Claude Code prints a warning
      // or an `echo 'export PATH=...' >> ~/.bashrc` hint before the banner,
      // and ConPTY's resize reflow smears that stray line into gibberish
      // pinned above the welcome box (Ink never repaints rows it doesn't
      // own). With trust pre-seeded and this satisfied, the banner is the
      // FIRST thing painted — nothing above it to garble.
      '  export PATH="$HOME/.local/bin:$PATH"',
      // Bind Claude Code to the OpenWork session the desktop app selected.
      // writeCurrentSessionMarker drops a derived UUID here before each fresh
      // connect; an empty/absent marker (CLI flow, or no session selected)
      // falls through to a plain `claude`. The UUID charset is validated
      // defensively before it is interpolated into the exec.
      `  _ow_sid=""`,
      // Consume-on-read: sessions are concurrent, so several connects can be
      // in flight against this sandbox. Each marker is meant for exactly ONE
      // launch — delete it the moment it is read so a later connect can
      // never re-bind to a stale value (the app writes a fresh marker before
      // every fresh connect and waits for the previous one to be consumed).
      `  if [ -f ${SESSION_MARKER_PATH} ]; then`,
      `    _ow_sid="$(cat ${SESSION_MARKER_PATH} 2>/dev/null | tr -d '\\r\\n ')"`,
      `    rm -f ${SESSION_MARKER_PATH} 2>/dev/null || true`,
      `  fi`,
      `  case "$_ow_sid" in *[!0-9a-fA-F-]*) _ow_sid="" ;; esac`,
      `  if [ -n "$_ow_sid" ]; then`,
      // --session-id refuses an id whose transcript already exists ("already
      // in use"), and --resume refuses one that does NOT exist ("no
      // conversation found"). Pick the right flag by probing Claude's own
      // transcript store across every project dir so the choice is correct
      // regardless of the launch cwd.
      `    if ls "$HOME"/.claude/projects/*/"$_ow_sid".jsonl >/dev/null 2>&1; then`,
      `      exec claude --resume "$_ow_sid"`,
      `    fi`,
      `    exec claude --session-id "$_ow_sid"`,
      `  fi`,
      "  exec claude",
    );
  } else {
    block.push(
      // Reconnect fast path: the gateway from a previous session survives PTY
      // disconnects (setup.sh starts it with setsid). When it is still healthy,
      // exec the TUI directly instead of re-running setup.sh. This mirrors
      // setup.sh's own final exec:
      //   - ~/.openeral/env.sh carries ANTHROPIC_BASE_URL when StringCost is
      //     active (written by setup.sh for reconnect sessions). It also
      //     contains `unset ANTHROPIC_API_KEY` — meant for Claude Code,
      //     which auths via the proxy URL token. OpenClaw needs the literal
      //     key (setup.sh: OpenShell placeholders are unusable by openclaw's
      //     Node gateway) and setup.sh's own final exec keeps it in the env,
      //     so save the key loaded above and re-export it after sourcing;
      //   - -u OPENCLAW_PLUGIN_STAGE_DIR: must NOT reach the TUI process —
      //     forwarding it causes openclaw to run its own concurrent staging
      //     loop that saturates the event loop and freezes the terminal;
      //   - -u ANTHROPIC_AUTH_TOKEN: env.sh exports a dummy token for Claude
      //     Code's benefit; the canonical openclaw env never has it;
      //   - SHELL=/usr/local/bin/openeral-bash: agent tool shell invocations
      //     go through openeral's PostgreSQL-backed workspace layer.
      // `openclaw tui`, NOT bare `openclaw`: as of 2026.4.x the bare command
      // opens the "crestodian" setup concierge instead of the coding agent
      // (setup.sh's final exec uses `openclaw tui` for the same reason).
      // 600 s handshake timeout matches setup.sh — the TUI blocks its own
      // event loop during plugin loading (a single pass can exceed 2 min in
      // the sandbox), and a shorter timeout aborts the connect and re-runs
      // the whole plugin pass in a 100%-CPU retry loop that ends with the
      // TUI stranded in a permanent "disconnected" state.
      // NODE_NO_WARNINGS: hide the UNDICI-EHPA experimental warnings that
      // otherwise print above the TUI banner in the user's terminal.
      //
      // OpenClaw session binding: `openclaw tui --session <key>` selects the
      // conversation thread (create-or-resume). writeCurrentSessionMarker
      // drops the sanitized key here before each fresh connect; both the fast
      // path (direct exec) and the cold path (setup.sh, via the exported
      // OPENWORK_OPENCLAW_SESSION var) honor it. Empty marker keeps OpenClaw's
      // default "main" session.
      `  _ow_sk=""`,
      // Consume-on-read — same one-marker-per-launch contract as the claude
      // branch (sessions are concurrent; see that comment).
      `  if [ -f ${SESSION_MARKER_PATH} ]; then`,
      `    _ow_sk="$(cat ${SESSION_MARKER_PATH} 2>/dev/null | tr -d '\\r\\n ')"`,
      `    rm -f ${SESSION_MARKER_PATH} 2>/dev/null || true`,
      `  fi`,
      `  case "$_ow_sk" in *[!a-zA-Z0-9._-]*) _ow_sk="" ;; esac`,
      "  if curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then",
      '    _saved_key="${ANTHROPIC_API_KEY:-}"',
      "    [ -f /home/agent/.openeral/env.sh ] && . /home/agent/.openeral/env.sh",
      '    [ -n "$_saved_key" ] && export ANTHROPIC_API_KEY="$_saved_key"',
      "    exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR -u ANTHROPIC_AUTH_TOKEN \\",
      "      HOME=/home/agent \\",
      "      SHELL=/usr/local/bin/openeral-bash \\",
      "      OPENCLAW_NO_RESPAWN=1 \\",
      "      NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache \\",
      "      GIT_SSL_NO_VERIFY=true npm_config_strict_ssl=false \\",
      "      OPENCLAW_HANDSHAKE_TIMEOUT_MS=600000 \\",
      "      NODE_NO_WARNINGS=1 \\",
      "      openclaw tui ${_ow_sk:+--session $_ow_sk}",
      "  fi",
      // Cold start (or crashed gateway): clear any zombie process that may
      // still hold port 18789 — setup.sh starts its gateway without a pkill,
      // because in the canonical fresh-container flow none can exist — then
      // hand over to the image's tested entry point. setup.sh does everything
      // this block used to hand-roll: DB migrations, workspace seed,
      // openeral-bash daemon, StringCost presign resolution, `openclaw
      // onboard` (schema-correct auth profile + foreground plugin staging),
      // gateway start + readiness wait, TUI plugin pre-stage, doctor --fix,
      // and finally execs the OpenClaw TUI.
      "  pkill -f 'openclaw gateway' 2>/dev/null || true",
      // Hand the session key to setup.sh's own final `openclaw tui` exec.
      '  export OPENWORK_OPENCLAW_SESSION="$_ow_sk"',
      "  exec openeral",
    );
  }
  block.push("fi", "# <<< openwork launch <<<");
  return block.join("\n");
}

async function configureAgentLaunch({
  name,
  profile,
  proxyBase,
  env,
  onProgress,
  apiKey,
  presignUrl,
}) {
  const isClaude = profile !== "openeral-openclaw";

  // Built literally into /sandbox/.bashrc via a quoted heredoc — `$` stays
  // literal so bash expands OPENWORK_AGENT_LAUNCHED/`$-` at source time, not now.
  const blockContent = buildLaunchBlock(profile, proxyBase, apiKey ?? null);

  // All sandbox writes are combined into ONE exec call to avoid the 30 s
  // timeout cascade that occurs when three separate wslRun calls each race
  // against the per-call timeout. A single call with 180 s is far more
  // reliable for a cold container that is still settling after provisioning.
  const lines = [
    "set -e",
    // Write API key file if provided (ensures setup.sh and .bashrc can read it).
    ...(apiKey
      ? [
          "mkdir -p /sandbox",
          `printf %s ${shellQuote(apiKey)} > /sandbox/anthropic-api-key`,
          "chmod 600 /sandbox/anthropic-api-key",
        ]
      : []),
    // Write presign file if a new presign was minted this session.
    ...(presignUrl
      ? [
          "mkdir -p /sandbox/openeral-input",
          `printf %s ${shellQuote(JSON.stringify({ url: presignUrl }))} > /sandbox/openeral-input/presign.json`,
          "chmod 600 /sandbox/openeral-input/presign.json",
        ]
      : []),
    // Claude-only pre-launch hygiene — kills every paint that used to land
    // above the welcome banner and survive as garbled scrollback:
    //   1. Pre-accept folder trust for the connect cwd (/sandbox) so the
    //      first thing Claude Code draws is the banner, not the "Quick
    //      safety check" dialog. Accepting that dialog makes Ink erase and
    //      repaint the screen, and ConPTY's reflow reliably leaves the
    //      dialog's full-width separator as a gibberish line pinned above
    //      the banner. The sandbox container is the security boundary here
    //      and settings.json still carries the permission deny-list, so
    //      pre-trusting the sandbox's own workspace folder gives up nothing.
    //   2. Create ~/.local/bin and symlink the real binary into it
    //      (HOME=/sandbox in the connect shell) so the native-installer
    //      check doesn't print "installMethod is native, but claude command
    //      not found at /sandbox/.local/bin/claude" into the terminal
    //      before the TUI takes over.
    // Static script — no runtime values are interpolated.
    ...(isClaude
      ? [
          "mkdir -p /sandbox/.local/bin /sandbox/.claude",
          'ln -sfn "$(command -v claude || echo /usr/local/bin/claude)" /sandbox/.local/bin/claude 2>/dev/null || true',
          `node -e 'const fs=require("fs");const f="/sandbox/.claude.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8")||"{}")}catch(e){}s.projects=Object.assign({},s.projects);s.projects["/sandbox"]=Object.assign({},s.projects["/sandbox"],{hasTrustDialogAccepted:true});fs.writeFileSync(f,JSON.stringify(s,null,2))' 2>/dev/null || true`,
        ]
      : []),
    "RC=/sandbox/.bashrc",
    '[ -f "$RC" ] || : > "$RC"',
    // Idempotent: drop any prior managed block so re-creates update cleanly.
    "sed -i '/# >>> openwork launch >>>/,/# <<< openwork launch <<</d' \"$RC\" 2>/dev/null || true",
    "cat >> \"$RC\" <<'OPENWORK_LAUNCH_EOF'",
    blockContent,
    "OPENWORK_LAUNCH_EOF",
  ];
  if (isClaude && proxyBase) {
    lines.push(
      "mkdir -p /sandbox/.claude",
      // proxyBase / token are passed as argv — never interpolated into the
      // bash line or the inline JS source (shell-injection hardening).
      `node -e 'const fs=require("fs");const f="/sandbox/.claude/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8")||"{}")}catch(e){}s.env=Object.assign({},s.env,{ANTHROPIC_BASE_URL:process.argv[1],ANTHROPIC_AUTH_TOKEN:process.argv[2]});fs.writeFileSync(f,JSON.stringify(s,null,2))' ${shellQuote(proxyBase)} ${shellQuote(STRINGCOST_PLACEHOLDER_AUTH_TOKEN)} 2>/dev/null || true`,
    );
  }

  await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      sandboxRunScriptCmd(name, lines.join("\n")),
    ],
    { timeout: 180_000, env },
  )
    .then(() =>
      onProgress?.({
        phase: "launch",
        message: proxyBase
          ? "StringCost cost tracking enabled; agent will auto-launch."
          : "Agent will auto-launch on connect.",
      }),
    )
    .catch((e) => {
      // Non-fatal — sandbox still works; user can launch the agent manually.
      console.warn(
        "[createOpenEralSandbox] agent launch configuration failed (non-fatal):",
        e.message,
      );
    });
}

/**
 * Run the OpenClaw runtime setup headlessly while the app is still showing
 * the sandbox-creation loading screen, so the user's terminal never streams
 * setup.sh output. setup.sh in OPENERAL_SETUP_ONLY mode brings up everything
 * (DB migrations, workspace seed, openeral-bash daemon, openclaw onboard,
 * gateway + readiness, plugin/compile caches) and exits without launching the
 * TUI; the terminal's .bashrc fast path then sees a healthy gateway and execs
 * the TUI directly, painting only the agent UI.
 *
 * Idempotent + best-effort: skips instantly when the gateway is already
 * healthy (workspace reopen), and on failure the .bashrc block still falls
 * back to running `openeral` interactively — the previous behavior — so the
 * worst case is setup output in the terminal, never a broken session.
 *
 * @param {{ name: string, profile: string, env: NodeJS.ProcessEnv,
 *           onProgress?: Function }} args
 */
async function prewarmAgentRuntime({ name, profile, env, onProgress }) {
  if (profile !== "openeral-openclaw") return;
  onProgress?.({
    phase: "prewarm",
    message: "Preparing OpenClaw runtime (first run can take a few minutes)…",
  });
  const script = [
    // Already warm (reopen / repeated finalize): nothing to do.
    "if curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then",
    "  echo prewarm: gateway already healthy",
    "  exit 0",
    "fi",
    // A dead gateway process may still hold the port after a container
    // restart — clear it so setup.sh's own gateway start binds cleanly.
    "pkill -f 'openclaw gateway' 2>/dev/null || true",
    // setup.sh self-configures from the uploaded /sandbox files (db-url,
    // anthropic-api-key, openeral-input/presign.json) — written by create
    // and configureAgentLaunch before this runs.
    "export OPENERAL_AGENT=openclaw OPENERAL_SETUP_ONLY=1 HOME=/sandbox",
    "openeral > /tmp/openeral-setup.log 2>&1",
    "rc=$?",
    "tail -5 /tmp/openeral-setup.log",
    'exit "$rc"',
  ].join("\n");
  await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", sandboxRunScriptCmd(name, script)],
    { timeout: 600_000, env },
  )
    .then((r) => {
      if (r.exitCode === 0) {
        onProgress?.({ phase: "prewarm", message: "OpenClaw runtime ready." });
      } else {
        // Non-fatal: .bashrc falls back to interactive setup in the terminal.
        console.warn(
          "[prewarmAgentRuntime] setup-only run exited non-zero (non-fatal):",
          r.stdout?.slice(-500),
          r.stderr?.slice(-500),
        );
      }
    })
    .catch((e) => {
      console.warn(
        "[prewarmAgentRuntime] prewarm failed (non-fatal):",
        e.message,
      );
    });
}

/**
 * Read an already-uploaded StringCost presign URL back out of a sandbox, so a
 * reconnect reuses it instead of minting a fresh presign every launch. Returns
 * null when none is present.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>}
 */
async function readSandboxPresignUrl(name, env) {
  const cmd =
    `openshell sandbox exec --name ${shellQuote(name)} -- ` +
    `sh -c ${shellQuote("cat /sandbox/openeral-input/presign.json 2>/dev/null || true")}`;
  const r = await wslRun(["-d", DISTRO_NAME, "--", "bash", "-c", cmd], {
    timeout: 60_000,
    env,
  }).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  // Prefer JSON parse over regex scraping.
  try {
    const parsed = JSON.parse(r.stdout.trim());
    if (parsed && typeof parsed.url === "string") {
      return stringcostBaseUrlForAgent(parsed.url) ? parsed.url : null;
    }
  } catch {
    // fall through to regex
  }
  // Fallback: accept both http:// and https://.
  const m = r.stdout.match(/https?:\/\/[^"\s]+/);
  if (!m) return null;
  return stringcostBaseUrlForAgent(m[0]) ? m[0] : null;
}

/**
 * Finalize a Ready sandbox for launch: write the real ANTHROPIC_API_KEY file,
 * resolve the StringCost proxy base (reuse an uploaded presign, else mint one),
 * and configure the auto-launch + proxy env. Runs on BOTH fresh-create and
 * reconnect so reopening an existing workspace also gets auto-launch + metering.
 *
 * MUST be called only after the sandbox is Ready — every step shells out via
 * `openshell sandbox exec`, which refuses while the sandbox is Provisioning.
 * All steps are best-effort: failures degrade gracefully (no metering /
 * manual agent launch) rather than failing the session.
 *
 * @param {{ name: string, profile: string, env: NodeJS.ProcessEnv,
 *           onProgress?: Function }} args
 */
async function finalizeSandboxLaunch({ name, profile, env, onProgress }) {
  const anthropicApiKey = await getCredential("anthropicApiKey").catch(
    () => null,
  );

  // Resolve the StringCost presign before calling configureAgentLaunch so we
  // can pass both the API key and the presign URL into the single combined
  // exec that writes all files + the .bashrc block.
  let proxyBase = null;
  let mintedPresignUrl = null; // only set when we mint a new presign this session
  const stringcostApiKey = await getCredential("stringcostApiKey").catch(
    () => null,
  );
  if (stringcostApiKey) {
    // Reuse a presign already uploaded on a prior launch before minting anew.
    const existingUrl = await readSandboxPresignUrl(name, env);
    if (existingUrl) {
      proxyBase = stringcostBaseUrlForAgent(existingUrl);
    } else if (anthropicApiKey) {
      const agentLabel =
        profile === "openeral-openclaw" ? "openclaw" : "claude-code";
      const presignUrl = await createStringcostPresign({
        anthropicApiKey,
        stringcostApiKey,
        agentLabel,
      });
      if (presignUrl) {
        mintedPresignUrl = presignUrl;
        proxyBase = stringcostBaseUrlForAgent(presignUrl);
      }
    }
  }

  // Single combined exec: writes API key file, presign file (if newly minted),
  // and .bashrc block — all in one 180 s wslRun call, eliminating the 3×30 s
  // timeout cascade that previously caused all three writes to silently fail.
  await configureAgentLaunch({
    name,
    profile,
    proxyBase,
    env,
    onProgress,
    apiKey: anthropicApiKey ?? undefined,
    presignUrl: mintedPresignUrl ?? undefined,
  });
}

/**
 * Mint a permanent StringCost presign on the HOST, mirroring the request
 * `setup.sh` makes from inside the sandbox.
 *
 * Why on the host and not in the sandbox: setup.sh can only mint its own
 * presign when both STRINGCOST_API_KEY and a *real* ANTHROPIC_API_KEY are
 * present in the container env. Under OpenShell, provider-delivered keys
 * arrive as `openshell:resolve:env:*` placeholders that setup.sh cannot use
 * for an outbound presign call — so setup.sh explicitly expects a
 * host-created `presign.json` to be uploaded instead (it reads
 * `/sandbox/openeral-input/presign.json`). Host env vars forwarded via
 * WSLENV never reach the sandbox container, so the uploaded file is the
 * only reliable delivery channel.
 *
 * The presign routes the agent's `/v1/messages` calls through the StringCost
 * proxy for token + cost metering. `metadata.labels` is what StringCost's
 * vendor-portfolio classifier reads, so spend is attributed to the right
 * agent (`claude-code` or `openclaw`).
 *
 * Entirely best-effort: returns the presign URL string, or `null` on any
 * failure (network, non-2xx, malformed response, missing fetch). Callers
 * treat a null as "launch the sandbox without StringCost".
 *
 * @param {{ anthropicApiKey: string, stringcostApiKey: string, agentLabel: "claude-code" | "openclaw" }} args
 * @returns {Promise<string | null>}
 */
async function createStringcostPresign({
  anthropicApiKey,
  stringcostApiKey,
  agentLabel,
}) {
  if (typeof fetch !== "function") {
    console.warn(
      "[createOpenEralSandbox] global fetch unavailable — skipping StringCost presign",
    );
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    STRINGCOST_PRESIGN_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${STRINGCOST_API_BASE}/v1/presign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stringcostApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "anthropic",
        client_api_key: anthropicApiKey,
        path: ["/v1/messages"],
        // Permanent, unmetered presign — the StringCost proxy enforces the
        // cost_limit, and the sandbox reuses this presign across sessions.
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000,
        metadata: {
          source: "openwork-desktop",
          client: agentLabel,
          labels: ["openeral", agentLabel],
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `[createOpenEralSandbox] StringCost presign failed (${res.status}): ${detail.slice(0, 300)}`,
      );
      return null;
    }
    const data = await res.json().catch(() => null);
    const url = data && typeof data.url === "string" ? data.url : null;
    if (!url) {
      console.warn(
        "[createOpenEralSandbox] StringCost presign returned no URL",
      );
      return null;
    }
    return url;
  } catch (err) {
    console.warn(
      `[createOpenEralSandbox] StringCost presign error: ${err?.message || String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create (or resume into) an OpenEral sandbox. Sandbox naming is stable
 * per-workspace — re-running with the same name on the same Postgres
 * is OpenEral's whole portability story.
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {"openeral-claude"|"openeral-openclaw"} opts.profile
 * @param {(evt: {phase: string, message: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.skipImagePull]  Skip the docker pull (testing)
 * @param {number} [opts.createTimeoutMs]
 */
export async function createOpenEralSandbox(opts) {
  const { name, profile, onProgress } = opts;
  // OPENWORK_SANDBOX_SKIP_PULL=1 skips the docker pull (for locally-built /
  // local-only image tags that can't be resolved against a registry).
  const skipImagePull =
    opts.skipImagePull === true ||
    process.env.OPENWORK_SANDBOX_SKIP_PULL === "1";
  if (!name) throw new Error("createOpenEralSandbox: name is required");
  if (!profile) throw new Error("createOpenEralSandbox: profile is required");

  const imageRef = imageForProfile(profile);

  // Pin the WSL distro for the app's lifetime BEFORE any sandbox work: without
  // a persistent wsl.exe client, WSL starts tearing the distro down between
  // our short-lived commands, killing the OpenShell gateway mid-create and
  // leaving sandboxes flapping (see ensureWslKeepalive in wsl.mjs).
  ensureWslKeepalive();

  // openshell shells out to scp/ssh for create --upload AND for exec/connect.
  // Make sure they exist before any sandbox op so we never dead-end at the
  // opaque "No such file or directory (os error 2)" — this also covers the
  // reconnect path below, which connects/execs into the existing sandbox.
  await ensureOpensshClient(onProgress);

  // Short-circuit if the sandbox already exists (workspace reopen).
  // Wait for it to reach Ready state before returning so the subsequent
  // PTY exec doesn't fail with "phase: Provisioning".
  //
  // If the existing sandbox is in an error or stuck-provisioning state,
  // auto-delete it and fall through to fresh creation below — this means
  // the user never has to manually click "Delete & start fresh" just to
  // recover from a broken container.  /home/agent data is in PostgreSQL
  // and survives the container deletion.
  if (await sandboxExists(name)) {
    onProgress?.({
      phase: "exists",
      message: `Sandbox ${name} already exists; checking state…`,
    });
    let existingReady = false;
    try {
      await waitForSandboxReady(name, {
        onProgress: (evt) =>
          onProgress?.({ phase: evt.phase, message: evt.message }),
      });
      existingReady = true;
    } catch (waitErr) {
      const waitMsg = waitErr?.message ?? "";
      if (/SANDBOX_DELETED:/i.test(waitMsg)) {
        // Sandbox finished deleting while we were polling — create fresh below.
        // No delete call needed (it's already gone).
        onProgress?.({
          phase: "auto-recreate",
          message: `Previous sandbox was deleted; creating a fresh one…`,
        });
        // existingReady stays false → fall through to full creation below.
      } else if (/is in error state|STUCK_PROVISIONING:/i.test(waitMsg)) {
        // Broken container — silently delete so we can create a fresh one.
        onProgress?.({
          phase: "auto-recreate",
          message: `Sandbox ${name} is broken (${/STUCK/.test(waitMsg) ? "stuck in Provisioning" : "error state"}); auto-deleting for fresh creation…`,
        });
        await deleteOpenEralSandbox(name).catch((e) =>
          console.warn(
            "[createOpenEralSandbox] auto-delete (broken existing):",
            e.message,
          ),
        );
        // existingReady stays false → fall through to full creation below.
      } else {
        throw waitErr;
      }
    }
    if (existingReady) {
      // Reopening an existing sandbox: (re)apply auto-launch + StringCost env so
      // the agent starts directly and meters even on reconnect. env isn't built
      // until after credential validation below, so use process.env here — the
      // exec just writes files with values baked into the script (no WSLENV).
      await finalizeSandboxLaunch({
        name,
        profile,
        env: process.env,
        onProgress,
      });
      await prewarmAgentRuntime({
        name,
        profile,
        env: process.env,
        onProgress,
      });
      return { name, profile, imageRef, existed: true };
    }
    // Fall through to create a fresh sandbox.
  }

  // Validate credentials.
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }

  // Image pull (~1.5 GB on first run for :just-bash). Skipped for local
  // images (OPENWORK_SANDBOX_SKIP_PULL=1) so a `docker build`-produced tag
  // isn't clobbered by a registry fetch that would fail or overwrite it.
  if (!skipImagePull) {
    onProgress?.({ phase: "pull", message: `Pulling ${imageRef}...` });
    await pullImage(imageRef, {
      onProgress: (text) =>
        onProgress?.({ phase: "pull", message: text.trimEnd() }),
    });
  }

  // Forward credentials into the Linux side of WSL via WSLENV.
  // ANTHROPIC_API_KEY is always forwarded so --auto-providers can
  // auto-create the `claude` provider. For openclaw, also forward
  // OPENERAL_AGENT=openclaw so the openeral wrapper picks the right
  // agent at runtime.
  //
  // NOTE: STRINGCOST_API_KEY is deliberately NOT forwarded here. WSLENV only
  // makes a value visible to the openshell CLI in the WSL distro — it never
  // reaches the sandbox container. StringCost is delivered the way the agent
  // actually consumes it: finalizeSandboxLaunch (post-Ready) mints a presign
  // and writes ANTHROPIC_BASE_URL into the agent's launch env.
  const forwarded = { ANTHROPIC_API_KEY: anthropicApiKey };
  if (profile === "openeral-openclaw") {
    forwarded.OPENERAL_AGENT = "openclaw";
  }
  const env = buildWslEnvForwarding(forwarded);

  // Staging the DATABASE_URL file AND running `openshell sandbox
  // create` happen in ONE bash session — two separate wsl.exe calls
  // can land in different /tmp namespaces on some banker distros, so
  // openshell would see ENOENT trying to upload a file that "existed"
  // from our staging call's perspective. One bash subshell keeps /tmp
  // consistent for both the cat write and the --upload read.
  //
  // We deliberately do NOT pass `-- openeral` as the trailing command:
  // `openshell sandbox create` BLOCKS until the trailing command exits,
  // but `openeral` launches Claude Code (an interactive REPL that
  // never exits), and we have no TTY here (wslRun is piped). That used
  // to deadlock until ssh timed out with `exit status 1`. Instead we
  // run `-- /bin/true` to provision the sandbox, return immediately,
  // and rely on `sandbox exec --tty -- openeral` from openeral-pty.mjs
  // / openeral-terminal.mjs to launch the REPL inside a real PTY.
  //
  // Note: openshell's --upload (and connect/exec/download) shells out
  // to `ssh`/`scp` locally. The rootfs Dockerfile MUST include
  // openssh-client or every sandbox operation fails with a cryptic
  // "Error: × No such file or directory (os error 2)" from the failed
  // exec.
  const dbPath = `/tmp/openeral-db-url-${randomUUID()}`;
  // Keep the create command simple — use `-- /bin/true` so openshell
  // returns as soon as provisioning is done (no trailing command to race
  // against the --auto-providers setup).
  //
  // openshell CLI 0.0.42 has a race: when --auto-providers is combined
  // with a non-trivial `-- CMD`, the provider finalisation and the CMD
  // exec both touch the gateway concurrently and one of them returns
  // gRPC NotFound, aborting the create with exit 1.  Using `-- /bin/true`
  // (exits in ~0 ms) avoids the window where the race can manifest.
  //
  // ANTHROPIC_API_KEY delivery for setup.sh's StringCost presign step:
  // we write /sandbox/anthropic-api-key via a separate `sandbox exec`
  // call AFTER create, so there is no quoting complexity inside the
  // create command.  setup.sh falls back gracefully if the exec fails
  // (it skips the presign step when ANTHROPIC_API_KEY is a placeholder).
  // NOTE: do NOT use `exec openshell sandbox create ...` here.
  // `exec` replaces the bash process, which means the EXIT trap set
  // below never fires and the temp DB-URL file leaks in /tmp forever.
  // Running openshell as a regular child (no exec) lets bash honour
  // the trap on exit — whether the create succeeds or fails.
  const script = [
    "set -e",
    "umask 077",
    // DATABASE_URL is piped via stdin — never touches the command line.
    `cat > ${dbPath}`,
    `chmod 600 ${dbPath}`,
    // Staging file is removed on exit whether create succeeds or fails.
    `trap 'rm -f ${dbPath}' EXIT`,
    `openshell sandbox create --no-tty ` +
      `--name ${shellQuote(name)} ` +
      `--from ${shellQuote(imageRef)} ` +
      `--upload ${dbPath}:/sandbox/db-url ` +
      `--provider claude --auto-providers ` +
      `-- /bin/true`,
  ].join("\n");

  onProgress?.({ phase: "create", message: `Creating sandbox ${name}…` });
  let r;
  try {
    r = await wslRun(["-d", DISTRO_NAME, "--", "bash", "-c", script], {
      timeout: opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
      env,
      stdin: databaseUrl,
    });
  } catch (err) {
    if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
      throw new Error(
        `openshell sandbox create timed out after 3 minutes. ` +
          `The OpenShell gateway or Docker daemon is not responding. ` +
          `Open Settings \u2192 Sandbox \u2192 OpenShell health and click Restart Gateway, then retry.`,
      );
    }
    throw err;
  }
  if (r.exitCode !== 0) {
    const output = (r.stderr || r.stdout).trim();
    // openshell exits 1 with "already exists" when sandboxExists() returned
    // a false-negative (e.g. unexpected JSON shape from sandbox list). Treat
    // this as a successful reconnect instead of a hard failure.
    if (/already exists/i.test(output)) {
      onProgress?.({
        phase: "exists",
        message: `Sandbox ${name} already exists; reconnecting.`,
      });
      return { name, profile, imageRef, existed: true };
    }
    // openshell CLI 0.0.42 race: the gRPC stream sometimes closes with
    // "NotFound: sandbox not found" even though the gateway already registered
    // the sandbox and started provisioning. Check the list before treating
    // this as a hard failure — if the sandbox is there, wait for Ready.
    if (/not.?found|sandbox not found/i.test(output)) {
      const checkExists = await sandboxExists(name).catch(() => false);
      if (checkExists) {
        console.warn(
          `[createOpenEralSandbox] create exited 1 with NotFound but ${name} found in list; treating as provisioning.`,
        );
        onProgress?.({
          phase: "waiting",
          message: `Sandbox ${name} is provisioning; waiting for Ready state…`,
        });
        try {
          await waitForSandboxReady(name, {
            timeoutMs: 5 * 60_000,
            onProgress: (evt) =>
              onProgress?.({ phase: evt.phase, message: evt.message }),
          });
          await finalizeSandboxLaunch({ name, profile, env, onProgress });
          await prewarmAgentRuntime({ name, profile, env, onProgress });
          return { name, profile, imageRef, existed: false };
        } catch (waitErr) {
          const waitMsg = waitErr?.message ?? "";
          if (/is in error state|STUCK_PROVISIONING:/i.test(waitMsg)) {
            // The post-create provisioning failed — auto-delete so the next
            // "Launch session" click starts from a clean slate.
            onProgress?.({
              phase: "auto-recreate",
              message: `Sandbox ${name} failed to provision; auto-deleting for next attempt…`,
            });
            await deleteOpenEralSandbox(name).catch((e) =>
              console.warn(
                "[createOpenEralSandbox] auto-delete (NotFound path, broken):",
                e.message,
              ),
            );
            throw new Error(
              `Sandbox ${name} failed to provision and was automatically deleted. ` +
                `Click "Launch session" to create a fresh sandbox.`,
            );
          }
          throw waitErr;
        }
      }
    }
    const cli = await getCliInfo().catch(() => null);
    const versionTag = cli?.version ? ` [CLI ${cli.version}]` : "";
    throw new Error(
      `openshell sandbox create failed (exit ${r.exitCode})${versionTag}: ` +
        `${output || "(no output)"}`,
    );
  }
  // `sandbox create -- /bin/true` exits 0 as soon as the gateway REGISTERS
  // the sandbox, but setup.sh inside the container may still be running.
  // Wait for Ready before returning so the PTY never connects to a
  // still-Provisioning sandbox.
  onProgress?.({
    phase: "waiting",
    message: `Sandbox ${name} created; waiting for Ready state…`,
  });
  try {
    await waitForSandboxReady(name, {
      timeoutMs: 5 * 60_000,
      onProgress: (evt) =>
        onProgress?.({ phase: evt.phase, message: evt.message }),
    });
  } catch (waitErr) {
    const waitMsg = waitErr?.message ?? "";
    if (/is in error state|STUCK_PROVISIONING:/i.test(waitMsg)) {
      // The freshly-created sandbox failed during setup — auto-delete so the
      // next "Launch session" click gets a clean start. If Docker or the image
      // is the root cause, the user will see this error repeatedly and should
      // restart the gateway from Settings → Sandbox → OpenShell health.
      onProgress?.({
        phase: "auto-recreate",
        message: `New sandbox ${name} failed to reach Ready state; auto-deleting…`,
      });
      await deleteOpenEralSandbox(name).catch((e) =>
        console.warn(
          "[createOpenEralSandbox] auto-delete (fresh create broken):",
          e.message,
        ),
      );
      throw new Error(
        `New sandbox ${name} failed to reach Ready state and was automatically deleted. ` +
          `Click "Launch session" to try again. ` +
          `If this keeps happening, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
      );
    }
    throw waitErr;
  }
  // Now that the sandbox is Ready, write the API key, resolve the StringCost
  // presign, and configure auto-launch + proxy env. Doing this AFTER Ready is
  // essential — `openshell sandbox exec` refuses while the sandbox is still
  // Provisioning, which silently skipped these steps when they ran pre-Ready.
  await finalizeSandboxLaunch({ name, profile, env, onProgress });
  await prewarmAgentRuntime({ name, profile, env, onProgress });
  onProgress?.({ phase: "ready", message: `Sandbox ${name} ready.` });
  return { name, profile, imageRef, existed: false };
}

export async function deleteOpenEralSandbox(name) {
  if (!name) throw new Error("deleteOpenEralSandbox: name is required");
  // `openshell sandbox delete` does NOT support --force; passing it causes
  // "unexpected argument '--force' found" and exit 1. Use bash timeout for
  // the same inner-timeout safety net we apply to list/create calls.
  let r;
  try {
    r = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--",
        "bash",
        "-c",
        `timeout 20 openshell sandbox delete ${shellQuote(name)}`,
      ],
      { timeout: 30_000 },
    );
  } catch (err) {
    if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
      throw new Error(
        "openshell sandbox delete timed out. The OpenShell gateway may be unresponsive. " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw err;
  }
  if (r.exitCode !== 0) {
    const output = (r.stderr || r.stdout).trim();
    // 124 = bash timeout(1) hit the inner timer — gateway is unresponsive.
    if (r.exitCode === 124) {
      throw new Error(
        "openshell sandbox delete timed out (gateway unresponsive). " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw new Error(
      `openshell sandbox delete failed: ${output || "(no output)"}`,
    );
  }
  return r;
}

/**
 * Live database-reachability probe. Runs psql via a transient
 * `postgres:16-alpine` container inside the distro. Pulls lazily on
 * first call (~6 MB). Returns `{ ok: true, reachable: true }` on
 * successful `SELECT 1`, throws otherwise.
 */
export async function probeDatabaseUrl({
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const url = await getCredential("databaseUrl");
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  // Same DOCKER_CONFIG sidestep as pullImage — postgres:16-alpine is
  // public and we don't want Docker Desktop's credential helper in the
  // path here either.
  const r = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql ${shellQuote(url)} -tAc 'select 1'`,
    ],
    { timeout: timeoutMs },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `Could not reach PostgreSQL: ${(r.stderr || r.stdout).trim() || "unknown error"}`,
    );
  }
  return { ok: true, reachable: true };
}

export const __testing = {
  IMAGE_BY_PROFILE,
  buildWslEnvForwarding,
  shellQuote,
  createStringcostPresign,
  stringcostBaseUrlForAgent,
  sandboxRunScriptCmd,
  deriveClaudeSessionUuid,
  sanitizeOpenclawSessionKey,
  resolveAgentSessionValue,
  SESSION_MARKER_PATH,
  buildLaunchBlock,
  configureAgentLaunch,
  prewarmAgentRuntime,
};
