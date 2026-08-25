import type { OpenrindDesktopStore } from "./store";

export const selectActiveWorkspace = (state: OpenrindDesktopStore) =>
  state.workspaces.find(
    (workspace) => workspace.id === state.activeWorkspaceId,
  ) ?? null;

export const selectServerStatus = (state: OpenrindDesktopStore) => state.server.status;

export const selectServerUrl = (state: OpenrindDesktopStore) => state.server.url;

export const selectErrorBanner = (state: OpenrindDesktopStore) => state.errorBanner;
