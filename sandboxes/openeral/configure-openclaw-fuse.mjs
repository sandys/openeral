#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const OPENCLAW_HOME = "/sandbox/openclaw-home";
const WORKSPACE = "/sandbox/work";
const home = resolve(process.env.HOME || OPENCLAW_HOME);

if (home !== OPENCLAW_HOME) {
  throw new Error(`OpenClaw HOME must be ${OPENCLAW_HOME}; received ${home}`);
}

const configPath = join(home, ".openclaw", "openclaw.json");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig() {
  if (!existsSync(configPath)) return {};
  const source = readFileSync(configPath, "utf8");
  if (!source.trim()) return {};
  try {
    const parsed = JSON.parse(source);
    return isObject(parsed) ? parsed : {};
  } catch {
    // OpenClaw accepts JSON5. This deliberately handles only comments and
    // trailing commas so an invalid user file is preserved rather than being
    // silently replaced by an over-eager parser.
    try {
      const normalized = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:\"'\\])\/\/[^\n]*/g, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      const parsed = JSON.parse(normalized);
      return isObject(parsed) ? parsed : {};
    } catch {
      const backup = `${configPath}.invalid-${Date.now()}`;
      renameSync(configPath, backup);
      process.stderr.write(`OpenClaw config was invalid and was preserved at ${backup}\n`);
      return {};
    }
  }
}

const config = readConfig();
config.gateway = isObject(config.gateway) ? config.gateway : {};
config.gateway.mode = "local";
config.gateway.bind = "loopback";
config.gateway.auth = { mode: "none" };
delete config.gateway.remote;
delete config.gateway.tailscale;
delete config.gateway.tls;

config.agents = isObject(config.agents) ? config.agents : {};
config.agents.defaults = isObject(config.agents.defaults) ? config.agents.defaults : {};
config.agents.defaults.workspace = WORKSPACE;
config.agents.defaults.model = isObject(config.agents.defaults.model)
  ? config.agents.defaults.model
  : {};
config.agents.defaults.models = isObject(config.agents.defaults.models)
  ? config.agents.defaults.models
  : {};

const requestedModel = String(process.env.OPENRIND_SHELL_OPENCLAW_MODEL || "").trim();
const configuredModel = String(config.agents.defaults.model.primary || "").trim();
const defaultModel = "anthropic/claude-sonnet-4-6";

// Credentials are injected by the OpenShell Claude provider. Preserve a user's
// Anthropic model choice, while migrating any temporary test-provider model
// back to the production Anthropic default.
const candidateModel = requestedModel || configuredModel;
const primaryModel = candidateModel.startsWith("anthropic/")
  ? candidateModel
  : defaultModel;
config.agents.defaults.model.primary = primaryModel;

config.agents.defaults.models[primaryModel] = isObject(
  config.agents.defaults.models[primaryModel],
)
  ? config.agents.defaults.models[primaryModel]
  : {};

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".openclaw", "logs"), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, configPath);
chmodSync(configPath, 0o600);
