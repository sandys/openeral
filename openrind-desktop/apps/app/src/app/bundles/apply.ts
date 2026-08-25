import type { WorkspaceDisplay } from "../types";
import { parseOpenrindDesktopWorkspaceIdFromUrl } from "../lib/openrind-desktop-server";
import type { WorkspaceInfo } from "../lib/desktop";
import { isSafeSkillName } from "./schema";
import type { BundleImportTarget, BundleV1 } from "./types";

// Defense-in-depth: re-check names right before they enter the import
// payload, in case a BundleV1 was constructed without parseBundlePayload.
function requireSafeSkillName(name: string): string {
  if (!isSafeSkillName(name)) {
    throw new Error("Invalid skill name in bundle: names must be kebab-case.");
  }
  return name;
}

export function buildImportPayloadFromBundle(bundle: BundleV1): {
  payload: Record<string, unknown>;
  importedSkillsCount: number;
} {
  if (bundle.type === "skill") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: [
          {
            name: requireSafeSkillName(bundle.name),
            description: bundle.description,
            trigger: bundle.trigger,
            content: bundle.content,
          },
        ],
      },
      importedSkillsCount: 1,
    };
  }

  if (bundle.type === "skills-set") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: bundle.skills.map((skill) => ({
          name: requireSafeSkillName(skill.name),
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
      },
      importedSkillsCount: bundle.skills.length,
    };
  }

  throw new Error(`Unsupported bundle type: ${(bundle as { type?: string }).type || "unknown"}`);
}

export function isBundleImportWorkspace(workspace: WorkspaceDisplay | WorkspaceInfo | null): boolean {
  if (!workspace?.id?.trim()) return false;
  if (workspace.workspaceType === "local") {
    return Boolean(workspace.path?.trim());
  }
  return Boolean(workspace.remoteType === "openrind-desktop" || workspace.openrindDesktopHostUrl?.trim() || workspace.openrindDesktopWorkspaceId?.trim());
}

export function resolveBundleImportTargetForWorkspace(
  workspace: WorkspaceDisplay | WorkspaceInfo | null,
): BundleImportTarget | undefined {
  if (!workspace) return undefined;
  if (workspace.workspaceType === "local") {
    const localRoot = workspace.path?.trim() ?? "";
    return localRoot ? { localRoot } : undefined;
  }

  const workspaceId =
    workspace.openrindDesktopWorkspaceId?.trim() ||
    parseOpenrindDesktopWorkspaceIdFromUrl(workspace.openrindDesktopHostUrl ?? "") ||
    parseOpenrindDesktopWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
    null;
  const directoryHint = workspace.directory?.trim() || workspace.path?.trim() || null;
  if (workspaceId || directoryHint) {
    return {
      workspaceId,
      directoryHint,
    };
  }
  return undefined;
}

export function describeWorkspaceForBundleToasts(workspace: WorkspaceDisplay | WorkspaceInfo | null): string {
  return (
    workspace?.displayName?.trim() ||
    workspace?.openrindDesktopWorkspaceName?.trim() ||
    workspace?.name?.trim() ||
    workspace?.directory?.trim() ||
    workspace?.path?.trim() ||
    workspace?.baseUrl?.trim() ||
    "the selected worker"
  );
}
