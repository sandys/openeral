import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DISTRO_NAME, ensureWslKeepalive, wslRun, wslSpawn } from "./wsl.mjs";

export const FUSE_GATEWAY_ENDPOINT = "http://127.0.0.1:18770";
export const FUSE_CLI = "/opt/openrind-desktop/fuse-runtime/openshell";

const RUNTIME_ROOT = "/opt/openrind-desktop/fuse-runtime";
const STATE_ROOT = "/home/banker/.local/state/openrind-desktop/fuse-gateway";
const SERVICE = "openrind-desktop-fuse-gateway.service";
const SOURCE_ID = `${RUNTIME_ROOT}/source-id`;
const CONTROL_CONTRACT_PATH = `${STATE_ROOT}/control-contract`;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../../../../../");
const SOURCE_CHECKOUT = existsSync(path.join(REPOSITORY_ROOT, "Dockerfile.openrind-shell"));
export const FUSE_IMAGE =
  process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE?.trim() ||
  (SOURCE_CHECKOUT
    ? "openrind-shell-fuse:local"
    : "ghcr.io/openrind/openrind-shell/sandbox:fuse");
export const FUSE_IMAGE_PULL_POLICY =
  process.env.OPENRIND_DESKTOP_SANDBOX_PULL_POLICY?.trim() ||
  (FUSE_IMAGE === "openrind-shell-fuse:local" ? "Never" : "IfNotPresent");
