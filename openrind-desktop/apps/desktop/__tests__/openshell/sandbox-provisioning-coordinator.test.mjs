import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxProvisioningCoordinator } from "../../electron/openshell/sandbox-provisioning-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("navigation joins an active sandbox provision instead of restarting it", async () => {
  const coordinator = createSandboxProvisioningCoordinator();
  const gate = deferred();
  const founderProgress = [];
  const resumedProgress = [];
  let starts = 0;
  let report;

  const provision = async (onProgress) => {
    starts += 1;
    report = onProgress;
    onProgress({ phase: "create", message: "uploading" });
    await gate.promise;
    return { sandboxName: "sandbox-a" };
  };

  const founder = coordinator.run({
    sandboxName: "sandbox-a",
    profile: "claude",
    provision,
    onProgress: (event) => founderProgress.push(event),
  });
  await Promise.resolve();

  // Models a remount after Settings/session navigation. It must adopt the same
  // main-process promise and receive both replayed and future activity.
  const resumed = coordinator.run({
    sandboxName: "sandbox-a",
    profile: "claude",
    provision,
    onProgress: (event) => resumedProgress.push(event),
  });
  assert.equal(resumed, founder);
  assert.equal(starts, 1);
  assert.deepEqual(resumedProgress, [{ phase: "create", message: "uploading" }]);

  report({ phase: "create", message: "initializing" });
  assert.deepEqual(resumedProgress.at(-1), {
    phase: "create",
    message: "initializing",
  });
  assert.equal(founderProgress.length, 1);

  gate.resolve();
  assert.deepEqual(await resumed, { sandboxName: "sandbox-a" });
  assert.equal(coordinator.isProvisioning("sandbox-a"), false);
});

test("different profiles for one sandbox are serialized", async () => {
  const coordinator = createSandboxProvisioningCoordinator();
  const claudeGate = deferred();
  const openclawGate = deferred();
  const order = [];

  const claude = coordinator.run({
    sandboxName: "sandbox-a",
    profile: "claude",
    provision: async () => {
      order.push("claude-start");
      await claudeGate.promise;
      order.push("claude-done");
    },
  });
  const openclaw = coordinator.run({
    sandboxName: "sandbox-a",
    profile: "openclaw",
    provision: async () => {
      order.push("openclaw-start");
      await openclawGate.promise;
      order.push("openclaw-done");
    },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["claude-start"]);

  claudeGate.resolve();
  await claude;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["claude-start", "claude-done", "openclaw-start"]);

  openclawGate.resolve();
  await openclaw;
  assert.deepEqual(order, [
    "claude-start",
    "claude-done",
    "openclaw-start",
    "openclaw-done",
  ]);
});

test("a failed provision releases the sandbox for a clean retry", async () => {
  const coordinator = createSandboxProvisioningCoordinator();
  let starts = 0;
  const provision = async () => {
    starts += 1;
    if (starts === 1) throw new Error("failed once");
    return "ready";
  };

  await assert.rejects(
    coordinator.run({ sandboxName: "sandbox-a", profile: "claude", provision }),
    /failed once/,
  );
  assert.equal(await coordinator.run({
    sandboxName: "sandbox-a",
    profile: "claude",
    provision,
  }), "ready");
  assert.equal(starts, 2);
});
