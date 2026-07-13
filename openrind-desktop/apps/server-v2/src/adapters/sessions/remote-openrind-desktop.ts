import { RouteError } from "../../http.js";
import type { ServerRecord, WorkspaceRecord } from "../../database/types.js";
import { createOpenCodeSessionBackend } from "./opencode-backend.js";
import { buildRemoteOpenrindDesktopHeaders } from "../remote-openrind-desktop.js";

export function createRemoteOpenrindDesktopSessionAdapter(input: {
  server: ServerRecord;
  workspace: WorkspaceRecord;
}) {
  if (!input.server.baseUrl) {
    throw new RouteError(502, "bad_gateway", "Remote workspace server is missing a base URL.");
  }

  const remoteType = input.workspace.notes?.remoteType === "opencode" ? "opencode" : "openrind-desktop";
  const remoteWorkspaceId = input.workspace.remoteWorkspaceId?.trim() ?? "";

  if (remoteType === "openrind-desktop") {
    if (!remoteWorkspaceId) {
      throw new RouteError(502, "bad_gateway", "Remote Openrind Desktop workspace is missing its remote workspace identifier.");
    }

    return createOpenCodeSessionBackend({
      baseUrl: `${input.server.baseUrl.replace(/\/+$/, "")}/w/${encodeURIComponent(remoteWorkspaceId)}/opencode`,
      headers: buildRemoteOpenrindDesktopHeaders(input.server),
    });
  }

  return createOpenCodeSessionBackend({
    baseUrl: input.server.baseUrl,
    directory: typeof input.workspace.notes?.directory === "string" ? input.workspace.notes.directory : undefined,
    headers: buildRemoteOpenrindDesktopHeaders(input.server),
  });
}
