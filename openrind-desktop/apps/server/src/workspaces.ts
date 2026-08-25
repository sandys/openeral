import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceInfo } from "./types.js";

function workspaceIdForKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `ws_${hash.slice(0, 12)}`;
}

export function workspaceIdForPath(path: string): string {
  return workspaceIdForKey(path);
}

export function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedDirectory = directory?.trim() ?? "";
  const key = normalizedDirectory
    ? `remote::${normalizedBaseUrl}::${normalizedDirectory}`
    : `remote::${normalizedBaseUrl}`;
  return workspaceIdForKey(key);
}

export function workspaceIdForOpenrindDesktop(hostUrl: string, workspaceId?: string | null): string {
  const normalizedHostUrl = hostUrl.trim();
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const key = normalizedWorkspaceId
    ? `openrind-desktop::${normalizedHostUrl}::${normalizedWorkspaceId}`
    : `openrind-desktop::${normalizedHostUrl}`;
  return workspaceIdForKey(key);
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces.map((workspace) => {
    const rawPath = workspace.path?.trim() ?? "";
    const workspaceType = workspace.workspaceType ?? "local";
    const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
    const remoteType = workspace.remoteType;
    const id = workspace.id?.trim()
      || (workspaceType === "remote"
        ? remoteType === "openrind-desktop"
          ? workspaceIdForOpenrindDesktop(workspace.openrindDesktopHostUrl ?? workspace.baseUrl ?? "", workspace.openrindDesktopWorkspaceId)
          : workspaceIdForRemote(workspace.baseUrl ?? "", workspace.directory)
        : workspaceIdForPath(resolvedPath));
    const name = workspace.name?.trim()
      || workspace.displayName?.trim()
      || workspace.openrindDesktopWorkspaceName?.trim()
      || basename(resolvedPath || workspace.directory?.trim() || workspace.baseUrl?.trim() || "Workspace");
    return {
      id,
      name,
      path: resolvedPath,
      preset: workspace.preset?.trim() || (workspaceType === "remote" ? "remote" : "starter"),
      workspaceType,
      remoteType,
      baseUrl: workspace.baseUrl,
      directory: workspace.directory,
      displayName: workspace.displayName,
      openrindDesktopHostUrl: workspace.openrindDesktopHostUrl,
      openrindDesktopToken: workspace.openrindDesktopToken,
      openrindDesktopWorkspaceId: workspace.openrindDesktopWorkspaceId,
      openrindDesktopWorkspaceName: workspace.openrindDesktopWorkspaceName,
      sandboxBackend: workspace.sandboxBackend,
      sandboxRunId: workspace.sandboxRunId,
      sandboxContainerName: workspace.sandboxContainerName,
      opencodeUsername: workspace.opencodeUsername,
      opencodePassword: workspace.opencodePassword,
    };
  });
}
