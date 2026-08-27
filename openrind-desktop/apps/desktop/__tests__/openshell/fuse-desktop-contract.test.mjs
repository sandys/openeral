import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("desktop image and runtime share the current PTY bridge contract", async () => {
  const [dockerfile, sandbox] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
  ]);
  assert.match(dockerfile, /fuse-openclaw-anthropic-v18/);
  assert.match(dockerfile, /openrind-pty-bridge\.py/);
  assert.match(sandbox, /IMAGE_CONTRACT = "fuse-openclaw-anthropic-v18"/);
});

test("FUSE policy permits bridge PTY allocation without exposing dev fuse", async () => {
  const policy = await source("sandboxes/openeral/policy.yaml");
  assert.match(policy, /^\s*- \/dev\/pts\s*$/m);
  assert.doesNotMatch(policy, /^\s*- \/dev\/fuse\s*$/m);
});

test("desktop provisioning preserves the README one-shot create contract", async () => {
  const sandbox = await source(
    "openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs",
  );
  for (const fragment of [
    '"  --fuse"',
    "--driver-config-json",
    "/sandbox/db-url",
    '"  --provider claude"',
    '"  --auto-providers"',
    '"  --no-tty"',
    '"  -- openrind-shell-init"',
  ]) {
    assert.ok(sandbox.includes(fragment), `missing create fragment: ${fragment}`);
  }
});

test("Claude state uses a persistent per-workspace Docker volume", async () => {
  const [sandbox, setup, wrapper] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openeral-claude-fuse.sh"),
  ]);
  assert.match(sandbox, /openrind-claude-home-/);
  assert.match(sandbox, /target: agent\.homeMount/);
  assert.match(setup, /OPENRIND_SHELL_CLAUDE_HOME=\/sandbox\/claude-home/);
  assert.match(setup, /\.local\/bin\/claude/);
  assert.match(wrapper, /OPENRIND_SHELL_CLAUDE_HOME:-\/sandbox\/claude-home/);
});

test("OpenClaw uses the same FUSE workspace with a separate persistent agent home", async () => {
  const [dockerfile, sandbox, setup, launcher, config, bridge, modal] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
    source("sandboxes/openeral/configure-openclaw-fuse.mjs"),
    source("sandboxes/openeral/openrind-pty-bridge.py"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/modals/create-sandbox-modal.tsx",
    ),
  ]);
  assert.match(dockerfile, /openclaw@\$\{OPENCLAW_VERSION\}/);
  assert.match(dockerfile, /\/sandbox\/openclaw-home/);
  assert.match(sandbox, /openrind-openclaw-home-/);
  assert.match(sandbox, /OPENRIND_SHELL_AGENT=\$\{agent\.id\}/);
  assert.match(setup, /OPENRIND_SHELL_OPENCLAW_HOME=\/sandbox\/openclaw-home/);
  assert.match(setup, /\/usr\/local\/bin\/openrind-openclaw/);
  assert.match(launcher, /openclaw "\$\{args\[@\]\}"/);
  assert.match(launcher, /args=\(tui --local\)/);
  assert.match(config, /const WORKSPACE = "\/sandbox\/work"/);
  assert.match(setup, /OPENRIND_SHELL_PTY_KEEP_SCROLLBACK=0/);
  assert.doesNotMatch(setup, /OPENRIND_SHELL_PTY_PIN_OPENCLAW_BANNER/);
  assert.match(setup, /OPENRIND_SHELL_PTY_SHOW_OPENCLAW_BANNER=1/);
  assert.match(bridge, /OPENCLAW_BANNER_MARKER = b"OpenClaw "/);
  assert.match(bridge, /def _observe_openclaw_banner/);
  assert.doesNotMatch(bridge, /_capture_openclaw_banner|_banner_capture/);
  assert.match(config, /config\.agents\.defaults\.models\[primaryModel\]/);
  assert.match(config, /anthropic\/claude-sonnet-4-6/);
  assert.doesNotMatch(config, /OPENROUTER_API_KEY|openrouter\//i);
  assert.doesNotMatch(config, /models\.providers/);
  assert.match(modal, /option value="openrind-shell-openclaw"/);
});

test("desktop uploads and file listings use the agent-visible FUSE inbox", async () => {
  const [sandbox, main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.match(sandbox, /destinationDirectory = "\/sandbox\/work\/inbox"/);
  assert.match(sandbox, /export async function listWorkspaceFiles/);
  assert.match(sandbox, /const directory = "\/sandbox\/work\/inbox"/);
  assert.match(main, /case "openrindShellListFiles"/);
  assert.match(terminal, /"openrindShellListFiles"/);
  assert.doesNotMatch(terminal, /setUploadedFiles/);
});

test("Claude launch uses the marker, Linux PTY bridge, and native provider binary", async () => {
  const [setup, provider] = await Promise.all([
    source("sandboxes/openeral/setup-fuse.sh"),
    source("vendor/openshell/providers/claude-code.yaml"),
  ]);
  assert.match(setup, /desktop-session/);
  assert.match(setup, /openrind-pty-bridge\.py/);
  assert.match(setup, /\/usr\/local\/bin\/claude/);
  assert.match(provider, /\/usr\/local\/bin\/claude-real/);
});

test("framed PTY output unconditionally filters scrollback erasure", async () => {
  const bridge = await source("sandboxes/openeral/openrind-pty-bridge.py");
  assert.match(bridge, /self\.enabled and window\.startswith\(CLEAR_AND_HOME\)/);
  assert.match(bridge, /if ERASE_SCROLLBACK\.startswith\(self\._held\):\s+return b""/);
  assert.match(
    bridge,
    /write_all\(1, _keeper\.feed\(TERMINAL_RESET\) \+ _keeper\.flush\(\)\)/,
  );
  assert.doesNotMatch(bridge, /if not self\.enabled:\s+return chunk/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESET\)/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESTORE\)/);
});
