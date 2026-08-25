import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

function canonicalPathKey(value) {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalDirectory(value) {
  const canonical = await realpath(path.resolve(value));
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("Workspace path must point to a directory.");
  }
  return canonical;
}

export async function requireRegisteredLocalWorkspaceRoot(input) {
  const requestedPath = String(input?.requestedPath ?? "").trim();
  if (!requestedPath) {
    throw new Error("workspacePath is required");
  }

  let requestedRoot;
  try {
    requestedRoot = await canonicalDirectory(requestedPath);
  } catch {
    throw new Error("Workspace path must be an existing registered local workspace.");
  }
  const requestedKey = canonicalPathKey(requestedRoot);

  for (const workspace of Array.isArray(input?.workspaces) ? input.workspaces : []) {
    if (workspace?.workspaceType === "remote") continue;
    const registeredPath = String(workspace?.path ?? "").trim();
    if (!registeredPath) continue;
    try {
      const registeredRoot = await canonicalDirectory(registeredPath);
      if (canonicalPathKey(registeredRoot) === requestedKey) {
        return registeredRoot;
      }
    } catch {
      // Stale or unavailable workspace records cannot authorize filesystem IPC.
    }
  }

  throw new Error("Workspace path is not a registered local workspace.");
}

export async function resolveWorkspaceConfigFilePath(workspaceRoot) {
  const canonicalRoot = await canonicalDirectory(workspaceRoot);
  const lexicalCandidate = path.join(
    canonicalRoot,
    ".opencode",
    "openrind-desktop.json",
  );
  let existingAncestor = lexicalCandidate;

  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("Workspace configuration path could not be resolved safely.");
      }
      existingAncestor = parent;
    }
  }

  let canonicalAncestor;
  try {
    canonicalAncestor = await realpath(existingAncestor);
  } catch {
    throw new Error("Workspace configuration path could not be resolved safely.");
  }
  const candidate = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, lexicalCandidate),
  );
  const relativePath = path.relative(canonicalRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Workspace configuration path resolves outside the workspace root.");
  }
  return candidate;
}
