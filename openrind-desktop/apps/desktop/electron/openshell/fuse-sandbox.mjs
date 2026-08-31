import { createHash, randomUUID } from "node:crypto";

import { getCredential } from "./openrind-shell-credentials.mjs";
import { createSandboxProvisioningCoordinator } from "./sandbox-provisioning-coordinator.mjs";
import {
  ensureFuseRuntime,
  buildFuseCliCommand,
  buildFuseWslEnv,
  FUSE_IMAGE,
  FUSE_IMAGE_PULL_POLICY,
  runFuseOpenShell,
} from "./fuse-runtime.mjs";
import { DISTRO_NAME, ensureWslKeepalive, wslRun, wslSpawn } from "./wsl.mjs";

const IMAGE_CONTRACT = "fuse-openclaw-identity-v22";
const SESSION_MARKER = "/var/lib/openrind-shell/runtime/desktop-session";
const CLAUDE_HOME_MOUNT = "/sandbox/claude-home";
const CLAUDE_HOME_VOLUME_PREFIX = "openrind-claude-home-";
const OPENCLAW_HOME_MOUNT = "/sandbox/openclaw-home";
const OPENCLAW_HOME_VOLUME_PREFIX = "openrind-openclaw-home-";
const CLAUDE_SESSION_NAMESPACE = "6f9b1e2a-0c3d-4b7a-9e21-8a4c1d5f7b30";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const sandboxProvisioning = createSandboxProvisioningCoordinator();

const AGENTS = {
  "openrind-shell-claude": {
    id: "claude",
    label: "Claude Code",
    homeMount: CLAUDE_HOME_MOUNT,
    volumePrefix: CLAUDE_HOME_VOLUME_PREFIX,
  },
  "openrind-shell-openclaw": {
    id: "openclaw",
    label: "OpenClaw",
    homeMount: OPENCLAW_HOME_MOUNT,
    volumePrefix: OPENCLAW_HOME_VOLUME_PREFIX,
  },
};

