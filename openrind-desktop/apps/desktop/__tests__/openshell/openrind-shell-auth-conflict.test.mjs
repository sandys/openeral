// Claude Code auth-mode exclusivity.
//
// Why this test exists: Claude Code opens with
//
//   "Auth conflict: Both a token (ANTHROPIC_AUTH_TOKEN) and an API key
//    (ANTHROPIC_API_KEY) are set. This may lead to unexpected behavior."
//
// whenever both are visible to it. setup.sh's exec already scrubs the token
// from the process environment (`env -u ANTHROPIC_AUTH_TOKEN`), and that was
// believed to be sufficient — it is not. Claude Code applies the `env` block of
// its settings files ON TOP of the process environment, so a token written into
// /sandbox/.claude/settings.json (PROJECT settings, cwd=/sandbox) or
// /home/agent/.claude/settings.json (user settings, HOME=/home/agent) reappears
// after the scrub. Both files were writing the placeholder token unconditionally
// while the API key stayed in the environment on purpose.
//
// The rule these tests pin: the placeholder token exists only to stop Claude
// prompting for login when there is NO api key, so token and key are mutually
// exclusive — and the no-proxy branch must take the file back down rather than
// leaving a stale token behind forever.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const openrindShell = await import(
  "../../electron/openshell/openrind-shell.mjs"
);
const { buildClaudeProjectSettingsLines, OPENRIND_GATEWAY_PLACEHOLDER_AUTH_TOKEN } =
  openrindShell.__testing;

const PROXY = "https://proxy.openrind.com/openrind-gateway-proxy/t/TOKEN123";
const KEY = "sk-ant-api03-example";

/**
 * Actually RUN the generated node command against a temp file and return the
 * resulting settings object. Asserting on the command string would pass even if
 * the embedded JS were broken, and this code only ever runs inside a sandbox
 * where a mistake is invisible until a user reports a banner.
 */
const scratchDirs = [];
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function runWriter({ proxyBase, apiKey, existing }) {
  const dir = mkdtempSync(join(tmpdir(), "openrind-auth-"));
  scratchDirs.push(dir);
  const file = join(dir, "settings.json");
  if (existing) writeFileSync(file, JSON.stringify(existing, null, 2));

  const lines = buildClaudeProjectSettingsLines({ proxyBase, apiKey });
  const nodeLine = lines.find((l) => l.startsWith("node -e "));
  assert.ok(nodeLine, "expected a node -e line");

  // Re-target the hard-coded sandbox path at the temp file, then execute the
  // exact argv the sandbox would run. The first group is NON-greedy and the
  // tail is anchored: the embedded JS deliberately contains no single quotes,
  // so the first closing quote is the real one.
  const m = nodeLine.match(
    /^node -e '([\s\S]*?)' '([^']*)' '([^']*)' 2>\/dev\/null \|\| true$/,
  );
  assert.ok(m, `could not parse generated line: ${nodeLine}`);
  // Forward slashes: the path is substituted into a JS string literal, and on
  // Windows a raw C:\Users\... would have its backslashes eaten as escapes.
  const jsPath = file.replace(/\\/g, "/");
  const js = m[1].replace("/sandbox/.claude/settings.json", jsPath);
  assert.ok(js.includes(jsPath), "failed to re-target the settings path");
  execFileSync(process.execPath, ["-e", js, m[2], m[3]], { stdio: "pipe" });

  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

test("proxy + API key: base URL only, never the placeholder token", () => {
  const s = runWriter({ proxyBase: PROXY, apiKey: KEY });
  assert.equal(s.env.ANTHROPIC_BASE_URL, PROXY);
  assert.ok(
    !("ANTHROPIC_AUTH_TOKEN" in s.env),
    "the token must not accompany an API key — that is the auth conflict",
  );
});

test("proxy + no API key: the placeholder token prevents a login prompt", () => {
  const s = runWriter({ proxyBase: PROXY, apiKey: null });
  assert.equal(s.env.ANTHROPIC_BASE_URL, PROXY);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, OPENRIND_GATEWAY_PLACEHOLDER_AUTH_TOKEN);
});

test("no proxy: a stale base URL and token are taken back down", () => {
  const s = runWriter({
    proxyBase: null,
    apiKey: KEY,
    existing: {
      env: {
        ANTHROPIC_BASE_URL: "https://proxy.openrind.com/dead-presign",
        ANTHROPIC_AUTH_TOKEN: "openrind-desktop-stale",
      },
    },
  });
  // The whole env block is dropped once it is empty, rather than left as {}.
  assert.ok(
    !s.env || !("ANTHROPIC_AUTH_TOKEN" in s.env),
    "a proxy-era token must not survive into a no-proxy run",
  );
  assert.ok(
    !s.env || !("ANTHROPIC_BASE_URL" in s.env),
    "a dead presign URL must not survive into a no-proxy run",
  );
});

test("switching from no-key to key removes the token already on disk", () => {
  const s = runWriter({
    proxyBase: PROXY,
    apiKey: KEY,
    existing: {
      env: {
        ANTHROPIC_BASE_URL: PROXY,
        ANTHROPIC_AUTH_TOKEN: OPENRIND_GATEWAY_PLACEHOLDER_AUTH_TOKEN,
      },
    },
  });
  assert.ok(!("ANTHROPIC_AUTH_TOKEN" in s.env));
  assert.equal(s.env.ANTHROPIC_BASE_URL, PROXY);
});

test("unrelated settings the user owns are preserved", () => {
  const s = runWriter({
    proxyBase: PROXY,
    apiKey: KEY,
    existing: {
      theme: "dark",
      permissions: { deny: ["Read(~/.ssh/**)"] },
      env: { MY_VAR: "keep-me", ANTHROPIC_AUTH_TOKEN: "drop-me" },
    },
  });
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.permissions.deny, ["Read(~/.ssh/**)"]);
  assert.equal(s.env.MY_VAR, "keep-me");
  assert.ok(!("ANTHROPIC_AUTH_TOKEN" in s.env));
});

test("the writer runs for every Claude launch, proxy or not", () => {
  // Regression guard: the command used to be emitted only inside `if (proxyBase)`,
  // which is exactly why a stale token could never be cleaned up.
  for (const proxyBase of [PROXY, null]) {
    const lines = buildClaudeProjectSettingsLines({ proxyBase, apiKey: KEY });
    assert.ok(
      lines.some((l) => l.startsWith("node -e ")),
      `no settings reconciliation emitted for proxyBase=${proxyBase}`,
    );
    assert.ok(lines.includes("mkdir -p /sandbox/.claude"));
  }
});

test("setup.sh applies the same rule to the user-level settings file", () => {
  const setup = readFileSync(
    new URL("../../../../../sandboxes/openrind-shell/setup.sh", import.meta.url),
    "utf8",
  );
  // Both writers (pre-restore and post-restore) must be key-aware.
  const writers = setup.split("s.env.ANTHROPIC_BASE_URL = process.env.OPENRIND_GATEWAY_PROXY_URL;");
  assert.equal(writers.length, 3, "expected exactly two settings.json writers in setup.sh");
  for (const [i, chunk] of writers.slice(1).entries()) {
    const body = chunk.slice(0, 400);
    assert.match(
      body,
      /if \(process\.env\.ANTHROPIC_API_KEY\) delete s\.env\.ANTHROPIC_AUTH_TOKEN;/,
      `writer ${i + 1} must drop the token when an API key is present`,
    );
  }
});
