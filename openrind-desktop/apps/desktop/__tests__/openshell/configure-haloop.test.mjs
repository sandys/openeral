import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");
const configurator = path.join(
  repositoryRoot,
  "sandboxes",
  "openeral",
  "configure-haloop.mjs",
);

test("Haloop configurator pins the edge and removes persisted bypass state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrind-haloop-test-"));
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const currentPresign = path.join(home, ".openrind-shell", "presign.json");
  const legacyPresign = path.join(home, ".openeral", "presign.json");

  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(path.dirname(currentPresign), { recursive: true });
    await mkdir(path.dirname(legacyPresign), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "upstream-secret",
          ANTHROPIC_AUTH_TOKEN: "direct-token",
          ANTHROPIC_CUSTOM_HEADERS: "x-openrind-haloop-session: attacker",
          OPENRIND_GATEWAY_PROXY_URL: "https://legacy.invalid",
          KEEP_ME: "safe",
        },
      }),
    );
    await writeFile(currentPresign, "legacy");
    await writeFile(legacyPresign, "legacy");

    const result = await run(process.execPath, [configurator], {
      env: {
        ...process.env,
        OPENRIND_SHELL_HOME: home,
        OPENRIND_SHELL_RUNTIME_DIR: runtime,
      },
    });
    assert.match(result.stdout, /Required Haloop routing configured/);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(
      settings.env.ANTHROPIC_BASE_URL,
      "http://host.openshell.internal:8787",
    );
    assert.equal(settings.env.KEEP_ME, "safe");
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(settings.env.OPENRIND_GATEWAY_PROXY_URL, undefined);
    assert.equal(
      await readFile(path.join(runtime, "anthropic-base-url"), "utf8"),
      "http://host.openshell.internal:8787\n",
    );
    await assert.rejects(readFile(currentPresign, "utf8"), /ENOENT/);
    await assert.rejects(readFile(legacyPresign, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