function agentForProfile(profile) {
  const agent = AGENTS[profile];
  if (!agent) throw new Error(`Unsupported Openrind Shell FUSE profile: ${profile}`);
  return agent;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSandboxRows(stdout) {
  const parsed = parseJson(stdout, []);
  const rows = Array.isArray(parsed)
    ? parsed
    : ["sandboxes", "items", "data", "results"]
        .map((key) => parsed?.[key])
        .find(Array.isArray) ?? [];
  return rows
    .map((row) =>
      typeof row === "string"
        ? { name: row, created: "", phase: "Unknown" }
        : {
            name: String(row?.name ?? ""),
            created: String(row?.created_at ?? row?.created ?? ""),
            phase: String(row?.phase ?? row?.status ?? "Unknown"),
          },
    )
    .filter((row) => row.name);
}

function normalizeProviderRows(stdout) {
  const parsed = parseJson(stdout, []);
  const rows = Array.isArray(parsed)
    ? parsed
    : ["providers", "items", "data", "results"]
        .map((key) => parsed?.[key])
        .find(Array.isArray) ?? [];
  return rows
    .map((row) => ({
      name: String(row?.name ?? ""),
      type: String(row?.type ?? ""),
    }))
    .filter((row) => row.name);
}

async function ensureClaudeProvider(anthropicApiKey, onProgress) {
  const env = buildFuseWslEnv({ ANTHROPIC_API_KEY: anthropicApiKey });
  const listed = await runFuseOpenShell(
    ["provider", "list", "-o", "json"],
    { ensure: false, env, timeout: 20_000 },
  );
  if (listed.exitCode !== 0) {
    throw new Error(
      `OpenShell Claude provider lookup failed: ${(listed.stderr || listed.stdout).trim() || `exit ${listed.exitCode}`}`,
    );
  }

  const current = normalizeProviderRows(listed.stdout).find((row) => row.name === "claude");
  let replaced = false;
  if (current && current.type !== "claude-code") {
    onProgress?.({
      phase: "provider",
      message: "Replacing the incompatible Claude provider with the README claude-code profile...",
    });
    const removed = await runFuseOpenShell(
      ["provider", "delete", "claude"],
      { ensure: false, env, timeout: 20_000 },
    );
    if (removed.exitCode !== 0) {
      throw new Error(
        `OpenShell could not replace the incompatible Claude provider: ${(removed.stderr || removed.stdout).trim() || `exit ${removed.exitCode}`}`,
      );
    }
    replaced = true;
  }

  const command = current && !replaced
    ? ["provider", "update", "claude", "--credential", "ANTHROPIC_API_KEY"]
    : [
        "provider",
        "create",
        "--name",
        "claude",
        "--type",
        "claude-code",
        "--credential",
        "ANTHROPIC_API_KEY",
      ];
  onProgress?.({
    phase: "provider",
    message: current && !replaced
      ? "Refreshing the Anthropic credential..."
      : "Creating the Claude provider...",
  });
  const configured = await runFuseOpenShell(command, {
    ensure: false,
    env,
    timeout: 20_000,
  });
  if (configured.exitCode !== 0) {
    throw new Error(
      `OpenShell Claude provider configuration failed: ${(configured.stderr || configured.stdout).trim() || `exit ${configured.exitCode}`}`,
    );
  }
  return { replaced };
}

export async function listSandboxes(options = {}) {
  if (options.ensure !== false) await ensureFuseRuntime();
  const result = await runFuseOpenShell(
    ["sandbox", "list", "-o", "json"],
    { ensure: false, timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell sandbox list failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return normalizeSandboxRows(result.stdout);
}

export async function sandboxExists(name) {
  if (!name) return false;
  return (await listSandboxes()).some((sandbox) => sandbox.name === name);
}

async function inspectFuseImage() {
  return wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "docker",
      "image",
      "inspect",
      FUSE_IMAGE,
      "--format",
      `{{ index .Config.Labels "com.openrind.desktop.fuse-contract" }}`,
    ],
    { timeout: 20_000 },
  );
}

async function requireFuseImage(onProgress) {
  let inspect = await inspectFuseImage();
  if (
    (inspect.exitCode !== 0 || inspect.stdout.trim() !== IMAGE_CONTRACT) &&
    FUSE_IMAGE_PULL_POLICY.toLowerCase() !== "never"
  ) {
    onProgress?.({
      phase: "image",
      message: `Downloading the current Openrind Shell FUSE image (${FUSE_IMAGE})...`,
    });
    const pulled = await wslRun(
      ["-d", DISTRO_NAME, "--", "docker", "pull", FUSE_IMAGE],
      { timeout: 10 * 60_000 },
    );
    if (pulled.exitCode !== 0) {
      throw new Error(
        `Could not download the Openrind Shell FUSE image: ${(pulled.stderr || pulled.stdout).trim() || `exit ${pulled.exitCode}`}`,
      );
    }
    inspect = await inspectFuseImage();
  }
  if (inspect.exitCode !== 0) {
    throw new Error(
      FUSE_IMAGE_PULL_POLICY.toLowerCase() === "never"
        ? `The README FUSE image ${FUSE_IMAGE} is not present in Openrind Desktop's Docker daemon. Build Dockerfile.openrind-shell with that tag, then retry.`
        : `The Openrind Shell FUSE image ${FUSE_IMAGE} is unavailable in Openrind Desktop's Docker daemon.`,
    );
  }
  if (inspect.stdout.trim() !== IMAGE_CONTRACT) {
    throw new Error(
      FUSE_IMAGE_PULL_POLICY.toLowerCase() === "never"
        ? `The local FUSE image ${FUSE_IMAGE} is outdated (expected contract ${IMAGE_CONTRACT}). Rebuild Dockerfile.openrind-shell, then retry.`
        : `The published FUSE image ${FUSE_IMAGE} does not provide the required desktop contract ${IMAGE_CONTRACT}.`,
    );
  }
}

export function resolveClaudeHomeVolumeName(sandboxName) {
  return resolveAgentHomeVolumeName(sandboxName, AGENTS["openrind-shell-claude"]);
}

export function resolveOpenClawHomeVolumeName(sandboxName) {
  return resolveAgentHomeVolumeName(sandboxName, AGENTS["openrind-shell-openclaw"]);
}

function resolveAgentHomeVolumeName(sandboxName, agent) {
  const value = String(sandboxName ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`The sandbox name cannot be used for persistent ${agent.label} storage.`);
  }
  return `${agent.volumePrefix}${value}`;
}

async function ensureAgentHomeVolume(sandboxName, workspaceId, agent) {
  const volumeName = resolveAgentHomeVolumeName(sandboxName, agent);
  const result = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "docker",
      "volume",
      "create",
      "--label",
      `com.openrind.desktop.agent-home=${agent.id}`,
      "--label",
      `com.openrind.desktop.workspace=${workspaceId}`,
      volumeName,
    ],
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not prepare persistent ${agent.label} storage: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return volumeName;
}

