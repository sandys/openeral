// Desktop-owned lifecycle for the required Openrind Haloop inference edge.
//
// The upstream Anthropic key is written only to a mode-0600 registry in the
// dedicated OpenShell WSL distro and mounted read-only into the managed Haloop
// container. Sandboxes receive a scoped client token through OpenShell's
// endpoint-bound provider; they never receive the upstream credential.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  registerHaloopClientProfile,
  revokeAllHaloopClientProfiles,
  revokeHaloopClientProfilesForSandbox,
  rotateHaloopClientProfile,
} from "./openrind-shell-credentials.mjs";
import { DISTRO_NAME, ensureDistroRunning, wslRun } from "./wsl.mjs";

export const HALOOP_IMAGE_CONTRACT = "openrind-haloop-v2";
export const HALOOP_CONTAINER_NAME = "openrind-desktop-haloop";
export const HALOOP_COLLECTOR_IMAGE_CONTRACT = "openrind-haloop-collector-v1";
export const HALOOP_COLLECTOR_CONTAINER_NAME = "openrind-desktop-haloop-collector";
export const HALOOP_NETWORK_NAME = "openrind-desktop-haloop";
export const HALOOP_EDGE_PORT = 8787;
export const HALOOP_SANDBOX_ENDPOINT = `http://host.openshell.internal:${HALOOP_EDGE_PORT}`;
export const HALOOP_ROUTE_POLICY = "incumbent-only";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../../../../../");
const SOURCE_CHECKOUT = existsSync(path.join(REPOSITORY_ROOT, "Dockerfile.openrind-shell"));
export const HALOOP_IMAGE_VERSION = "w8-haloop-openrind-v3-managed-collector";
export const HALOOP_PACKAGED_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-gateway:${HALOOP_IMAGE_VERSION}`;
export const HALOOP_PACKAGED_COLLECTOR_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-collector:${HALOOP_IMAGE_VERSION}`;

export function resolveHaloopImageConfig({
  sourceCheckout = SOURCE_CHECKOUT,
  env = process.env,
} = {}) {
  const image = env.OPENRIND_DESKTOP_HALOOP_IMAGE?.trim() ||
    (sourceCheckout ? "haloop-gateway:local" : HALOOP_PACKAGED_IMAGE);
  const collectorImage = env.OPENRIND_DESKTOP_HALOOP_COLLECTOR_IMAGE?.trim() ||
    (sourceCheckout ? "haloop-collector:local" : HALOOP_PACKAGED_COLLECTOR_IMAGE);
  const pullPolicy = env.OPENRIND_DESKTOP_HALOOP_PULL_POLICY?.trim() ||
    (image.endsWith(":local") && collectorImage.endsWith(":local") ? "never" : "missing");
  if (!new Set(["never", "missing", "always"]).has(pullPolicy)) {
    throw new Error("OPENRIND_DESKTOP_HALOOP_PULL_POLICY must be never, missing, or always.");
  }
  return { image, collectorImage, pullPolicy };
}

const HALOOP_IMAGE_CONFIG = resolveHaloopImageConfig();
export const HALOOP_IMAGE = HALOOP_IMAGE_CONFIG.image;
export const HALOOP_COLLECTOR_IMAGE = HALOOP_IMAGE_CONFIG.collectorImage;
export const HALOOP_IMAGE_PULL_POLICY = HALOOP_IMAGE_CONFIG.pullPolicy;

const HALOOP_STATE_DIR = "/var/lib/openrind-desktop/haloop";
const HALOOP_COLLECTOR_DATA_DIR = `${HALOOP_STATE_DIR}/collector-data`;
const HALOOP_COLLECTOR_CONTAINER_DATA_DIR = "/app/halo-loop/data";
const HALOOP_COLLECTOR_URL = `http://${HALOOP_COLLECTOR_CONTAINER_NAME}:8788`;
const HALOOP_PROFILES_FILE = `${HALOOP_STATE_DIR}/openrind-profiles.json`;
const HALOOP_CONTAINER_PROFILES_FILE = "/run/openrind/openrind-profiles.json";
const OPENSHELL_SANDBOX_NETWORK_NAME = "openshell-docker";
const PROFILE_HASH_LABEL = "com.openrind.desktop.haloop-profile-sha256";
const MANAGED_LABEL = "com.openrind.desktop.managed-haloop";
const MANAGED_NETWORK_LABEL = "com.openrind.desktop.managed-haloop-network";
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_SECONDS = 45;
const IMAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const APP_SPAN_KINDS = new Set(["AGENT", "TOOL", "CHAIN"]);
const MAX_APP_SPANS_PER_BATCH = 64;
const MAX_APP_SPAN_BYTES = 64 * 1024;
const MAX_APP_BATCH_BYTES = 256 * 1024;
const MAX_APP_CAPTURE_BYTES_PER_TRACE = 4 * 1024 * 1024;
const HALOOP_SESSION_ASSERTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HALOOP_CONTEXT_ID_PATTERN = /^[0-9a-f]{32}$/;

