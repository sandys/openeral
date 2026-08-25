import test from "node:test";
import assert from "node:assert/strict";

const { deriveOpenrindShellSandboxName } = await import(
  "../../electron/openshell/openrind-shell-terminal.mjs"
);

test("sandbox names satisfy OpenShell's 19-character contract", () => {
  const name = deriveOpenrindShellSandboxName("My Workspace / Q3 + analysis");
  assert.match(name, /^or-[a-z0-9]{1,8}-[0-9a-f]{7}$/);
  assert.ok(name.length <= 19);
});

test("sandbox names are deterministic and case-normalized", () => {
  assert.equal(
    deriveOpenrindShellSandboxName("Q3 Earnings"),
    deriveOpenrindShellSandboxName("q3 earnings"),
  );
});

test("an already-valid product sandbox name remains stable", () => {
  assert.equal(deriveOpenrindShellSandboxName("or-project-a1b2c3d"), "or-project-a1b2c3d");
});

test("different workspace ids do not collapse onto the same slug", () => {
  assert.notEqual(
    deriveOpenrindShellSandboxName("workspace alpha"),
    deriveOpenrindShellSandboxName("workspace beta"),
  );
});

test("empty workspace ids are rejected", () => {
  assert.throws(() => deriveOpenrindShellSandboxName("   "), /empty workspace id/i);
});
