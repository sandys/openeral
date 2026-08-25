import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isWithinWorkspaceRootPath,
  normalizeScopedDirectoryPath,
} from "../dist/path-scope.js";

test("normalizeScopedDirectoryPath strips Windows verbatim prefixes", () => {
  const workspaceRoot = String.raw`G:\project\openrind_desktop_project`;
  const candidate = String.raw`\\?\G:\project\openrind_desktop_project`;

  assert.equal(
    normalizeScopedDirectoryPath(workspaceRoot, "win32"),
    "g:/project/openrind_desktop_project",
  );
  assert.equal(
    normalizeScopedDirectoryPath(candidate, "win32"),
    "g:/project/openrind_desktop_project",
  );
});

test("isWithinWorkspaceRootPath accepts Windows verbatim aliases for workspace root", (t) => {
  if (process.platform !== "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-verbatim-scope-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const candidate = "\\\\?\\" + workspaceRoot;

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
    }),
    true,
  );
});

test("isWithinWorkspaceRootPath still rejects directories outside the workspace root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-outside-scope-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const workspaceRoot = path.join(root, "workspace");
  const candidate = path.join(root, "outside");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(candidate, { recursive: true });

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
    }),
    false,
  );
});

test("isWithinWorkspaceRootPath rejects a symlink whose target is outside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-path-scope-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const workspaceRoot = path.join(root, "workspace");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  const candidate = path.join(workspaceRoot, "escape");
  fs.symlinkSync(outsideRoot, candidate, process.platform === "win32" ? "junction" : "dir");

  assert.equal(isWithinWorkspaceRootPath({ workspaceRoot, candidate }), false);
});