function requiredSecret(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is required for Haloop.`);
  }
  return normalized;
}

function safeDiagnosticMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown Haloop error");
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
}

function stableHex(label, ...values) {
  const hash = createHash("sha256").update(label);
  for (const value of values) hash.update("\0").update(String(value));
  return hash.digest("hex");
}

function deriveHaloopSessionHmacKey(profile) {
  return stableHex(
    "openrind-haloop-session-key-v1",
    requiredSecret(profile.clientToken, "Haloop client token"),
  );
}

export function buildHaloopCaptureIdentity(profile, contextId) {
  const canonicalContextId = String(contextId ?? "").trim();
  if (!HALOOP_CONTEXT_ID_PATTERN.test(canonicalContextId)) {
    throw new Error("A canonical Haloop conversation context id is required.");
  }
  const project = `openrind-${stableHex("project", profile.workspaceId).slice(0, 24)}`;
  return {
    profileId: requiredSecret(profile.id, "Haloop profile id"),
    project,
    traceId: stableHex(
      "openrind-haloop-trace-v2",
      profile.id,
      canonicalContextId,
    ).slice(0, 32),
    rootSpanId: stableHex(
      "openrind-haloop-root-v2",
      profile.id,
      canonicalContextId,
    ).slice(0, 16),
    sessionId: `${requiredSecret(profile.agentId, "Haloop agent id")}:${canonicalContextId}`,
  };
}

export function issueHaloopConversationContext(profile, options = {}) {
  const suppliedContextId = String(options.contextId ?? "").trim();
  const agentSessionId = String(options.agentSessionId ?? "").trim();
  if (agentSessionId.length > 4_096) {
    throw new Error("The agent session id is too long for Haloop.");
  }
  const contextId = suppliedContextId || (agentSessionId
    ? createHmac(
        "sha256",
        Buffer.from(deriveHaloopSessionHmacKey(profile), "hex"),
      )
        .update("openrind-haloop-conversation-v1\0", "utf8")
        .update(agentSessionId, "utf8")
        .digest("hex")
        .slice(0, 32)
    : randomBytes(16).toString("hex"));
  if (!HALOOP_CONTEXT_ID_PATTERN.test(contextId)) {
    throw new Error("The Haloop conversation context id is invalid.");
  }
  const issuedAtMs = Number(options.issuedAtMs ?? Date.now());
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
    throw new Error("The Haloop conversation issue time is invalid.");
  }
  const expiresAtMs = issuedAtMs + HALOOP_SESSION_ASSERTION_TTL_MS;
  const profileId = requiredSecret(profile.id, "Haloop profile id");
  const signed = `v1\n${profileId}\n${contextId}\n${issuedAtMs}\n${expiresAtMs}`;
  const signature = createHmac(
    "sha256",
    Buffer.from(deriveHaloopSessionHmacKey(profile), "hex"),
  ).update(signed, "utf8").digest("hex");
  return {
    contextId,
    assertion: `v1.${contextId}.${issuedAtMs}.${expiresAtMs}.${signature}`,
    expiresAtMs,
    capture: buildHaloopCaptureIdentity(profile, contextId),
  };
}

export function buildHaloopProfilesDocument(profiles, anthropicApiKey) {
  const upstreamKey = requiredSecret(anthropicApiKey, "ANTHROPIC_API_KEY");
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error("At least one scoped Haloop client profile is required.");
  }
  return {
    version: 1,
    profiles: profiles.map((profile) => {
      const project = `openrind-${stableHex("project", profile.workspaceId).slice(0, 24)}`;
      return {
        id: profile.id,
        client_token_sha256: createHash("sha256")
          .update(requiredSecret(profile.clientToken, "Haloop client token"), "utf8")
          .digest("hex"),
        config: {
          provider: "anthropic",
          api_key: upstreamKey,
          input_guardrails: [
            {
              "halo.mark": { collectorURL: HALOOP_COLLECTOR_URL },
              async: false,
              deny: false,
            },
          ],
          output_guardrails: [
            {
              "halo.export": {
                collectorURL: HALOOP_COLLECTOR_URL,
                defaultProject: project,
              },
              async: false,
              deny: false,
            },
          ],
        },
        project,
        session_hmac_key: deriveHaloopSessionHmacKey(profile),
        session_id_prefix: requiredSecret(profile.agentId, "Haloop agent id"),
      };
    }),
  };
}

function clippedString(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeCaptureValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return clippedString(value, 4_096);
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => sanitizeCaptureValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [rawKey, entry] of Object.entries(value).slice(0, 64)) {
      const key = clippedString(rawKey, 128);
      if (!key) continue;
      if (/(?:authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = sanitizeCaptureValue(entry, depth + 1);
      }
    }
    return output;
  }
  return clippedString(value, 4_096);
}

export function buildTrustedHaloopAppSpan(capture, event) {
  if (!capture || !TRACE_ID_PATTERN.test(String(capture.traceId ?? ""))) {
    throw new Error("A trusted canonical Haloop trace identity is required.");
  }
  if (!SPAN_ID_PATTERN.test(String(capture.rootSpanId ?? ""))) {
    throw new Error("A trusted canonical Haloop root span identity is required.");
  }
  const kind = String(event?.kind ?? "").toUpperCase();
  if (!APP_SPAN_KINDS.has(kind)) {
    throw new Error("Desktop capture accepts AGENT, TOOL, and CHAIN spans only.");
  }
  const eventId = clippedString(event?.eventId, 256);
  if (!eventId) throw new Error("A stable Desktop capture eventId is required.");
  const name = clippedString(event?.name || kind.toLowerCase(), 256);
  const startMs = Number(event?.startMs);
  const endMs = Number(event?.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error("Desktop capture startMs/endMs must be a valid ordered interval.");
  }
  const parentSpanId =
    event.parentSpanId === ""
      ? ""
      : String(event.parentSpanId || capture.rootSpanId);
  if (parentSpanId && !SPAN_ID_PATTERN.test(parentSpanId)) {
    throw new Error("Desktop capture parentSpanId must be canonical.");
  }
  const attributes = {};
  for (const [key, value] of Object.entries(event.attributes || {}).slice(0, 64)) {
    if (/^openrind\.[a-z0-9_.-]{1,96}$/i.test(key)) {
      attributes[key] = sanitizeCaptureValue(value);
    }
  }
  const payload = {
    kind,
    name,
    project: capture.project,
    trace_id: capture.traceId,
    span_id:
      eventId === "route-root"
        ? capture.rootSpanId
        : stableHex("desktop-span", capture.profileId, eventId).slice(0, 16),
    parent_span_id: parentSpanId,
    session_id: capture.sessionId,
    start: startMs / 1_000,
    end: endMs / 1_000,
    ok: event.ok !== false,
    status_message: clippedString(event.statusMessage, 500),
    service_name: "openrind-desktop",
    attributes,
  };
  if (event.input !== undefined) payload.input = sanitizeCaptureValue(event.input);
  if (event.output !== undefined) payload.output = sanitizeCaptureValue(event.output);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_APP_SPAN_BYTES) {
    throw new Error(`A Desktop capture span exceeds ${MAX_APP_SPAN_BYTES} bytes.`);
  }
  return payload;
}

export function buildHaloopAgentLifecycleEvent(agent, event) {
  const agentId = String(agent ?? "").trim();
  if (agentId !== "claude" && agentId !== "openclaw") {
    throw new Error("OPENRIND_SHELL_AGENT must be claude or openclaw for Haloop lifecycle capture.");
  }
  const cause = String(event?.terminationCause || "process-exit");
  const lifecycle =
    cause === "desktop-close"
      ? "cancelled"
      : cause === "sandbox-delete"
        ? "sandbox-deleted"
        : cause === "app-shutdown"
          ? "app-shutdown"
          : event?.exitCode === 0
            ? "completed"
            : "crashed";
  const statusMessage =
    lifecycle === "completed"
      ? ""
      : lifecycle === "cancelled"
        ? "Agent session was cancelled by Desktop."
        : lifecycle === "sandbox-deleted"
          ? "Agent session ended because its sandbox was deleted."
          : lifecycle === "app-shutdown"
            ? "Agent session ended during Desktop shutdown."
            : `Agent process exited with code ${event?.exitCode ?? "unknown"}.`;
  return {
    kind: "AGENT",
    eventId: `pty:${requiredSecret(event?.id, "PTY lifecycle id")}`,
    name: `${agentId}.session`,
    startMs: event?.openedAt,
    endMs: event?.endedAt,
    ok: lifecycle === "completed",
    statusMessage,
    attributes: {
      "openrind.agent.id": agentId,
      "openrind.lifecycle": lifecycle,
      "openrind.termination.cause": cause,
      "openrind.exit.code": event?.exitCode,
      "openrind.exit.signal": event?.signal,
      "openrind.close.requested_at_ms": event?.closeRequestedAt,
    },
  };
}

async function postPrivateCollectorSpans(run, spans) {
  const serialized = JSON.stringify(spans);
  if (Buffer.byteLength(serialized, "utf8") > MAX_APP_BATCH_BYTES) {
    throw new Error(`A Desktop capture batch exceeds ${MAX_APP_BATCH_BYTES} bytes.`);
  }
  const postScript = [
    "import sys,urllib.request",
    `b=sys.stdin.buffer.read(${MAX_APP_BATCH_BYTES + 1})`,
    `assert len(b)<=${MAX_APP_BATCH_BYTES},'capture batch too large'`,
    "q=urllib.request.Request('http://127.0.0.1:8788/spans',data=b,headers={'content-type':'application/json'},method='POST')",
    "r=urllib.request.urlopen(q,timeout=10)",
    "sys.stdout.write(r.read().decode('utf-8'))",
  ].join(";");
  const result = await run(
    dockerArgs(
      "exec",
      "-i",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "python",
      "-c",
      postScript,
    ),
    { stdin: serialized, timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `The private Haloop collector rejected Desktop capture: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error("The private Haloop collector returned an invalid capture response.");
  }
  if (!Array.isArray(response.errors) || response.errors.length > 0) {
    throw new Error("The private Haloop collector reported an invalid Desktop span.");
  }
  return {
    written: Number(response.written) || 0,
    duplicates: Number(response.duplicates) || 0,
  };
}

