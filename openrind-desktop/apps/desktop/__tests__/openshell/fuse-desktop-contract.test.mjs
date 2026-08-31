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
  assert.match(dockerfile, /fuse-openclaw-identity-v22/);
  assert.match(dockerfile, /openrind-pty-bridge\.py/);
  assert.match(sandbox, /IMAGE_CONTRACT = "fuse-openclaw-identity-v22"/);
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
  const [
    dockerfile,
    sandbox,
    setup,
    launcher,
    nativeLauncher,
    config,
    runtimePackage,
    bridge,
    modal,
    provider,
  ] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
    source("sandboxes/openeral/openclaw-agent-launcher.c"),
    source("sandboxes/openeral/configure-openclaw-fuse.mjs"),
    source("openeral-js/package.json"),
    source("sandboxes/openeral/openrind-pty-bridge.py"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/modals/create-sandbox-modal.tsx",
    ),
    source("vendor/openshell/providers/claude-code.yaml"),
  ]);
  assert.match(dockerfile, /openclaw@\$\{OPENCLAW_VERSION\}/);
  assert.match(dockerfile, /\/sandbox\/openclaw-home/);
  assert.match(sandbox, /openrind-openclaw-home-/);
  assert.match(sandbox, /OPENRIND_SHELL_AGENT=\$\{agent\.id\}/);
  assert.match(sandbox, /getCredential\("anthropicApiKey"\)/);
  assert.match(sandbox, /ANTHROPIC_API_KEY is required/);
  assert.doesNotMatch(sandbox, /OPENROUTER|openrouter|TEMPORARY_USE_OPENROUTER/);
  assert.match(setup, /OPENRIND_SHELL_OPENCLAW_HOME=\/sandbox\/openclaw-home/);
  assert.match(setup, /\/usr\/local\/bin\/openrind-openclaw/);
  assert.match(launcher, /openrind-openclaw-agent "\$\{session_args\[@\]\}"/);
  assert.doesNotMatch(launcher, /^\s*set\s+[-+][A-Za-z]*e[A-Za-z]*\b/m);
  assert.match(launcher, /if ! install -d -m 0700/);
  assert.match(launcher, /if ! cd "\$OPENRIND_SHELL_HOME"/);
  assert.doesNotMatch(launcher, /configure-openclaw-fuse\.mjs/);
  assert.doesNotMatch(launcher, /for target_skills_dir/);
  assert.match(setup, /\/usr\/lib\/node_modules\/openclaw\/openclaw\.mjs tui --help/);
  assert.match(setup, /NODE_COMPILE_CACHE="\$OPENRIND_OPENCLAW_COMPILE_CACHE"/);
  assert.match(setup, /configure-openclaw-fuse\.mjs/);
  assert.match(launcher, /if ! exec 3<&0/);
  assert.match(launcher, /if \[ ! -x \/usr\/local\/bin\/openrind-openclaw-agent \]/);
  assert.match(launcher, /if wait "\$child"/);
  assert.match(launcher, /if ! openrind-shell-fused flush-all/);
  assert.match(nativeLauncher, /\(char \*\)"tui"/);
  assert.match(nativeLauncher, /\(char \*\)"--local"/);
  assert.match(nativeLauncher, /static const char prefix\[\] = "--session="/);
  assert.match(nativeLauncher, /if \(argc > 2\)/);
  assert.match(dockerfile, /openrind-openclaw-agent openclaw-agent-launcher\.c/);
  assert.match(dockerfile, /test -x \/usr\/bin\/openclaw/);
  assert.match(nativeLauncher, /NODE_BIN\[\] = "\/usr\/bin\/node"/);
  assert.match(
    nativeLauncher,
    /OPENCLAW_ENTRYPOINT\[\] = "\/usr\/lib\/node_modules\/openclaw\/openclaw\.mjs"/,
  );
  assert.match(nativeLauncher, /unsetenv\("NODE_OPTIONS"\)/);
  assert.match(nativeLauncher, /execv\(NODE_BIN, openclaw_argv\)/);
  assert.match(provider, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(provider, /\/usr\/bin\/node/);
  assert.match(config, /const WORKSPACE = "\/sandbox\/work"/);
  assert.match(setup, /OPENRIND_SHELL_PTY_KEEP_SCROLLBACK=0/);
  assert.doesNotMatch(setup, /OPENRIND_SHELL_PTY_PIN_OPENCLAW_BANNER/);
  assert.match(setup, /OPENRIND_SHELL_PTY_SHOW_OPENCLAW_BANNER=1/);
  assert.match(bridge, /OPENCLAW_BANNER_MARKER = b"OpenClaw "/);
  assert.match(bridge, /def _observe_openclaw_banner/);
  assert.doesNotMatch(bridge, /_capture_openclaw_banner|_banner_capture/);
  assert.match(
    bridge,
    /if \(self\.enabled or self\._openclaw_banner\) and window\.startswith\(/,
  );
  assert.match(
    bridge,
    /if self\.scrolls < self\._max_rewrites:[\s\S]*?if self\._openclaw_banner:[\s\S]*?self\.scrolls \+= 1/,
  );
  assert.match(
    bridge,
    /self\.passthroughs \+= 1\s+out \+= CLEAR_AND_HOME/,
  );
  assert.doesNotMatch(
    bridge,
    /if self\._openclaw_banner and window\.startswith\(CLEAR_AND_HOME\)/,
  );
  assert.match(setup, /shared clear-rewrite budget/);
  assert.match(config, /config\.agents\.defaults\.models\[primaryModel\]/);
  assert.match(config, /const PROVIDER_ID = "openrind-gateway"/);
  assert.match(config, /const DEFAULT_MODEL_ID = "claude-sonnet-4-6"/);
  assert.doesNotMatch(config, /OPENRIND_SHELL_USE_OPENROUTER_TEST|openrouter\/openrouter\/free/);
  assert.match(config, /delete config\.env\.OPENROUTER_API_KEY/);
  assert.match(config, /delete config\.models\.providers\.openrouter/);
  assert.match(config, /api: "anthropic-messages"/);
  assert.match(config, /import JSON5 from "json5"/);
  assert.match(config, /JSON5\.parse\(source\)/);
  assert.doesNotMatch(config, /JSON\.parse\(normalized\)|\.replace\(/);
  assert.equal(JSON.parse(runtimePackage).dependencies.json5, "2.2.3");
  assert.doesNotMatch(launcher, /OPENROUTER_API_KEY|OPENRIND_SHELL_USE_OPENROUTER_TEST/);
  assert.doesNotMatch(config, /sk-or-v1-/);
  assert.doesNotMatch(launcher, /sk-or-v1-/);
  assert.doesNotMatch(sandbox, /sk-or-v1-/);
  assert.match(modal, /option value="openrind-shell-openclaw"/);
});

test("desktop uploads and file listings use the agent-visible FUSE inbox", async () => {
  const [sandbox, facade, management, main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-management.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.match(sandbox, /destinationDirectory = "\/sandbox\/work\/inbox"/);
  assert.match(facade, /uploadWorkspaceFile/);
  assert.match(facade, /listWorkspaceFiles/);
  assert.match(facade, /deleteWorkspaceFile/);
  assert.match(sandbox, /export async function listWorkspaceFiles/);
  assert.match(sandbox, /const directory = "\/sandbox\/work\/inbox"/);
  assert.match(management, /\["sandbox", "list", "-o", "json"\]/);
  assert.doesNotMatch(management, /"--names"/);
  assert.match(main, /openrindShell\.uploadWorkspaceFile/);
  assert.match(main, /case "openrindShellListFiles"/);
  assert.match(main, /openrindShell\.listWorkspaceFiles/);
  assert.match(main, /openrindShell\.deleteWorkspaceFile/);
  assert.doesNotMatch(main, /\/home\/agent\/inbox/);
  assert.match(terminal, /"openrindShellListFiles"/);
  assert.doesNotMatch(terminal, /setUploadedFiles/);
});

test("desktop downloads sandbox artifacts to a user-selected host path with OpenShell", async () => {
  const [sandbox, main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.match(sandbox, /export async function downloadWorkspaceFile/);
  assert.match(
    sandbox,
    /const source = `\/sandbox\/work\/inbox\/\$\{safeFilename\}`/,
  );
  assert.match(
    sandbox,
    /\["sandbox", "download", name, source, destination\]/,
  );
  assert.match(main, /case "openrindShellDownloadFile"/);
  assert.match(main, /dialog\.showSaveDialog/);
  assert.match(main, /app\.getPath\("downloads"\)/);
  assert.match(main, /filters: downloadDialogFilters\(filename\)/);
  assert.match(
    main,
    /preserveDownloadExtension\(result\.filePath, filename\)/,
  );
  assert.match(main, /toWslPath\(destinationPath\)/);
  assert.match(terminal, /"openrindShellDownloadFile"/);
  assert.match(terminal, /title="Download to computer"/);
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

test("desktop connections replace the login shell and keep first paint free of setup work", async () => {
  const [facade, main, setup, desktopLauncher, claudeLauncher, openclawLauncher] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openrind-desktop-claude-launch.sh"),
    source("sandboxes/openeral/openeral-claude-fuse.sh"),
    source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
  ]);

  assert.match(facade, /exec \/usr\/local\/bin\/openrind-desktop-claude-launch/);
  assert.match(desktopLauncher, /set -- \/usr\/local\/bin\/claude/);
  assert.match(desktopLauncher, /set -- \/usr\/local\/bin\/openrind-openclaw/);
  assert.match(
    desktopLauncher,
    /exec \/usr\/local\/bin\/openrind-pty-bridge\.py --framed "\$@"/,
  );
  assert.doesNotMatch(desktopLauncher, /AGENT_BIN|command -v openclaw|\/usr\/bin\/opencode/);
  assert.doesNotMatch(desktopLauncher, /exec \/bin\/bash/);
  assert.doesNotMatch(main, /OPENROUTER_API_KEY|openrouterApiKey/);
  assert.match(desktopLauncher, /node \/opt\/openrind-shell\/configure-openrind-gateway\.mjs/);
  assert.match(setup, /"\$OPENRIND_SHELL_HOME\/\.claude\/skills"/);
  assert.match(setup, /claude-real --version/);

  assert.match(claudeLauncher, /OPENRIND_SHELL_HOME=\/sandbox\/work/);
  assert.match(claudeLauncher, /if \[ "\$STATE" != writable \]/);
  assert.match(
    claudeLauncher,
    /OPENRIND_DESKTOP_CLAUDE_LAUNCH:-0}" != "1"[\s\S]*?openrind-shell init --ensure/,
  );
  assert.doesNotMatch(claudeLauncher, /for target_skills_dir/);
  assert.match(claudeLauncher, /\/usr\/local\/bin\/claude-real/);

  assert.match(openclawLauncher, /OPENRIND_SHELL_HOME=\/sandbox\/work/);
  assert.match(openclawLauncher, /if ! cd "\$OPENRIND_SHELL_HOME"/);
  assert.match(openclawLauncher, /if \[ "\$STATE" != writable \]/);
  assert.match(openclawLauncher, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(openclawLauncher, /configure-openclaw-fuse\.mjs/);
  assert.doesNotMatch(openclawLauncher, /for target_skills_dir/);
});

test("framed PTY output unconditionally filters scrollback erasure", async () => {
  const bridge = await source("sandboxes/openeral/openrind-pty-bridge.py");
  assert.match(
    bridge,
    /\(self\.enabled or self\._openclaw_banner\) and window\.startswith\(/,
  );
  assert.match(bridge, /if ERASE_SCROLLBACK\.startswith\(self\._held\):\s+return b""/);
  assert.match(
    bridge,
    /write_all\(1, _keeper\.feed\(TERMINAL_RESET\) \+ _keeper\.flush\(\)\)/,
  );
  assert.doesNotMatch(bridge, /if not self\.enabled:\s+return chunk/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESET\)/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESTORE\)/);
});
