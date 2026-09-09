// Build the source-checkout FUSE and Haloop images in the dedicated OpenShell
// WSL Docker daemon. Building them in Docker Desktop's host daemon is not
// sufficient because the managed gateway and sandboxes use this isolated
// engine.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DISTRO_NAME = "openrind-desktop-openshell";
const FUSE_IMAGE = "openrind-shell-fuse:local";
const FUSE_CONTRACT = "fuse-haloop-required-v27";
const OPENSHELL_BASE_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";
const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const HALOOP_LOCAL_IMAGE = "haloop-gateway:local";
const HALOOP_CONTRACT = "openrind-haloop-v2";
const HALOOP_LOCAL_COLLECTOR_IMAGE = "haloop-collector:local";
const HALOOP_COLLECTOR_CONTRACT = "openrind-haloop-collector-v1";
const HALOOP_VERSION = "w8-haloop-openrind-v4-eval-export";
const HALOOP_PRODUCTION_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-gateway:${HALOOP_VERSION}`;
const HALOOP_PRODUCTION_COLLECTOR_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-collector:${HALOOP_VERSION}`;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "../../..");
const haloopRoot = path.resolve(
  process.env.OPENRIND_DESKTOP_HALOOP_SOURCE?.trim() ||
    path.join(repositoryRoot, "..", "w8-haloop-main"),
);

function fail(message) {
  throw new Error(`[runtime-images] ${message}`);
}

function toWslPath(value) {
  const absolute = path.resolve(value);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) fail(`Expected an absolute Windows path, received ${JSON.stringify(absolute)}.`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function runWsl(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", DISTRO_NAME, "--", ...args], {
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function requireSuccess(args, label, options) {
  const result = await runWsl(args, options);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    fail(`${label} failed${detail ? `: ${detail}` : ` with exit ${result.exitCode}`}`);
  }
  return result;
}

async function verifyImage(image, labelName, expectedContract, includeVersion = false) {
  const fields = [
    "{{.Id}}",
    `{{ index .Config.Labels ${JSON.stringify(labelName)} }}`,
  ];
  if (includeVersion) {
    fields.push('{{ index .Config.Labels "com.openrind.desktop.haloop-version" }}');
  }
  const result = await requireSuccess(
    ["docker", "image", "inspect", image, "--format", fields.join("|")],
    `Inspecting ${image}`,
    { capture: true },
  );
  const [imageId, contract, version = ""] = result.stdout.trim().split("|");
  if (contract !== expectedContract) {
    fail(`${image} has contract ${JSON.stringify(contract)}; expected ${expectedContract}.`);
  }
  if (includeVersion && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) {
    fail(`${image} does not contain a safe diagnostic Haloop version label.`);
  }
  console.log(
    `[runtime-images] verified ${image} ${imageId}${version ? ` (${version})` : ""}`,
  );
  return { imageId, version };
}

async function resolveLatestClaudeCodeVersion() {
  const result = await requireSuccess(
    [
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "npm",
      OPENSHELL_BASE_IMAGE,
      "view",
      `${CLAUDE_CODE_PACKAGE}@latest`,
      "version",
    ],
    "Resolving the latest Claude Code version",
    { capture: true },
  );
  const version = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    fail(`npm returned an invalid Claude Code version ${JSON.stringify(version)}.`);
  }
  return version;
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--fuse-only", "--haloop-only", "--verify-only", "--production-haloop", "--push"].includes(flag)) {
    fail(`Unknown option ${flag}. Use --fuse-only, --haloop-only, --verify-only, --production-haloop, or --push.`);
  }
}
if (flags.has("--fuse-only") && flags.has("--haloop-only")) {
  fail("--fuse-only and --haloop-only cannot be combined.");
}

const includeFuse = !flags.has("--haloop-only");
const includeHaloop = !flags.has("--fuse-only");
const verifyOnly = flags.has("--verify-only");
const productionHaloop = flags.has("--production-haloop");
const push = flags.has("--push");
if (push && (!productionHaloop || verifyOnly || !includeHaloop)) {
  fail("--push requires a Haloop build with --production-haloop and cannot be combined with --verify-only or --fuse-only.");
}
const haloopImage = productionHaloop ? HALOOP_PRODUCTION_IMAGE : HALOOP_LOCAL_IMAGE;
const haloopCollectorImage = productionHaloop
  ? HALOOP_PRODUCTION_COLLECTOR_IMAGE
  : HALOOP_LOCAL_COLLECTOR_IMAGE;

