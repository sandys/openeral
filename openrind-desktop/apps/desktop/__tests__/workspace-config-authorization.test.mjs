import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  requireRegisteredLocalWorkspaceRoot,
  resolveWorkspaceConfigFilePath,
} from "../electron/workspace-config-authorization.mjs";

test("workspace config authorization accepts only registered local workspace roots", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrind-workspace-config-auth-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const registered = path.join(root, "registered");
  const outside = path.join(root, "outside");
  fs.mkdirSync(registered, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const workspaces = [{ path: registered, workspaceType: "local" }];

  assert.equal(
    await requireRegisteredLocalWorkspaceRoot({ requestedPath: registered, workspaces }),
    fs.realpathSync(registered),
  );
  await assert.rejects(
    requireRegisteredLocalWorkspaceRoot({ requestedPath: outside, workspaces }),
    /not a registered local workspace/,
  );
});

test("workspace config authorization resolves aliases to the trusted registered root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrind-workspace-config-alias-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const registered = path.join(root, "registered");
  const alias = path.join(root, "alias");
  fs.mkdirSync(registered, { recursive: true });
  fs.symlinkSync(registered, alias, process.platform === "win32" ? "junction" : "dir");

  assert.equal(
    await requireRegisteredLocalWorkspaceRoot({
      requestedPath: alias,
      workspaces: [{ path: registered, workspaceType: "local" }],
    }),
    fs.realpathSync(registered),
  );
  await assert.rejects(
    requireRegisteredLocalWorkspaceRoot({
      requestedPath: registered,
      workspaces: [{ path: registered, workspaceType: "remote" }],
    }),
    /not a registered local workspace/,
  );
});

test("workspace config path cannot escape through an internal symlink", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrind-workspace-config-path-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const workspaceRoot = path.join(root, "workspace");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  assert.equal(
    await resolveWorkspaceConfigFilePath(workspaceRoot),
    path.join(fs.realpathSync(workspaceRoot), ".opencode", "openrind-desktop.json"),
  );

  fs.symlinkSync(
    outsideRoot,
    path.join(workspaceRoot, ".opencode"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resolveWorkspaceConfigFilePath(workspaceRoot),
    /resolves outside the workspace root/,
  );
});
