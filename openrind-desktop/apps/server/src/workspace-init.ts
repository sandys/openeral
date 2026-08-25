import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { openrindDesktopConfigPath, opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile, writeJsoncFile } from "./jsonc.js";

const OPENRIND_DESKTOP_AGENT = `---
description: Openrind Desktop default agent
mode: primary
temperature: 0.2
---

You are Openrind Desktop.

Help the user work on files safely from this workspace. Prefer clear, practical steps. If required setup or credentials are missing, ask one targeted question and continue once provided.
`;

type WorkspaceOpenrindDesktopConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

async function ensureWorkspaceOpenrindDesktopConfig(workspaceRoot: string, preset: string): Promise<void> {
  const path = openrindDesktopConfigPath(workspaceRoot);
  if (await exists(path)) return;
  const now = Date.now();
  const config: WorkspaceOpenrindDesktopConfig = {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: now,
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<void> {
  const path = opencodeConfigPath(workspaceRoot);
  const { data } = await readJsoncFile<Record<string, unknown>>(path, {
    $schema: "https://opencode.ai/config.json",
  });
  const next: Record<string, unknown> = data && typeof data === "object" && !Array.isArray(data)
    ? { ...data }
    : { $schema: "https://opencode.ai/config.json" };

  if (typeof next.default_agent !== "string" || !next.default_agent.trim()) {
    next.default_agent = "openrind-desktop";
  }

  await writeJsoncFile(path, next);
}

async function ensureOpenrindDesktopAgent(workspaceRoot: string): Promise<void> {
  const agentsDir = join(workspaceRoot, ".opencode", "agents");
  const agentPath = join(agentsDir, "openrind-desktop.md");
  if (await exists(agentPath)) return;
  await ensureDir(agentsDir);
  await writeFile(agentPath, OPENRIND_DESKTOP_AGENT.endsWith("\n") ? OPENRIND_DESKTOP_AGENT : `${OPENRIND_DESKTOP_AGENT}\n`, "utf8");
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<void> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  await ensureOpencodeConfig(workspaceRoot);
  await ensureOpenrindDesktopAgent(workspaceRoot);
  await ensureWorkspaceOpenrindDesktopConfig(workspaceRoot, preset);
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