await requireSuccess(
  ["docker", "info", "--format", "{{.ServerVersion}}"],
  `Connecting to Docker in ${DISTRO_NAME}`,
  { capture: true },
);

if (!verifyOnly && includeFuse) {
  const dockerfile = path.join(repositoryRoot, "Dockerfile.openrind-shell");
  if (!existsSync(dockerfile)) fail(`FUSE Dockerfile not found at ${dockerfile}.`);
  const claudeCodeVersion = await resolveLatestClaudeCodeVersion();
  console.log(`[runtime-images] latest Claude Code is ${claudeCodeVersion}.`);
  console.log(`[runtime-images] building ${FUSE_IMAGE} in ${DISTRO_NAME}...`);
  await requireSuccess(
    [
      "docker",
      "build",
      "--pull=false",
      "--build-arg",
      `CLAUDE_CODE_VERSION=${claudeCodeVersion}`,
      "-f",
      toWslPath(dockerfile),
      "-t",
      FUSE_IMAGE,
      toWslPath(repositoryRoot),
    ],
    `Building ${FUSE_IMAGE}`,
  );
}

if (!verifyOnly && includeHaloop) {
  const dockerfile = path.join(haloopRoot, "Dockerfile");
  if (!existsSync(dockerfile)) {
    fail(
      `Haloop Dockerfile not found at ${dockerfile}. Set OPENRIND_DESKTOP_HALOOP_SOURCE to the w8-haloop-main checkout.`,
    );
  }
  console.log(`[runtime-images] building ${haloopImage} in ${DISTRO_NAME}...`);
  await requireSuccess(
    [
      "docker",
      "build",
      "--pull=false",
      "-f",
      toWslPath(dockerfile),
      "-t",
      haloopImage,
      toWslPath(haloopRoot),
    ],
    `Building ${haloopImage}`,
  );

  const collectorDockerfile = path.join(haloopRoot, "halo-loop", "Dockerfile");
  if (!existsSync(collectorDockerfile)) {
    fail(`Haloop collector Dockerfile not found at ${collectorDockerfile}.`);
  }
  console.log(`[runtime-images] building ${haloopCollectorImage} in ${DISTRO_NAME}...`);
  await requireSuccess(
    [
      "docker",
      "build",
      "--pull=false",
      "--target",
      "openrind-desktop-collector",
      "-f",
      toWslPath(collectorDockerfile),
      "-t",
      haloopCollectorImage,
      toWslPath(haloopRoot),
    ],
    `Building ${haloopCollectorImage}`,
  );
}

if (verifyOnly && includeHaloop && productionHaloop) {
  await requireSuccess(
    ["docker", "image", "pull", haloopImage],
    `Pulling ${haloopImage}`,
  );
  await requireSuccess(
    ["docker", "image", "pull", haloopCollectorImage],
    `Pulling ${haloopCollectorImage}`,
  );
}

if (includeFuse) {
  await verifyImage(
    FUSE_IMAGE,
    "com.openrind.desktop.fuse-contract",
    FUSE_CONTRACT,
  );
}
if (includeHaloop) {
  const gateway = await verifyImage(
    haloopImage,
    "com.openrind.desktop.haloop-contract",
    HALOOP_CONTRACT,
    true,
  );
  const collector = await verifyImage(
    haloopCollectorImage,
    "com.openrind.desktop.haloop-collector-contract",
    HALOOP_COLLECTOR_CONTRACT,
    true,
  );
  if (gateway.version !== collector.version) {
    fail(
      `Haloop gateway and collector versions do not match (${gateway.version} versus ${collector.version}).`,
    );
  }
  if (productionHaloop && gateway.version !== HALOOP_VERSION) {
    fail(
      `Pinned production tags require Haloop version ${HALOOP_VERSION}; found ${gateway.version}.`,
    );
  }
}

if (push) {
  await requireSuccess(
    ["docker", "image", "push", haloopImage],
    `Publishing ${haloopImage}`,
  );
  await requireSuccess(
    ["docker", "image", "push", haloopCollectorImage],
    `Publishing ${haloopCollectorImage}`,
  );
}

console.log(
  productionHaloop
    ? `[runtime-images] pinned Haloop ${HALOOP_VERSION} production images are verified${push ? " and published" : ""}.`
    : "[runtime-images] required source-checkout images are ready in the OpenShell WSL daemon.",
);
