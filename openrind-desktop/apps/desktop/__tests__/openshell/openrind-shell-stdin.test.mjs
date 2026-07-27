// Every wslSpawn caller that sends no input must close stdin.
//
// Why this test exists: `wslSpawn` opens stdin as a pipe and never closes it,
// while `wslRun` always calls child.stdin.end(). `openshell sandbox exec`
// forwards stdin to the remote command and waits for an EOF that never comes —
// it produces NO output and never even issues its ExecSandbox RPC. Measured
// against a live sandbox:
//
//   stdin left open  ->  no output ever, still hung when killed at 90s
//   stdin.end()      ->  exit 0 in 0.3s, first byte at 0.2s
//
// That silently disabled the entire OpenClaw loading-screen prewarm: the
// gateway was never warmed, the overlay sat on "no output for 4m23s", and every
// session paid the full database bootstrap at connect instead. The terminal's
// setup-log follower was dead for the same reason.
//
// The failure is invisible in review — the spawn looks completely normal — so
// it is pinned structurally here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) =>
  readFileSync(new URL(`../../electron/openshell/${rel}`, import.meta.url), "utf8");

test("openrind-shell.mjs routes no-input spawns through wslSpawnNoStdin", () => {
  const src = read("openrind-shell.mjs");

  assert.match(
    src,
    /function wslSpawnNoStdin\(/,
    "the helper that closes stdin must exist",
  );
  assert.match(
    src,
    /child\.stdin\?\.end\(\)/,
    "wslSpawnNoStdin must actually close stdin",
  );

  // Exactly one bare wslSpawn( call is allowed: the one inside the helper.
  const bare = src
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(
      ({ line }) =>
        /\bwslSpawn\(/.test(line) &&
        !/wslSpawnNoStdin/.test(line) &&
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("//"),
    );
  assert.equal(
    bare.length,
    1,
    `every no-input spawn must use wslSpawnNoStdin; bare wslSpawn at lines ` +
      `${bare.map((b) => b.n).join(", ")}`,
  );
});

test("the prewarm and the log follower both close stdin", () => {
  const src = read("openrind-shell.mjs");
  for (const marker of [
    "sandboxRunScriptCmd(name, script)", // streamSetupProgress
    "tail -n0 -F /tmp/openrind-shell-setup.log", // followTerminalSetupLog
  ]) {
    // lastIndexOf: `sandboxRunScriptCmd(name, script)` also matches its own
    // function definition, which appears earlier in the file.
    const at = src.lastIndexOf(marker);
    assert.notEqual(at, -1, `could not find call site: ${marker}`);
    // Look back a little for the spawn that owns this command.
    const before = src.slice(Math.max(0, at - 600), at);
    assert.match(
      before,
      /wslSpawnNoStdin\(/,
      `${marker} must be spawned with stdin closed`,
    );
  }
});

test("client.createSandbox closes stdin too", () => {
  const src = read("client.mjs");
  const at = src.indexOf("const child = wslSpawn(args);");
  assert.notEqual(at, -1, "createSandbox spawn not found");
  assert.match(
    src.slice(at, at + 400),
    /child\.stdin\?\.end\(\)/,
    "createSandbox waits for a readiness line, so stdin must be closed",
  );
});

test("the PTY transport deliberately keeps stdin OPEN", () => {
  // The one case that must NOT be 'fixed': the PTY forwards the user's
  // keystrokes, so closing stdin would break the terminal outright.
  const src = read("openrind-shell-pty.mjs");
  const at = src.indexOf("const child = wslSpawn(");
  assert.notEqual(at, -1, "PTY spawn not found");
  assert.doesNotMatch(
    src.slice(at, at + 300),
    /stdin\?\.end\(\)/,
    "the PTY must keep stdin open — it carries keystrokes",
  );
});
