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
  assert.match(dockerfile, /fuse-metadata-cache-v11/);
  assert.match(dockerfile, /openrind-pty-bridge\.py/);
  assert.match(sandbox, /IMAGE_CONTRACT = "fuse-metadata-cache-v11"/);
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
  assert.match(sandbox, /target: CLAUDE_HOME_MOUNT/);
  assert.match(setup, /OPENRIND_SHELL_CLAUDE_HOME=\/sandbox\/claude-home/);
  assert.match(setup, /\.local\/bin\/claude/);
  assert.match(wrapper, /OPENRIND_SHELL_CLAUDE_HOME:-\/sandbox\/claude-home/);
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
