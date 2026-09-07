#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const HALOOP_ANTHROPIC_BASE_URL =
  "http://host.openshell.internal:8787";

const home =
  process.env.OPENRIND_SHELL_HOME ||
  process.env.OPENERAL_HOME ||
  "/sandbox/work";
const runtimeDir =
  process.env.OPENRIND_SHELL_RUNTIME_DIR ||
  process.env.OPENERAL_RUNTIME_DIR ||
  "/var/lib/openrind-shell/runtime";
const settingsPath = join(home, ".claude", "settings.json");
const baseUrlPath = join(runtimeDir, "anthropic-base-url");

function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function main() {
  const settings = readSettings();
  settings.env =
    settings.env &&
    typeof settings.env === "object" &&
    !Array.isArray(settings.env)
      ? settings.env
      : {};
  settings.env.ANTHROPIC_BASE_URL = HALOOP_ANTHROPIC_BASE_URL;

  // OpenShell supplies the scoped client credential at request time. Never
  // persist either that token or an upstream provider key in agent state.
  delete settings.env.ANTHROPIC_API_KEY;
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_CUSTOM_HEADERS;
  delete settings.env.CLAUDE_API_KEY;
  delete settings.env.OPENRIND_GATEWAY_API_KEY;
  delete settings.env.STRINGCOST_API_KEY;
  delete settings.env.OPENRIND_GATEWAY_PROXY_URL;
  delete settings.env.STRINGCOST_PROXY_URL;

  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(settingsPath, 0o600);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(baseUrlPath, `${HALOOP_ANTHROPIC_BASE_URL}\n`, {
    mode: 0o600,
  });
  chmodSync(baseUrlPath, 0o600);

  // Remove obsolete presign state so a resumed session cannot silently route
  // around Haloop through the retired gateway path.
  rmSync(join(home, ".openrind-shell", "presign.json"), { force: true });
  rmSync(join(home, ".openeral", "presign.json"), { force: true });
  process.stdout.write("setup-fuse.sh: Required Haloop routing configured\n");
}

main();
