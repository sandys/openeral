// Unit tests for apps/desktop/electron/openshell/openrind-shell-terminal.mjs.
// Only the pure-function helpers (deriveOpenrindShellSandboxName) are tested
// here. The actual terminal launchers (launchExternalTerminalToSandbox)
// are OS-spawn glue with platform branches — they're covered by manual
// testing on each platform and by the Phase 10 E2E spec on Windows.

import test from "node:test";
import assert from "node:assert/strict";

const { deriveOpenrindShellSandboxName } = await import(
  "../../electron/openshell/openrind-shell-terminal.mjs"
);

test("deriveOpenrindShellSandboxName: trivial workspace id", () => {
  assert.equal(deriveOpenrindShellSandboxName("myworkspace"), "openrind-shell-myworkspace");
});

test("deriveOpenrindShellSandboxName: lowercases the id", () => {
  assert.equal(deriveOpenrindShellSandboxName("MyWorkspace"), "openrind-shell-myworkspace");
});

test("deriveOpenrindShellSandboxName: replaces punctuation with dashes", () => {
  assert.equal(
    deriveOpenrindShellSandboxName("My Workspace / Q3 + analysis"),
    "openrind-shell-my-workspace-q3-analysis",
  );
});

test("deriveOpenrindShellSandboxName: collapses repeated and trims edge dashes", () => {
  assert.equal(deriveOpenrindShellSandboxName("---abc---"), "openrind-shell-abc");
});

test("deriveOpenrindShellSandboxName: preserves dots, dashes, underscores", () => {
  assert.equal(
    deriveOpenrindShellSandboxName("foo_bar.v1-q3"),
    "openrind-shell-foo_bar.v1-q3",
  );
});

test("deriveOpenrindShellSandboxName: caps length at 50 chars (plus prefix)", () => {
  const long = "x".repeat(80);
  const out = deriveOpenrindShellSandboxName(long);
  // "openrind-shell-" (9 chars) + 50 sanitized chars
  assert.equal(out, `openrind-shell-${"x".repeat(50)}`);
});

test("deriveOpenrindShellSandboxName: throws on empty input", () => {
  assert.throws(() => deriveOpenrindShellSandboxName(""), /empty workspace id/i);
});

test("deriveOpenrindShellSandboxName: throws on whitespace-only input after sanitization", () => {
  assert.throws(() => deriveOpenrindShellSandboxName("   "), /empty workspace id/i);
});

test("deriveOpenrindShellSandboxName: throws on punctuation-only input", () => {
  assert.throws(() => deriveOpenrindShellSandboxName("///"), /empty workspace id/i);
});

test("deriveOpenrindShellSandboxName: same input always produces same output (portability story)", () => {
  // Openrind Shell's cross-machine restore relies on this being deterministic
  // and stable across runs — the sandbox name is the workspace identity.
  const a = deriveOpenrindShellSandboxName("Q3 Earnings");
  const b = deriveOpenrindShellSandboxName("Q3 Earnings");
  assert.equal(a, b);
  assert.equal(a, "openrind-shell-q3-earnings");
});
