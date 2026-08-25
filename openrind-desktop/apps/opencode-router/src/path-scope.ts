import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export function normalizeScopedDirectoryPath(input: string, platform = process.platform) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withoutVerbatim = /^\\\\\?\\UNC[\\/]/i.test(trimmed)
    ? `\\${trimmed.slice(8)}`
    : /^\\\\\?\\[a-zA-Z]:[\\/]/.test(trimmed)
      ? trimmed.slice(4)
      : trimmed;
  const unified = withoutVerbatim.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  const normalized = withoutTrailing || "/";
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithinWorkspaceRootPath(input: {
  workspaceRoot: string;
  candidate: string;
  platform?: NodeJS.Platform;
}) {
  return resolveWorkspaceScopedDirectoryPath(input) !== null;
}

export function resolveWorkspaceScopedDirectoryPath(input: {
  workspaceRoot: string;
  candidate: string;
  platform?: NodeJS.Platform;
}) {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = realpathSync.native(pathApi.resolve(input.workspaceRoot));
    canonicalCandidate = realpathSync.native(
      pathApi.isAbsolute(input.candidate)
        ? pathApi.resolve(input.candidate)
        : pathApi.resolve(input.workspaceRoot, input.candidate || "."),
    );
  } catch {
    return null;
  }

  const rootForComparison =
    platform === "win32"
      ? normalizeScopedDirectoryPath(canonicalRoot, platform)
      : canonicalRoot;
  const candidateForComparison =
    platform === "win32"
      ? normalizeScopedDirectoryPath(canonicalCandidate, platform)
      : canonicalCandidate;
  const relativePath = pathApi.relative(rootForComparison, candidateForComparison);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  ) {
    return null;
  }
  return canonicalCandidate;
}