function dockerArgs(...args) {
  return ["-d", DISTRO_NAME, "--", "docker", ...args];
}

async function inspectImage(run, image, contractLabel) {
  return run(
    dockerArgs(
      "image",
      "inspect",
      image,
      "--format",
      `{{ index .Config.Labels "${contractLabel}" }}|{{ index .Config.Labels "com.openrind.desktop.haloop-version" }}|{{.Id}}`,
    ),
    { timeout: 20_000 },
  );
}

async function requireImage(run, { image, contract, contractLabel, service }) {
  let result = await inspectImage(run, image, contractLabel);
  if (
    HALOOP_IMAGE_PULL_POLICY === "always" ||
    (result.exitCode !== 0 && HALOOP_IMAGE_PULL_POLICY === "missing")
  ) {
    const pulled = await run(
      dockerArgs("image", "pull", image),
      { timeout: 5 * 60_000 },
    );
    if (pulled.exitCode !== 0) {
      throw new Error(
        `Could not pull the pinned Haloop ${service} image ${image}: ${(pulled.stderr || pulled.stdout).trim() || `exit ${pulled.exitCode}`}`,
      );
    }
    result = await inspectImage(run, image, contractLabel);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `The required Haloop ${service} image ${image} is not present in the dedicated OpenShell WSL Docker daemon. Build the source-checkout images or make the pinned production image available, then retry.`,
    );
  }
  const [actualContract, version, imageId] = result.stdout.trim().split("|");
  if (actualContract !== contract) {
    throw new Error(
      `The Haloop ${service} image ${image} is incompatible (expected contract ${contract}). Rebuild the pinned Haloop images, then retry.`,
    );
  }
  if (!version || !IMAGE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `The Haloop ${service} image ${image} has an invalid diagnostic version label. Rebuild the pinned Haloop images, then retry.`,
    );
  }
  return { contract: actualContract, version, imageId };
}

async function requireHaloopImages(run) {
  const gateway = await requireImage(run, {
    image: HALOOP_IMAGE,
    contract: HALOOP_IMAGE_CONTRACT,
    contractLabel: "com.openrind.desktop.haloop-contract",
    service: "gateway",
  });
  const collector = await requireImage(run, {
    image: HALOOP_COLLECTOR_IMAGE,
    contract: HALOOP_COLLECTOR_IMAGE_CONTRACT,
    contractLabel: "com.openrind.desktop.haloop-collector-contract",
    service: "collector",
  });
  if (gateway.version !== collector.version) {
    throw new Error(
      `The Haloop gateway and collector image versions do not match (${gateway.version} versus ${collector.version}). Rebuild both pinned images together, then retry.`,
    );
  }
  if (
    HALOOP_IMAGE === HALOOP_PACKAGED_IMAGE &&
    HALOOP_COLLECTOR_IMAGE === HALOOP_PACKAGED_COLLECTOR_IMAGE &&
    gateway.version !== HALOOP_IMAGE_VERSION
  ) {
    throw new Error(
      `The packaged Haloop images report ${gateway.version}; expected the pinned version ${HALOOP_IMAGE_VERSION}.`,
    );
  }
  return { gateway, collector };
}