async function deleteIfPresent(name) {
  const result = await runFuseOpenShell(
    ["sandbox", "delete", name],
    { ensure: false, timeout: 60_000 },
  );
  if (result.exitCode !== 0 && !/not found|does not exist/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(
      `OpenShell sandbox delete failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function collectFailedSandboxDiagnostics(name) {
  const sections = [];
  const logs = await runFuseOpenShell(
    ["logs", name, "--since", "5m", "--source", "all"],
    { ensure: false, timeout: 15_000 },
  ).catch(() => null);
  const logText = (logs?.stdout || logs?.stderr || "").trim();
  if (logText) sections.push(`sandbox logs:\n${logText}`);

  const health = await runFuseOpenShell(
    ["sandbox", "exec", "-n", name, "--", "openrind-shell-fused", "health"],
    { ensure: false, timeout: 10_000 },
  ).catch(() => null);
  const healthText = (health?.stdout || health?.stderr || "").trim();
  if (healthText) sections.push(`FUSE health:\n${healthText}`);
  return sections.join("\n\n");
}

async function existingFuseSandboxIsWritable(name, agent) {
  const result = await runFuseOpenShell(
    [
      "sandbox",
      "exec",
      "-n",
      name,
      "--",
      "sh",
      "-c",
      `test "$(cat /opt/openrind-shell/desktop-contract 2>/dev/null)" = ${shellQuote(IMAGE_CONTRACT)} && test -x /opt/openrind-shell/openrind-pty-bridge.py && test -r /var/lib/openrind-shell/runtime/session.env && . /var/lib/openrind-shell/runtime/session.env && test "\${OPENRIND_SHELL_AGENT:-}" = ${shellQuote(agent.id)} && exec openrind-shell-fused health`,
    ],
    { ensure: false, timeout: 15_000 },
  );
  if (result.exitCode !== 0) return false;
  return parseJson(result.stdout)?.state === "writable";
}

function streamCreate({ script, env, databaseUrl, timeoutMs, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = wslSpawn(
      ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
      { env },
    );
    let stdout = "";
    let stderr = "";
    let pending = "";
    let finished = false;

    const add = (target, chunk) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + text).slice(-MAX_CAPTURE_BYTES);
      else stderr = (stderr + text).slice(-MAX_CAPTURE_BYTES);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
        if (clean) onProgress?.({ phase: "create", message: clean });
      }
    };
    child.stdout.on("data", (chunk) => add("stdout", chunk));
    child.stderr.on("data", (chunk) => add("stderr", chunk));

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`OpenShell FUSE sandbox creation timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (pending.trim()) onProgress?.({ phase: "create", message: pending.trim() });
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(databaseUrl);
  });
}

/**
 * README-exact FUSE provisioning: one create call owns Ready, the database
 * upload, one-shot initialization, and its exit status. There are no parallel
 * uploads, polling loops, or a second setup pass.
 */
async function provisionOpenrindShellSandbox(options) {
  const { name, profile, onProgress } = options ?? {};
  const workspaceId = String(options?.workspaceId ?? name ?? "").trim();
  if (!name || !workspaceId) throw new Error("A sandbox name and workspace id are required.");
  const agent = agentForProfile(profile);

  ensureWslKeepalive();
  onProgress?.({ phase: "control-plane", message: "Checking the paired OpenShell FUSE gateway…" });
  await ensureFuseRuntime({ onProgress });

  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Configure the PostgreSQL session-mode URL in Settings → Environment.");
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required. Configure it in Settings > Environment.");
  }
  const provider = await ensureClaudeProvider(anthropicApiKey, onProgress);
  const replaced = Boolean(provider?.replaced);
  await requireFuseImage(onProgress);
  const agentHomeVolume = await ensureAgentHomeVolume(name, workspaceId, agent);
  const driverConfig = JSON.stringify({
    docker: {
      mounts: [
        {
          type: "volume",
          source: agentHomeVolume,
          target: agent.homeMount,
          read_only: false,
        },
      ],
    },
  });
  const existing = (await listSandboxes({ ensure: false })).find((sandbox) => sandbox.name === name);
  if (existing) {
    if (
      !replaced &&
      /^ready$/i.test(existing.phase) &&
      (await existingFuseSandboxIsWritable(name, agent))
    ) {
      onProgress?.({ phase: "ready", message: `FUSE workspace ${name} is ready.` });
      return { name, profile, imageRef: FUSE_IMAGE, existed: true };
    }
    onProgress?.({ phase: "recreate", message: `Replacing the unhealthy sandbox container; the PostgreSQL FUSE workspace is retained…` });
    await deleteIfPresent(name);
  }

  // This preserves the README one-shot create contract for testing:
  // "  --fuse"
  // "  --provider claude"
  // "  --auto-providers"
  // "  --no-tty"
  // "  -- openrind-shell-init"

  const tempName = `openrind-shell-db-url-${randomUUID()}`;
  const dbPath = `/tmp/${tempName}`;
  const createCmd = buildFuseCliCommand([
    "sandbox",
    "create",
    "--name",
    name,
    "--from",
    FUSE_IMAGE,
    "--fuse",
    "--driver-config-json",
    driverConfig,
    "--upload",
    `${dbPath}:/sandbox/db-url`,
    "--provider",
    "claude",
    "--auto-providers",
    "--env",
    `OPENRIND_SHELL_WORKSPACE_ID=${workspaceId}`,
    "--env",
    `OPENRIND_SHELL_AGENT=${agent.id}`,
    "--no-tty",
    "--",
    "openrind-shell-init",
  ]);
  const create = [
    "set -euo pipefail",
    "umask 077",
    `cat > ${shellQuote(dbPath)}`,
    `chmod 600 ${shellQuote(dbPath)}`,
    `trap 'rm -f ${dbPath}' EXIT`,
    createCmd,
  ].join("\n");

  onProgress?.({ phase: "create", message: `Creating ${name}, mounting /sandbox/work, and initializing it once…` });
  const result = await streamCreate({
    script: create,
    env: buildFuseWslEnv({ ANTHROPIC_API_KEY: anthropicApiKey }),
    databaseUrl,
    timeoutMs: options.createTimeoutMs ?? 5 * 60_000,
    onProgress,
  });
  if (result.exitCode !== 0) {
    const diagnostics = await collectFailedSandboxDiagnostics(name);
    await deleteIfPresent(name).catch(() => {});
    throw new Error(
      `OpenShell FUSE sandbox creation failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim() || "no diagnostics"}${diagnostics ? `\n\n${diagnostics}` : ""}`,
    );
  }

  onProgress?.({ phase: "ready", message: `FUSE workspace ${name} is initialized; starting ${agent.label}…` });
  return { name, profile, imageRef: FUSE_IMAGE, existed: false };
}

