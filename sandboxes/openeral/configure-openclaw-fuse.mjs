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
import JSON5 from "json5";

const OPENCLAW_HOME = "/sandbox/openclaw-home";
const WORKSPACE = "/sandbox/work";
const PROVIDER_ID = "openrind-gateway";
const PROVIDER_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
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
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Match OpenClaw's parser: strict JSON first, then json5@2.2.3.
    try {
      parsed = JSON5.parse(source);
    } catch {
      const backup = `${configPath}.invalid-${Date.now()}`;
      renameSync(configPath, backup);
      process.stderr.write(`OpenClaw config was invalid and was preserved at ${backup}\n`);
      return {};
    }
  }
  return isObject(parsed) ? parsed : {};
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
config.models = isObject(config.models) ? config.models : {};
config.models.providers = isObject(config.models.providers)
  ? config.models.providers
  : {};

const requestedModel = String(
  process.env.OPENRIND_SHELL_OPENCLAW_MODEL || "",
).trim();
const configuredModel = String(config.agents.defaults.model.primary || "").trim();
const providerPrefix = `${PROVIDER_ID}/`;
const defaultModel = `${providerPrefix}${DEFAULT_MODEL_ID}`;

const candidateModel = requestedModel || configuredModel;
const primaryModel = candidateModel.startsWith(providerPrefix) && candidateModel.length > providerPrefix.length
    ? candidateModel
    : defaultModel;
config.agents.defaults.model.primary = primaryModel;

for (const model of Object.keys(config.agents.defaults.models)) {
  if (model.startsWith("openrouter/")) delete config.agents.defaults.models[model];
}
config.agents.defaults.models[primaryModel] = isObject(
  config.agents.defaults.models[primaryModel],
)
  ? config.agents.defaults.models[primaryModel]
  : {};

config.env = isObject(config.env) ? config.env : {};
delete config.env.OPENROUTER_API_KEY;
delete config.models.providers.openrouter;
const modelId = primaryModel.slice(providerPrefix.length);
config.models.providers[PROVIDER_ID] = {
  baseUrl: PROVIDER_BASE_URL,
  apiKey: "${ANTHROPIC_API_KEY}",
  api: "anthropic-messages",
  models: [{ id: modelId, name: modelId === DEFAULT_MODEL_ID ? "Claude Sonnet 4.6" : modelId }],
};

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".openclaw", "logs"), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, configPath);
chmodSync(configPath, 0o600);