const CONTROL_CONTRACT = `openrind-desktop-fuse-control-v2:${FUSE_IMAGE}:${FUSE_IMAGE_PULL_POLICY}`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function windowsPathToWsl(value) {
  const normalized = path.resolve(value);
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(normalized);
  if (drive) {
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  return normalized.replace(/\\/g, "/");
}

function resolveBinaryDirectory() {
  const candidates = [
    process.env.OPENRIND_DESKTOP_FUSE_BIN_DIR?.trim(),
    process.resourcesPath && path.join(process.resourcesPath, "openshell-fuse"),
    path.join(REPOSITORY_ROOT, "vendor", "openshell", "target", "release"),
    path.join(REPOSITORY_ROOT, "vendor", "openshell", "target", "debug"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      ["openshell", "openshell-gateway", "openshell-sandbox"].every((name) =>
        existsSync(path.join(candidate, name)),
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function sourceFingerprint(directory) {
  return ["openshell", "openshell-gateway", "openshell-sandbox"]
    .map((name) => {
      const stat = statSync(path.join(directory, name));
      return `${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    })
    .join("|");
}

function gatewayConfig() {
  return `[openshell]
version = 1

[openshell.gateway]
bind_address = "127.0.0.1:18770"
log_level = "info"
compute_drivers = ["docker"]
disable_tls = true

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.gateway.gateway_jwt]
signing_key_path = "${STATE_ROOT}/jwt/signing.pem"
public_key_path = "${STATE_ROOT}/jwt/public.pem"
kid_path = "${STATE_ROOT}/jwt/kid"
gateway_id = "openrind-desktop-fuse"
ttl_secs = 0

[openshell.drivers.docker]
default_image = "${FUSE_IMAGE}"
image_pull_policy = "${FUSE_IMAGE_PULL_POLICY}"
sandbox_namespace = "openrind-desktop-fuse"
grpc_endpoint = "http://host.openshell.internal:18770"
supervisor_bin = "${RUNTIME_ROOT}/openshell-sandbox"
enable_fuse = true
`;
}

function gatewayService() {
  return `[Unit]
Description=Openrind Desktop paired OpenShell FUSE gateway
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=banker
Group=banker
Environment=HOME=/home/banker
ExecStart=${RUNTIME_ROOT}/openshell-gateway --config ${STATE_ROOT}/gateway.toml --db-url sqlite:${STATE_ROOT}/gateway.db?mode=rwc
Restart=always
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

async function gatewayIsHealthy(timeout = 8_000) {
  const result = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      FUSE_CLI,
      "--gateway-endpoint",
      FUSE_GATEWAY_ENDPOINT,
      "gateway",
      "info",
      "-o",
      "json",
    ],
    { timeout },
  ).catch(() => null);
  return result?.exitCode === 0;
}

async function controlPlaneIsCurrent() {
  const contract = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "sh",
      "-c",
      `test -r ${shellQuote(CONTROL_CONTRACT_PATH)} && cat ${shellQuote(CONTROL_CONTRACT_PATH)}`,
    ],
    { timeout: 5_000 },
  ).catch(() => null);
  return contract?.exitCode === 0 && contract.stdout.trim() === CONTROL_CONTRACT;
}

async function installBinaries(directory, fingerprint, onProgress) {
  const current = await wslRun(
    ["-d", DISTRO_NAME, "--user", "root", "--", "sh", "-c", `cat ${SOURCE_ID} 2>/dev/null || true`],
    // This is the first awaited WSL operation on a cold desktop launch. The
    // keepalive is intentionally fire-and-forget, so let this same useful read
    // absorb a slow WSL/systemd cold boot instead of racing it at ten seconds.
    { timeout: 60_000 },
  );
  if (current.exitCode === 0 && current.stdout.trim() === fingerprint) return false;

  onProgress?.({ phase: "control-plane", message: "Installing the patched OpenShell FUSE runtime…" });
  const sources = ["openshell", "openshell-gateway", "openshell-sandbox"]
    .map((name) => `${shellQuote(windowsPathToWsl(path.join(directory, name)))}:${shellQuote(`${RUNTIME_ROOT}/${name}`)}`)
    .join(" ");
  const script = `set -eu
install -d -m 0755 -o root -g root ${shellQuote(RUNTIME_ROOT)}
for pair in ${sources}; do
  src="\${pair%%:*}"
  dst="\${pair#*:}"
  install -m 0755 -o root -g root "$src" "$dst.new"
  mv -f "$dst.new" "$dst"
done
printf %s ${shellQuote(fingerprint)} > ${shellQuote(SOURCE_ID)}
chmod 0644 ${shellQuote(SOURCE_ID)}`;
  const result = await wslRun(
    ["-d", DISTRO_NAME, "--user", "root", "--", "bash", "-lc", script],
    { timeout: 10 * 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not install the patched OpenShell FUSE runtime: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  return true;
}

async function configureGateway(restart, onProgress) {
  onProgress?.({ phase: "control-plane", message: "Starting the paired OpenShell FUSE gateway…" });
  const config = Buffer.from(gatewayConfig(), "utf8").toString("base64");
  const service = Buffer.from(gatewayService(), "utf8").toString("base64");
  const script = `set -eu
install -d -m 0700 -o banker -g banker ${shellQuote(STATE_ROOT)} ${shellQuote(`${STATE_ROOT}/jwt`)}
changed=${restart ? 1 : 0}
write_if_changed() {
  target="$1"
  owner="$2"
  mode="$3"
  content="$4"
  tmp="\${target}.new"
  printf %s "$content" | base64 -d > "$tmp"
  if [ ! -f "$target" ] || ! cmp -s "$tmp" "$target"; then
    install -m "$mode" -o "$owner" -g "$owner" "$tmp" "$target"
    changed=1
  fi
  rm -f "$tmp"
}
write_if_changed ${shellQuote(`${STATE_ROOT}/gateway.toml`)} banker 0600 ${shellQuote(config)}
write_if_changed ${shellQuote(`/etc/systemd/system/${SERVICE}`)} root 0644 ${shellQuote(service)}
if [ ! -s ${shellQuote(`${STATE_ROOT}/jwt/signing.pem`)} ]; then
  openssl genpkey -algorithm ED25519 -out ${shellQuote(`${STATE_ROOT}/jwt/signing.pem`)}
  openssl pkey -in ${shellQuote(`${STATE_ROOT}/jwt/signing.pem`)} -pubout -out ${shellQuote(`${STATE_ROOT}/jwt/public.pem`)}
  printf '%s\n' openrind-desktop-fuse > ${shellQuote(`${STATE_ROOT}/jwt/kid`)}
  chown banker:banker ${shellQuote(`${STATE_ROOT}/jwt/signing.pem`)} ${shellQuote(`${STATE_ROOT}/jwt/public.pem`)} ${shellQuote(`${STATE_ROOT}/jwt/kid`)}
  chmod 0600 ${shellQuote(`${STATE_ROOT}/jwt/signing.pem`)}
  changed=1
fi
printf %s ${shellQuote(CONTROL_CONTRACT)} > ${shellQuote(CONTROL_CONTRACT_PATH)}
chown banker:banker ${shellQuote(CONTROL_CONTRACT_PATH)}
chmod 0600 ${shellQuote(CONTROL_CONTRACT_PATH)}
systemctl daemon-reload
systemctl enable ${shellQuote(SERVICE)} >/dev/null
if [ "$changed" -eq 1 ]; then
  systemctl restart ${shellQuote(SERVICE)}
else
  systemctl start ${shellQuote(SERVICE)}
fi`;
  const result = await wslRun(
    ["-d", DISTRO_NAME, "--user", "root", "--", "bash", "-s"],
    {
      // Keep the multiline service/config script out of wsl.exe's Windows
      // command-line re-quoting. Passing it on stdin preserves every shell
      // variable and target path exactly as generated.
      stdin: script,
      timeout: 90_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not configure the paired OpenShell FUSE gateway: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

let ensurePromise = null;

export async function ensureFuseRuntime(options = {}) {
  if (ensurePromise) return ensurePromise;
  const pending = (async () => {
    ensureWslKeepalive();
    const directory = resolveBinaryDirectory();
    let installed = false;
    if (directory) {
      installed = await installBinaries(
        directory,
        sourceFingerprint(directory),
        options.onProgress,
      );
    } else {
      const bundled = await wslRun(
        [
          "-d",
          DISTRO_NAME,
          "--",
          "sh",
          "-c",
          `test -x ${FUSE_CLI} && test -x ${RUNTIME_ROOT}/openshell-gateway && test -x ${RUNTIME_ROOT}/openshell-sandbox`,
        ],
        { timeout: 10_000 },
      );
      if (bundled.exitCode !== 0) {
        throw new Error(
          "The patched OpenShell FUSE binaries are missing. Build the vendored CLI, gateway, and supervisor described in BUILD.md, or reinstall the bundled OpenShell distro.",
        );
      }
    }
    if (
      !installed &&
      (await controlPlaneIsCurrent()) &&
      (await gatewayIsHealthy(3_000))
    ) {
      return;
    }
    await configureGateway(installed, options.onProgress);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await gatewayIsHealthy(4_000)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const diagnostics = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--user",
        "root",
        "--",
        "bash",
        "-lc",
        `systemctl status ${shellQuote(SERVICE)} --no-pager -l 2>&1; journalctl -u ${shellQuote(SERVICE)} -n 30 --no-pager 2>&1`,
      ],
      { timeout: 15_000 },
    ).catch(() => ({ stdout: "", stderr: "" }));
    throw new Error(
      `The paired OpenShell FUSE gateway did not become healthy at ${FUSE_GATEWAY_ENDPOINT}. ${(diagnostics.stdout || diagnostics.stderr).trim().slice(-2000)}`,
    );
  })();
  ensurePromise = pending;
  try {
    await pending;
  } finally {
    // This is a single-flight guard, not a permanent health cache. A WSL or
    // Docker service restart can happen while Electron stays open, so every
    // later operation must get a cheap current-contract + health check.
    if (ensurePromise === pending) ensurePromise = null;
  }
}

export async function getFuseRuntimeStatus() {
  const [current, healthy] = await Promise.all([
    controlPlaneIsCurrent(),
    gatewayIsHealthy(5_000),
  ]);
  return {
    endpoint: FUSE_GATEWAY_ENDPOINT,
    service: SERVICE,
    current,
    healthy,
  };
}

export async function restartFuseRuntime() {
  await ensureFuseRuntime();
  const restarted = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--user",
      "root",
      "--",
      "systemctl",
      "restart",
      SERVICE,
    ],
    { timeout: 30_000 },
  );
  if (restarted.exitCode !== 0) {
    throw new Error(
      `Could not restart the paired OpenShell FUSE gateway: ${(restarted.stderr || restarted.stdout).trim() || `exit ${restarted.exitCode}`}`,
    );
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await gatewayIsHealthy(4_000)) {
      return { ok: true, recoveredVia: `systemctl restart ${SERVICE}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `The paired OpenShell FUSE gateway did not recover at ${FUSE_GATEWAY_ENDPOINT}.`,
  );
}

export async function runFuseOpenShell(args, options = {}) {
  if (options.ensure !== false) {
    await ensureFuseRuntime({ onProgress: options.onProgress });
  }
  return wslRun(
    ["-d", DISTRO_NAME, "--", FUSE_CLI, "--gateway-endpoint", FUSE_GATEWAY_ENDPOINT, ...args],
    options,
  );
}

export function spawnFuseOpenShell(args, options = {}) {
  return wslSpawn(
    ["-d", DISTRO_NAME, "--", FUSE_CLI, "--gateway-endpoint", FUSE_GATEWAY_ENDPOINT, ...args],
    options,
  );
}

export const __testing = {
  gatewayConfig,
  gatewayService,
  windowsPathToWsl,
};