async function stageProfiles(run, serialized) {
  const script = [
    "set -euo pipefail",
    "umask 077",
    `install -d -m 0700 ${HALOOP_STATE_DIR}`,
    `install -d -o 10001 -g 10001 -m 0700 ${HALOOP_COLLECTOR_DATA_DIR}`,
    `install -m 0600 /dev/stdin ${HALOOP_PROFILES_FILE}.tmp`,
    `mv -f ${HALOOP_PROFILES_FILE}.tmp ${HALOOP_PROFILES_FILE}`,
  ].join("\n");
  const result = await run(
    ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
    { stdin: serialized, timeout: 20_000, user: "root" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not stage the Haloop route-profile registry: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function inspectContainer(run, name) {
  const result = await run(
    dockerArgs(
      "container",
      "inspect",
      name,
      "--format",
      `{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{ index .Config.Labels "${PROFILE_HASH_LABEL}" }}|{{.Image}}|{{ index .Config.Labels "${MANAGED_LABEL}" }}`,
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  const [running, health, profileHash, imageId, managed] = result.stdout.trim().split("|");
  return {
    running: running === "true",
    health,
    profileHash,
    imageId,
    managed: managed === "true",
  };
}

async function removeManagedContainer(run, name, service) {
  const result = await run(
    dockerArgs("container", "rm", "--force", name),
    { timeout: 60_000 },
  );
  if (result.exitCode !== 0 && !/no such container/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(
      `Could not replace the managed Haloop ${service} container: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function inspectNetwork(run) {
  const result = await run(
    dockerArgs(
      "network",
      "inspect",
      HALOOP_NETWORK_NAME,
      "--format",
      `{{ index .Labels "${MANAGED_NETWORK_LABEL}" }}`,
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  return { managed: result.stdout.trim() === "true" };
}

async function ensureManagedNetwork(run) {
  const network = await inspectNetwork(run);
  if (network && !network.managed) {
    throw new Error(
      `A Docker network named ${HALOOP_NETWORK_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
    );
  }
  if (network) return;
  const result = await run(
    dockerArgs(
      "network",
      "create",
      "--label",
      `${MANAGED_NETWORK_LABEL}=true`,
      HALOOP_NETWORK_NAME,
    ),
    { timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not create the private Haloop service network: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function resolveOpenShellBridgeAddress(run) {
  const result = await run(
    dockerArgs(
      "network",
      "inspect",
      OPENSHELL_SANDBOX_NETWORK_NAME,
      "--format",
      "{{json .IPAM.Config}}",
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not inspect the OpenShell sandbox network used by host.openshell.internal: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  let configs;
  try {
    configs = JSON.parse(result.stdout.trim());
  } catch {
    configs = null;
  }
  const address = Array.isArray(configs)
    ? configs
        .map((config) => String(config?.Gateway ?? "").trim())
        .find((gateway) => {
          const octets = gateway.split(".");
          return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
        })
    : "";
  if (!address) {
    throw new Error(
      `The OpenShell sandbox network ${OPENSHELL_SANDBOX_NETWORK_NAME} does not expose the IPv4 bridge address required by host.openshell.internal.`,
    );
  }
  return address;
}

async function removeManagedNetwork(run) {
  const result = await run(
    dockerArgs("network", "rm", HALOOP_NETWORK_NAME),
    { timeout: 20_000 },
  );
  if (result.exitCode !== 0 && !/no such network|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(
      `Could not remove the private Haloop service network: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function createCollectorContainer(run) {
  const result = await run(
    dockerArgs(
      "run",
      "--detach",
      "--name",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "--pull",
      HALOOP_IMAGE_PULL_POLICY,
      "--restart",
      "unless-stopped",
      "--init",
      "--network",
      HALOOP_NETWORK_NAME,
      "--memory",
      "1g",
      "--stop-timeout",
      String(SHUTDOWN_TIMEOUT_SECONDS),
      "--label",
      `${MANAGED_LABEL}=true`,
      "--mount",
      `type=bind,source=${HALOOP_COLLECTOR_DATA_DIR},target=${HALOOP_COLLECTOR_CONTAINER_DATA_DIR}`,
      "--env",
      `W8_DATA_DIR=${HALOOP_COLLECTOR_CONTAINER_DATA_DIR}`,
      "--env",
      "W8_DEFAULT_PROJECT=openrind-desktop",
      "--env",
      "W8_KEEP_RAW=0",
      HALOOP_COLLECTOR_IMAGE,
    ),
    { timeout: 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not start the private Haloop collector: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function createGatewayContainer(run, profileHash) {
  const publishAddress = await resolveOpenShellBridgeAddress(run);
  const result = await run(
    dockerArgs(
      "run",
      "--detach",
      "--name",
      HALOOP_CONTAINER_NAME,
      "--pull",
      HALOOP_IMAGE_PULL_POLICY,
      "--restart",
      "unless-stopped",
      "--init",
      "--network",
      HALOOP_NETWORK_NAME,
      "--memory",
      "2g",
      "--stop-timeout",
      String(SHUTDOWN_TIMEOUT_SECONDS),
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${PROFILE_HASH_LABEL}=${profileHash}`,
      "--publish",
      `${publishAddress}:${HALOOP_EDGE_PORT}:${HALOOP_EDGE_PORT}`,
      "--mount",
      `type=bind,source=${HALOOP_PROFILES_FILE},target=${HALOOP_CONTAINER_PROFILES_FILE},readonly`,
      "--env",
      `W8_OPENRIND_PROFILES_FILE=${HALOOP_CONTAINER_PROFILES_FILE}`,
      "--env",
      "W8_EDGE_HOST=0.0.0.0",
      "--env",
      `W8_EDGE_PORT=${HALOOP_EDGE_PORT}`,
      "--env",
      "W8_CORE_HOST=127.0.0.1",
      "--env",
      "W8_CORE_PORT=8786",
      "--env",
      "W8_CORE_URL=http://127.0.0.1:8786",
      "--env",
      "W8_SHUTDOWN_TIMEOUT_MS=30000",
      HALOOP_IMAGE,
    ),
    { timeout: 60_000 },
  );
  if (result.exitCode === 0) return;
  const detail = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
  if (/port is already allocated|address already in use|bind.*8787/i.test(detail)) {
    throw new Error(
      `Haloop cannot start because port ${HALOOP_EDGE_PORT} is already in use. Stop the conflicting service and retry; Openrind Desktop will not select a different endpoint.`,
    );
  }
  throw new Error(`Could not start the managed Haloop container: ${detail}`);
}

async function waitForHealthyContainer(run, name, service) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastHealth = "unknown";
  while (Date.now() < deadline) {
    const info = await inspectContainer(run, name);
    lastHealth = info?.health || (info?.running ? "starting" : "stopped");
    if (info?.running && info.health === "healthy") return info;
    if (info && !info.running) break;
    await delay(500);
  }
  throw new Error(
    `The managed Haloop ${service} did not become healthy within ${STARTUP_TIMEOUT_MS / 1000} seconds (last state: ${lastHealth}).`,
  );
}

async function requireCollectorFromGateway(run) {
  const probe = [
    `fetch('${HALOOP_COLLECTOR_URL}/healthz')`,
    ".then(async r=>{const j=await r.json().catch(()=>null);if(!r.ok||j?.status!=='ok'){console.error('unexpected collector response');process.exit(1)}})",
    ".catch(e=>{console.error(e.message);process.exit(1)})",
  ].join("");
  const result = await run(
    dockerArgs("exec", HALOOP_CONTAINER_NAME, "node", "-e", probe),
    { timeout: 15_000 },
  );
  if (result.exitCode === 0) return;
  throw new Error(
    "The Haloop gateway cannot reach its private collector. Sandbox creation is blocked.",
  );
}

async function requireAuthenticatedEdge(run) {
  const probe = [
    "fetch('http://127.0.0.1:8787/v1/messages',",
    "{method:'POST',headers:{'content-type':'application/json'},body:'{}'})",
    ".then(r=>{if(r.status!==401){console.error('unexpected status '+r.status);process.exit(1)}})",
    ".catch(e=>{console.error(e.message);process.exit(1)})",
  ].join("");
  const result = await run(
    dockerArgs("exec", HALOOP_CONTAINER_NAME, "node", "-e", probe),
    { timeout: 15_000 },
  );
  if (result.exitCode === 0) return;
  await run(
    dockerArgs("stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_CONTAINER_NAME),
    { timeout: 60_000 },
  ).catch(() => undefined);
  throw new Error(
    "The Haloop edge failed its authentication check and was stopped. Sandbox creation is blocked.",
  );
}

export function createHaloopRuntimeManager({
  run = wslRun,
  ensureDistro = ensureDistroRunning,
  registerProfile = registerHaloopClientProfile,
  revokeAllProfiles = revokeAllHaloopClientProfiles,
  revokeProfiles = revokeHaloopClientProfilesForSandbox,
  rotateProfile = rotateHaloopClientProfile,
  postSpans = postPrivateCollectorSpans,
} = {}) {
  let queue = Promise.resolve();
  let managedThisProcess = false;
  let lastReadyRoute = null;
  let lastConnectionError = null;
  const capturedBytesByTrace = new Map();
  const captureStatus = {
    written: 0,
    duplicates: 0,
    dropped: 0,
    redacted: 0,
    incomplete: 0,
    lastError: null,
    lastAttemptAt: null,
  };

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function serialize(operation) {
    const current = queue.then(() => operation(), () => operation());
    queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async function writeTrustedSpans(capture, events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("At least one trusted Desktop capture event is required.");
    }
    if (events.length > MAX_APP_SPANS_PER_BATCH) {
      throw new Error(`A Desktop capture batch exceeds ${MAX_APP_SPANS_PER_BATCH} spans.`);
    }
    const spans = events.map((event) => buildTrustedHaloopAppSpan(capture, event));
    const encoded = JSON.stringify(spans);
    const bytes = Buffer.byteLength(encoded, "utf8");
    const redacted = (encoded.match(/\[(?:REDACTED|TRUNCATED)\]/g) || []).length;
    const captured = capturedBytesByTrace.get(capture.traceId) || 0;
    if (captured + bytes > MAX_APP_CAPTURE_BYTES_PER_TRACE) {
      throw new Error(
        `Desktop capture reached its ${MAX_APP_CAPTURE_BYTES_PER_TRACE}-byte trace limit.`,
      );
    }
    const result = await postSpans(run, spans);
    capturedBytesByTrace.set(
      capture.traceId,
      captured + (result.written > 0 ? bytes : 0),
    );
    captureStatus.written += result.written;
    captureStatus.duplicates += result.duplicates;
    captureStatus.redacted += redacted;
    captureStatus.lastError = null;
    captureStatus.lastAttemptAt = Date.now();
    return result;
  }

  function recordApplicationSpans(capture, events) {
    return serialize(async () => {
      try {
        const result = await writeTrustedSpans(capture, events);
        return { ok: true, ...result };
      } catch (error) {
        captureStatus.dropped += Array.isArray(events) ? events.length : 1;
        captureStatus.incomplete += Array.isArray(events) ? events.length : 1;
        captureStatus.lastError = safeDiagnosticMessage(error);
        captureStatus.lastAttemptAt = Date.now();
        // Capture is deliberately fail-open after a route has begun serving.
        return { ok: false, written: 0, duplicates: 0, error: captureStatus.lastError };
      }
    });
  }

  async function ensureOperation(options = {}) {
      const upstreamKey = requiredSecret(options.anthropicApiKey, "ANTHROPIC_API_KEY");
      await ensureDistro();
      options.onProgress?.({
        phase: "haloop",
        message: "Checking the required Haloop inference edge…",
      });
      const images = await requireHaloopImages(run);
      const registration = await registerProfile({
        sandboxName: options.sandboxName,
        workspaceId: options.workspaceId,
        agentId: options.agentId,
      });
      if (!registration.current) {
        throw new Error("The scoped Haloop client profile could not be registered.");
      }
      const document = buildHaloopProfilesDocument(registration.profiles, upstreamKey);
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      const profileHash = createHash("sha256").update(serialized).digest("hex");
      await stageProfiles(run, serialized);

      let gatewayStartedThisOperation = false;
      let collectorStartedThisOperation = false;
      try {
        await ensureManagedNetwork(run);
        let collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
        let gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
        if (collector && !collector.managed) {
          throw new Error(
            `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
          );
        }
        if (gateway && !gateway.managed) {
          throw new Error(
            `A container named ${HALOOP_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
          );
        }
        if (collector && collector.imageId !== images.collector.imageId) {
          options.onProgress?.({
            phase: "haloop",
            message: "Applying the updated private Haloop collector…",
          });
          await removeManagedContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");
          collector = null;
        }
        if (!collector) {
          await createCollectorContainer(run);
          collectorStartedThisOperation = true;
        } else if (!collector.running) {
          const started = await run(
            dockerArgs("container", "start", HALOOP_COLLECTOR_CONTAINER_NAME),
            { timeout: 60_000 },
          );
          if (started.exitCode !== 0) {
            throw new Error(
              `Could not restart the private Haloop collector: ${(started.stderr || started.stdout).trim() || `exit ${started.exitCode}`}`,
            );
          }
          collectorStartedThisOperation = true;
        }
        await waitForHealthyContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");

        const reusableGateway =
          gateway?.profileHash === profileHash && gateway?.imageId === images.gateway.imageId;
        if (!reusableGateway && gateway) {
          options.onProgress?.({
            phase: "haloop",
            message: "Applying the updated Haloop route-profile registry…",
          });
          await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
          gateway = null;
        }
        if (!gateway) {
          await createGatewayContainer(run, profileHash);
          gatewayStartedThisOperation = true;
        } else if (!gateway.running) {
          const started = await run(
            dockerArgs("container", "start", HALOOP_CONTAINER_NAME),
            { timeout: 60_000 },
          );
          if (started.exitCode !== 0) {
            throw new Error(
              `Could not restart the managed Haloop container: ${(started.stderr || started.stdout).trim() || `exit ${started.exitCode}`}`,
            );
          }
          gatewayStartedThisOperation = true;
        }

        await waitForHealthyContainer(run, HALOOP_CONTAINER_NAME, "gateway");
        await requireCollectorFromGateway(run);
        await requireAuthenticatedEdge(run);
        const conversation = options.issueConversation === true
          ? issueHaloopConversationContext(registration.current, {
              agentSessionId: options.agentSessionId,
              contextId: options.haloopContextId,
            })
          : null;
        if (conversation) {
          const readyAt = Date.now();
          await writeTrustedSpans(conversation.capture, [
            {
              kind: "AGENT",
              eventId: "route-root",
              name: "openrind.agent.route",
              parentSpanId: "",
              startMs: readyAt,
              endMs: readyAt,
              attributes: {
                "openrind.agent.id": options.agentId,
                "openrind.lifecycle": "ready",
              },
            },
          ]);
        }
        managedThisProcess = true;
        options.onProgress?.({
          phase: "haloop",
          message: `Haloop ${images.gateway.version} routing and private trace capture are healthy.`,
        });
        const result = {
          endpoint: HALOOP_SANDBOX_ENDPOINT,
          routePolicy: HALOOP_ROUTE_POLICY,
          providerName: registration.current.providerName,
          clientToken: registration.current.clientToken,
          profileId: registration.current.id,
          version: images.gateway.version,
          ...(conversation
            ? {
                capture: conversation.capture,
                haloopContextId: conversation.contextId,
                sessionAssertion: conversation.assertion,
                sessionAssertionExpiresAt: conversation.expiresAtMs,
              }
            : {}),
        };
        lastReadyRoute = {
          profileId: registration.current.id,
          providerName: registration.current.providerName,
          sandboxName: options.sandboxName,
          workspaceId: options.workspaceId,
          agentId: options.agentId,
        };
        lastConnectionError = null;
        return result;
      } catch (error) {
        if (gatewayStartedThisOperation) {
          await run(
            dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_CONTAINER_NAME),
            { timeout: 60_000 },
          ).catch(() => undefined);
        }
        if (collectorStartedThisOperation) {
          await run(
            dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_COLLECTOR_CONTAINER_NAME),
            { timeout: 60_000 },
          ).catch(() => undefined);
        }
        await run(
          ["-d", DISTRO_NAME, "--", "rm", "-f", HALOOP_PROFILES_FILE],
          { timeout: 10_000, user: "root" },
        ).catch(() => undefined);
        throw error;
      }
  }

  function ensure(options = {}) {
    const operation = serialize(() => ensureOperation(options));
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function status() {
    return serialize(async () => {
      const checkedAt = Date.now();
      let images;
      try {
        images = await requireHaloopImages(run);
      } catch (error) {
        return {
          required: true,
          routePolicy: HALOOP_ROUTE_POLICY,
          state: "unavailable",
          endpoint: HALOOP_SANDBOX_ENDPOINT,
          version: null,
          health: null,
          collectorHealth: null,
          activeRoute: null,
          detail: safeDiagnosticMessage(error),
          lastConnectionError,
          spanCapture: { ...captureStatus },
          checkedAt,
        };
      }

      const network = await inspectNetwork(run);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      let state = "stopped";
      let detail = "Haloop routing and private trace capture will start automatically before a Claude or OpenClaw sandbox connects.";
      if (network && !network.managed) {
        state = "blocked";
        detail = `The reserved Docker network ${HALOOP_NETWORK_NAME} is owned by another process.`;
      } else if (gateway && !gateway.managed) {
        state = "blocked";
        detail = `The reserved container name ${HALOOP_CONTAINER_NAME} is owned by another process.`;
      } else if (collector && !collector.managed) {
        state = "blocked";
        detail = `The reserved container name ${HALOOP_COLLECTOR_CONTAINER_NAME} is owned by another process.`;
      } else if (gateway && gateway.imageId !== images.gateway.imageId) {
        state = "degraded";
        detail = "The Haloop gateway does not match the required Desktop image.";
      } else if (collector && collector.imageId !== images.collector.imageId) {
        state = "degraded";
        detail = "The private Haloop collector does not match the required Desktop image.";
      } else if (
        gateway?.running &&
        gateway.health === "healthy" &&
        collector?.running &&
        collector.health === "healthy"
      ) {
        state = "ready";
        detail = "Haloop routing and private trace capture are healthy.";
      } else if (
        (gateway?.running && gateway.health === "starting") ||
        (collector?.running && collector.health === "starting")
      ) {
        state = "starting";
        detail = "Haloop routing or private trace capture is starting and is not ready for sandbox traffic yet.";
      } else if (gateway?.running || collector?.running) {
        state = "degraded";
        detail = `Haloop is incomplete (gateway: ${gateway?.health || "stopped"}; collector: ${collector?.health || "stopped"}).`;
      }

      return {
        required: true,
        routePolicy: HALOOP_ROUTE_POLICY,
        state,
        endpoint: HALOOP_SANDBOX_ENDPOINT,
        version: images.gateway.version,
        health: gateway?.health ?? null,
        collectorHealth: collector?.health ?? null,
        activeRoute: lastReadyRoute
          ? {
              profileId: lastReadyRoute.profileId,
              providerName: lastReadyRoute.providerName,
              sandboxName: lastReadyRoute.sandboxName,
              agentId: lastReadyRoute.agentId,
            }
          : null,
        detail,
        lastConnectionError,
        spanCapture: { ...captureStatus },
        checkedAt,
      };
    });
  }

  function stop() {
    return serialize(async () => {
      if (!managedThisProcess) return;
      const stopErrors = [];
      const stoppedGateway = await run(
        dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_CONTAINER_NAME),
        { timeout: 60_000 },
      ).catch(() => null);
      if (stoppedGateway && stoppedGateway.exitCode !== 0 && !/no such container/i.test(`${stoppedGateway.stderr}\n${stoppedGateway.stdout}`)) {
        stopErrors.push("gateway");
      }
      const stoppedCollector = await run(
        dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_COLLECTOR_CONTAINER_NAME),
        { timeout: 60_000 },
      ).catch(() => null);
      if (stoppedCollector && stoppedCollector.exitCode !== 0 && !/no such container/i.test(`${stoppedCollector.stderr}\n${stoppedCollector.stdout}`)) {
        stopErrors.push("collector");
      }
      await run(
        ["-d", DISTRO_NAME, "--", "rm", "-f", HALOOP_PROFILES_FILE],
        { timeout: 10_000, user: "root" },
      ).catch(() => undefined);
      lastReadyRoute = null;
      capturedBytesByTrace.clear();
      if (stopErrors.length > 0) {
        throw new Error(
          `The managed Haloop ${stopErrors.join(" and ")} service${stopErrors.length === 1 ? "" : "s"} did not stop cleanly.`,
        );
      }
    });
  }

  async function restart(options = {}) {
    const upstreamKey = requiredSecret(options.anthropicApiKey, "ANTHROPIC_API_KEY");
    const route = lastReadyRoute ? { ...lastReadyRoute } : null;
    if (!route) {
      throw new Error(
        "Haloop has no active Desktop route to restart. Launch a Claude or OpenClaw sandbox first.",
      );
    }
    await stop();
    return ensure({
      anthropicApiKey: upstreamKey,
      sandboxName: route.sandboxName,
      workspaceId: route.workspaceId,
      agentId: route.agentId,
      onProgress: options.onProgress,
    });
  }

  function activeRoute() {
    return lastReadyRoute ? { ...lastReadyRoute } : null;
  }

  function restoreIncumbent(options = {}) {
    const operation = serialize(async () => {
      const upstreamKey = requiredSecret(options.anthropicApiKey, "ANTHROPIC_API_KEY");
      const route = lastReadyRoute ? { ...lastReadyRoute } : null;
      if (!route) {
        throw new Error(
          "Haloop has no active Desktop route to restore. Launch a Claude or OpenClaw sandbox first.",
        );
      }
      const expectedProfileId = String(options.expectedProfileId ?? "").trim();
      const expectedSandboxName = String(options.expectedSandboxName ?? "").trim();
      if (!expectedProfileId || !expectedSandboxName) {
        throw new Error("The exact active Haloop route identity is required for incumbent rollback.");
      }
      if (
        expectedProfileId !== route.profileId ||
        expectedSandboxName !== route.sandboxName
      ) {
        throw new Error(
          "The active Haloop route changed before incumbent rollback began. Refresh the route status and retry.",
        );
      }

      await ensureDistro();
      const images = await requireHaloopImages(run);
      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (!network) {
        throw new Error(
          "The managed Haloop network is unavailable. Restart Haloop before restoring the incumbent route.",
        );
      }
      if (
        !collector ||
        !collector.running ||
        collector.health !== "healthy" ||
        collector.imageId !== images.collector.imageId
      ) {
        throw new Error(
          "The private Haloop collector must be healthy before incumbent rollback. Restart Haloop, then retry.",
        );
      }

      await options.beforeRollback?.({ ...route });
      options.onProgress?.({
        phase: "haloop",
        message: "Restoring the approved incumbent-only Haloop route…",
      });
      if (gateway) {
        await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
      }
      const result = await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
        onProgress: options.onProgress,
      });
      if (result.profileId !== route.profileId) {
        throw new Error("The incumbent-only Haloop route identity changed during rollback.");
      }
      return {
        ...result,
        routePolicy: HALOOP_ROUTE_POLICY,
        sessionsPreserved: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function rotate(options = {}) {
    const operation = serialize(async () => {
      const upstreamKey = requiredSecret(options.anthropicApiKey, "ANTHROPIC_API_KEY");
      const route = lastReadyRoute ? { ...lastReadyRoute } : null;
      if (!route) {
        throw new Error(
          "Haloop has no active Desktop route to rotate. Launch a Claude or OpenClaw sandbox first.",
        );
      }
      const expectedProfileId = String(options.expectedProfileId ?? "").trim();
      const expectedSandboxName = String(options.expectedSandboxName ?? "").trim();
      if (!expectedProfileId || !expectedSandboxName) {
        throw new Error("The exact active Haloop route identity is required for token rotation.");
      }
      if (
        expectedProfileId !== route.profileId ||
        expectedSandboxName !== route.sandboxName
      ) {
        throw new Error(
          "The active Haloop route changed before token rotation began. Refresh the route status and retry.",
        );
      }

      await ensureDistro();
      await requireHaloopImages(run);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Token rotation is blocked.`,
        );
      }

      // End tracked agent processes before invalidating their assertion key.
      // The callback runs inside the same runtime queue as every registry
      // mutation, so no old credential is served after it completes.
      const affectedSessions = Number(await options.beforeRotate?.({ ...route })) || 0;
      if (gateway) {
        await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
      }

      const registration = await rotateProfile({
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
      });
      if (!registration.current || registration.current.id !== route.profileId) {
        throw new Error("The scoped Haloop client token could not be rotated safely.");
      }

      const result = await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
        onProgress: options.onProgress,
      });
      return { ...result, affectedSessions, relaunchRequired: true };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function revokeSandbox(options = {}) {
    const operation = serialize(async () => {
      const sandboxName = String(options.sandboxName ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(sandboxName)) {
        throw new Error("A valid sandbox name is required for Haloop revocation.");
      }
      const upstreamKey = String(options.anthropicApiKey ?? "").trim();
      await ensureDistro();

      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
        );
      }

      const activeTargetRoute = lastReadyRoute?.sandboxName === sandboxName
        ? { ...lastReadyRoute }
        : null;
      const affectedSessions = Number(await options.beforeRevoke?.({ sandboxName })) || 0;
      const revocation = await revokeProfiles({
        sandboxName,
        beforePersist: async ({ revoked = [] } = {}) => {
          const providerNames = [
            ...new Set([
              ...revoked.map((profile) => profile.providerName),
              ...(activeTargetRoute?.providerName ? [activeTargetRoute.providerName] : []),
            ]),
          ];
          if (revoked.length === 0 && !activeTargetRoute) return;
          // Withdraw the edge before deleting its encrypted source token. This
          // closes the only serving window for both tracked and stolen clients.
          const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
          if (gateway && !gateway.managed) {
            throw new Error(
              `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
            );
          }
          if (gateway) {
            await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
          }
          await options.beforeCredentialsRemoved?.({
            sandboxName,
            providerNames,
          });
        },
      });

      const remainingProfiles = Array.isArray(revocation.profiles)
        ? revocation.profiles
        : [];
      const unreadableProfiles = Number(revocation.unreadableProfiles) || 0;
      const revokedProfiles = Array.isArray(revocation.revoked)
        ? revocation.revoked.length
        : 0;
      if (revokedProfiles === 0 && !activeTargetRoute) {
        return {
          revokedProfiles: 0,
          remainingProfiles: remainingProfiles.length + unreadableProfiles,
          affectedSessions,
          routeReady: Boolean(lastReadyRoute),
        };
      }
      if (activeTargetRoute) lastReadyRoute = null;

      if (!upstreamKey || remainingProfiles.length === 0) {
        const currentCollector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
        if (currentCollector?.managed) {
          await removeManagedContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");
        }
        await run(
          ["-d", DISTRO_NAME, "--", "rm", "-f", HALOOP_PROFILES_FILE],
          { timeout: 10_000, user: "root" },
        ).catch(() => undefined);
        managedThisProcess = false;
        lastReadyRoute = null;
        return {
          revokedProfiles,
          remainingProfiles: remainingProfiles.length + unreadableProfiles,
          affectedSessions,
          routeReady: false,
        };
      }

      const previousRoute = lastReadyRoute;
      const survivor = previousRoute
        ? remainingProfiles.find((profile) => profile.id === previousRoute.profileId)
        : null;
      const selected = survivor ?? remainingProfiles[0];
      await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: selected.sandboxName,
        workspaceId: selected.workspaceId,
        agentId: selected.agentId,
        onProgress: options.onProgress,
      });
      return {
        revokedProfiles,
        remainingProfiles: remainingProfiles.length + unreadableProfiles,
        affectedSessions,
        routeReady: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function revokeIntegration(options = {}) {
    const operation = serialize(async () => {
      await ensureDistro();
      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }

      const activeRoute = lastReadyRoute ? { ...lastReadyRoute } : null;
      const affectedSessions = Number(await options.beforeRevoke?.()) || 0;
      const revocation = await revokeAllProfiles({
        beforePersist: async ({ revoked = [] } = {}) => {
          const providerNames = [
            ...new Set([
              ...revoked.map((profile) => profile.providerName),
              ...(activeRoute?.providerName ? [activeRoute.providerName] : []),
            ]),
          ];
          // The public edge is the only place a scoped client token can be
          // served. Withdraw it before providers or encrypted source records.
          if (gateway) {
            await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
          }
          await options.beforeCredentialsRemoved?.({ providerNames });
        },
      });

      // Encrypted client identities are gone and the edge is already down, so
      // this route must not be reported as recoverable even if later container
      // or network cleanup needs an operator retry.
      managedThisProcess = false;
      lastReadyRoute = null;

      if (collector) {
        await removeManagedContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");
      }
      const removedRegistry = await run(
        ["-d", DISTRO_NAME, "--", "rm", "-f", HALOOP_PROFILES_FILE],
        { timeout: 10_000, user: "root" },
      );
      if (removedRegistry.exitCode !== 0) {
        throw new Error(
          `Could not remove the Haloop route-profile registry: ${(removedRegistry.stderr || removedRegistry.stdout).trim() || `exit ${removedRegistry.exitCode}`}`,
        );
      }
      if (network) await removeManagedNetwork(run);

      const revokedProfiles = Array.isArray(revocation.revoked)
        ? revocation.revoked.length
        : 0;
      managedThisProcess = false;
      lastConnectionError = null;
      capturedBytesByTrace.clear();
      return {
        revokedProfiles,
        affectedSessions,
        routeReady: false,
        runtimeRemoved: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  return {
    activeRoute,
    ensure,
    recordApplicationSpans,
    restart,
    restoreIncumbent,
    revokeIntegration,
    revokeSandbox,
    rotate,
    status,
    stop,
  };
}

const runtimeManager = createHaloopRuntimeManager();

export function ensureHaloopRuntime(options) {
  return runtimeManager.ensure(options);
}

export function getHaloopRuntimeStatus() {
  return runtimeManager.status();
}

export function recordHaloopApplicationSpans(capture, events) {
  return runtimeManager.recordApplicationSpans(capture, events);
}

export function restartHaloopRuntime(options) {
  return runtimeManager.restart(options);
}

export function getHaloopRuntimeActiveRoute() {
  return runtimeManager.activeRoute();
}

export function restoreHaloopIncumbentRoute(options) {
  return runtimeManager.restoreIncumbent(options);
}

export function rotateHaloopRuntime(options) {
  return runtimeManager.rotate(options);
}

export function revokeHaloopSandboxProfiles(options) {
  return runtimeManager.revokeSandbox(options);
}

export function revokeHaloopIntegration(options) {
  return runtimeManager.revokeIntegration(options);
}

export function stopHaloopRuntime() {
  return runtimeManager.stop();
}

export const __testing = {
  HALOOP_CONTAINER_PROFILES_FILE,
  HALOOP_COLLECTOR_DATA_DIR,
  HALOOP_COLLECTOR_URL,
  HALOOP_PROFILES_FILE,
  MANAGED_NETWORK_LABEL,
  OPENSHELL_SANDBOX_NETWORK_NAME,
  PROFILE_HASH_LABEL,
  STARTUP_TIMEOUT_MS,
  inspectContainer,
  resolveOpenShellBridgeAddress,
};