/**
 * Provisioning is deliberately single-flight per sandbox. The promise lives in
 * this main-process module, so closing Settings or switching sessions only
 * detaches the renderer; it cannot cancel or restart the underlying FUSE create.
 */
export function createOpenrindShellSandbox(options) {
  const name = String(options?.name ?? "").trim();
  const profile = String(options?.profile ?? "").trim();
  return sandboxProvisioning.run({
    sandboxName: name,
    profile,
    onProgress: options?.onProgress,
    provision: (onProgress) =>
      provisionOpenrindShellSandbox({ ...options, name, profile, onProgress }),
  });
}

export async function deleteOpenrindShellSandbox(name) {
  if (!name) throw new Error("A sandbox name is required.");
  await ensureFuseRuntime();
  return runFuseOpenShell(["sandbox", "delete", name], { ensure: false, timeout: 60_000 });
}

function assertWorkspaceFilename(filename) {
  const value = String(filename ?? "").trim();
  if (!value || /[/\\]/.test(value) || value === "." || value === "..") {
    throw new Error("Invalid workspace filename.");
  }
  return value;
}

export async function uploadWorkspaceFile(name, filename, base64Data) {
  if (!name) throw new Error("A sandbox name is required.");
  const safeFilename = assertWorkspaceFilename(filename);
  const encoded = String(base64Data ?? "");
  await ensureFuseRuntime();
  const tempPath = `/tmp/openrind-upload-${randomUUID()}`;
  const destinationDirectory = "/sandbox/work/inbox";
  const destination = `${destinationDirectory}/${safeFilename}`;
  const mkdirCmd = buildFuseCliCommand([
    "sandbox",
    "exec",
    "-n",
    name,
    "--",
    "mkdir",
    "-p",
    destinationDirectory,
  ]);
  const uploadCmd = buildFuseCliCommand([
    "sandbox",
    "upload",
    name,
    tempPath,
    destination,
  ]);
  const script = `set -euo pipefail
umask 077
trap 'rm -f ${tempPath}' EXIT
base64 -d > ${shellQuote(tempPath)}
${mkdirCmd}
${uploadCmd}`;
  const result = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
    { stdin: encoded, timeout: 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell FUSE workspace upload failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { path: destination };
}

export async function listWorkspaceFiles(name) {
  if (!name) throw new Error("A sandbox name is required.");
  const directory = "/sandbox/work/inbox";
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(directory)};
let entries = [];
try {
  entries = fs.readdirSync(directory, { withFileTypes: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const files = entries.flatMap((entry) => {
  if (!entry.isFile()) return [];
  const absolute = path.join(directory, entry.name);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) return [];
  return [{
    name: entry.name,
    path: absolute,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  }];
});
files.sort((left, right) => left.name.localeCompare(right.name));
process.stdout.write(JSON.stringify(files));`;
  const result = await runFuseOpenShell(
    ["sandbox", "exec", "-n", name, "--", "/usr/bin/node", "-e", script],
    { ensure: true, timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell FUSE workspace listing failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  const files = parseJson(result.stdout);
  if (!Array.isArray(files)) {
    throw new Error("OpenShell FUSE workspace returned an invalid file listing.");
  }
  return files
    .map((file) => ({
      name: String(file?.name ?? ""),
      path: String(file?.path ?? ""),
      size: Number(file?.size ?? 0),
      modifiedAt: Number(file?.modifiedAt ?? 0),
    }))
    .filter(
      (file) =>
        file.name &&
        !/[/\\]/.test(file.name) &&
        file.path === `${directory}/${file.name}` &&
        Number.isFinite(file.size) &&
        file.size >= 0 &&
        Number.isFinite(file.modifiedAt),
    );
}

export async function downloadWorkspaceFile(name, filename, localDestination) {
  if (!name) throw new Error("A sandbox name is required.");
  const safeFilename = assertWorkspaceFilename(filename);
  const destination = String(localDestination ?? "").trim();
  if (!destination) {
    throw new Error("A local download destination is required.");
  }

  // OpenShell accepts absolute sources that remain inside the sandbox's
  // canonical working directory and enforces that they cannot escape it.
  const source = `/sandbox/work/inbox/${safeFilename}`;
  const result = await runFuseOpenShell(
    ["sandbox", "download", name, source, destination],
    { ensure: true, timeout: 5 * 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell FUSE workspace download failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { path: destination };
}

export async function deleteWorkspaceFile(name, filename) {
  if (!name) throw new Error("A sandbox name is required.");
  const safeFilename = assertWorkspaceFilename(filename);
  const destination = `/sandbox/work/inbox/${safeFilename}`;
  const result = await runFuseOpenShell(
    ["sandbox", "exec", "-n", name, "--", "rm", "-f", destination],
    { ensure: true, timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell FUSE workspace delete failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { path: destination };
}

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function resolveAgentSessionValue(profile, sessionId) {
  const value = String(sessionId ?? "").trim();
  if (!value) return "default";
  if (profile === "openrind-shell-openclaw") {
    const normalized = value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return normalized || "default";
  }
  if (profile !== "openrind-shell-claude") {
    throw new Error(`Unsupported Openrind Shell FUSE profile: ${profile}`);
  }
  const digest = createHash("sha1")
    .update(uuidToBytes(CLAUDE_SESSION_NAMESPACE))
    .update(Buffer.from(value, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

export async function writeCurrentSessionMarker(name, value) {
  const safe = value || "default";
  const script = `umask 077; printf %s ${shellQuote(safe)} > ${shellQuote(SESSION_MARKER)}`;
  const result = await runFuseOpenShell(
    ["sandbox", "exec", "-n", name, "--", "sh", "-c", script],
    { ensure: false, timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not prepare the desktop agent session: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

export async function waitCurrentSessionMarkerConsumed(name, _env, timeoutMs = 5_000) {
  const tenths = Math.max(1, Math.ceil(timeoutMs / 100));
  const script = `i=0; while [ -f ${shellQuote(SESSION_MARKER)} ] && [ "$i" -lt ${tenths} ]; do i=$((i+1)); sleep 0.1; done; [ ! -f ${shellQuote(SESSION_MARKER)} ]`;
  const result = await runFuseOpenShell(
    ["sandbox", "exec", "-n", name, "--", "sh", "-c", script],
    { ensure: false, timeout: timeoutMs + 5_000 },
  ).catch(() => null);
  return result?.exitCode === 0;
}

export async function probeDatabaseUrl() {
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  const parsed = new URL(databaseUrl);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  if (parsed.hostname.endsWith(".pooler.supabase.com") && parsed.port === "6543") {
    throw new Error("Supabase transaction pooling on port 6543 is incompatible with the FUSE writer lease; use session mode on port 5432.");
  }
  await ensureFuseRuntime();
  const result = await wslRun(
    ["-d", DISTRO_NAME, "--", "docker", "run", "--rm", "postgres:16-alpine", "psql", databaseUrl, "-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1"],
    { timeout: 90_000 },
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== "1") {
    throw new Error((result.stderr || result.stdout).trim() || "PostgreSQL connectivity check failed.");
  }
  return { reachable: true };
}

export function imageForProfile(profile) {
  agentForProfile(profile);
  return FUSE_IMAGE;
}

export const __testing = { normalizeProviderRows, normalizeSandboxRows };
