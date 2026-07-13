/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildOpenrindDesktopWorkspaceBaseUrl,
  createOpenrindDesktopServerClient,
  parseOpenrindDesktopWorkspaceIdFromUrl,
} from "../../../app/lib/openrind-desktop-server";
import type {
  EngineInfo,
  OpenrindDesktopServerInfo,
  WorkspaceInfo,
} from "../../../app/lib/desktop";
import type { OpenrindDesktopServerSettings } from "../../../app/lib/openrind-desktop-server";
import { t } from "../../../i18n";
import { isDesktopRuntime, normalizeDirectoryPath } from "../../../app/utils";

export type ShareWorkspaceState = ReturnType<typeof useShareWorkspaceState>;

type UseShareWorkspaceStateOptions = {
  workspaces: WorkspaceInfo[];
  openrindDesktopServerHostInfo: OpenrindDesktopServerInfo | null;
  openrindDesktopServerSettings: OpenrindDesktopServerSettings;
  engineInfo: EngineInfo | null;
  exportWorkspaceBusy: boolean;
  openLink: (url: string) => void;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
};

export function useShareWorkspaceState(options: UseShareWorkspaceStateOptions) {
  const [shareWorkspaceId, setShareWorkspaceId] = useState<string | null>(null);
  const [shareLocalOpenrindDesktopWorkspaceId, setShareLocalOpenrindDesktopWorkspaceId] = useState<string | null>(null);

  const openShareWorkspace = useCallback((workspaceId: string) => {
    setShareWorkspaceId(workspaceId);
  }, []);

  const closeShareWorkspace = useCallback(() => {
    setShareWorkspaceId(null);
  }, []);

  const shareWorkspace = useMemo(() => {
    const id = shareWorkspaceId;
    if (!id) return null;
    return options.workspaces.find((workspace) => workspace.id === id) ?? null;
  }, [options.workspaces, shareWorkspaceId]);

  const shareWorkspaceName = useMemo(() => {
    return shareWorkspace ? options.workspaceLabel(shareWorkspace) : "";
  }, [options, shareWorkspace]);

  const shareWorkspaceDetail = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return "";
    if (workspace.workspaceType === "remote") {
      if (workspace.remoteType === "openrind-desktop") {
        const hostUrl = workspace.openrindDesktopHostUrl?.trim() || workspace.baseUrl?.trim() || "";
        const mounted = buildOpenrindDesktopWorkspaceBaseUrl(
          hostUrl,
          workspace.openrindDesktopWorkspaceId,
        );
        return mounted || hostUrl;
      }
      return workspace.baseUrl?.trim() || "";
    }
    return workspace.path?.trim() || "";
  }, [shareWorkspace]);

  useEffect(() => {
    void shareWorkspaceId;
  }, [shareWorkspaceId]);

  useEffect(() => {
    const workspace = shareWorkspace;
    const baseUrl = options.openrindDesktopServerHostInfo?.baseUrl?.trim() ?? "";
    const token =
      options.openrindDesktopServerHostInfo?.ownerToken?.trim() ||
      options.openrindDesktopServerHostInfo?.clientToken?.trim() ||
      "";
    const workspacePath = workspace?.workspaceType === "local" ? (workspace.path?.trim() ?? "") : "";

    if (
      !workspace ||
      workspace.workspaceType !== "local" ||
      !workspacePath ||
      !baseUrl ||
      !token
    ) {
      setShareLocalOpenrindDesktopWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenrindDesktopWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenrindDesktopServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find(
          (entry) => normalizeDirectoryPath(entry.path) === targetPath,
        );
        setShareLocalOpenrindDesktopWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalOpenrindDesktopWorkspaceId(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [options.openrindDesktopServerHostInfo, shareWorkspace]);

  const shareFields = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (workspace.workspaceType !== "remote") {
      if (options.openrindDesktopServerHostInfo?.remoteAccessEnabled !== true) {
        return [];
      }
      const hostUrl =
        options.openrindDesktopServerHostInfo?.connectUrl?.trim() ||
        options.openrindDesktopServerHostInfo?.lanUrl?.trim() ||
        options.openrindDesktopServerHostInfo?.mdnsUrl?.trim() ||
        options.openrindDesktopServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenrindDesktopWorkspaceId
        ? buildOpenrindDesktopWorkspaceBaseUrl(hostUrl, shareLocalOpenrindDesktopWorkspaceId)
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = options.openrindDesktopServerHostInfo?.ownerToken?.trim() || "";
      const collaboratorToken = options.openrindDesktopServerHostInfo?.clientToken?.trim() || "";
      return [
        {
          label: t("session.share_worker_url"),
          value: url,
          placeholder: !isDesktopRuntime()
            ? t("session.share_desktop_app_required")
            : t("session.share_starting_server"),
          hint: mountedUrl
            ? t("session.share_worker_url_phones_hint")
            : hostUrl
              ? t("session.share_worker_url_resolving_hint")
              : undefined,
        },
        {
          label: t("session.share_password"),
          value: ownerToken,
          secret: true,
          placeholder: isDesktopRuntime() ? "-" : t("session.share_desktop_app_required"),
          hint: mountedUrl
            ? t("session.share_worker_url_phones_hint")
            : t("session.share_owner_permission_hint"),
        },
        {
          label: t("session.share_collaborator_label"),
          value: collaboratorToken,
          secret: true,
          placeholder: isDesktopRuntime() ? "-" : t("session.share_desktop_app_required"),
          hint: mountedUrl
            ? t("session.share_collaborator_hint")
            : t("session.share_collaborator_host_hint"),
        },
      ];
    }

    if (workspace.remoteType === "openrind-desktop") {
      const hostUrl = workspace.openrindDesktopHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const url =
        buildOpenrindDesktopWorkspaceBaseUrl(hostUrl, workspace.openrindDesktopWorkspaceId) ||
        hostUrl;
      const token =
        workspace.openrindDesktopToken?.trim() ||
        options.openrindDesktopServerSettings.token?.trim() ||
        "";
      return [
        {
          label: t("session.share_worker_url"),
          value: url,
        },
        {
          label: t("session.share_password"),
          value: token,
          secret: true,
          placeholder: token ? undefined : t("session.share_set_token_hint"),
          hint: t("session.share_connected_with_hint"),
        },
      ];
    }

    const baseUrl = workspace.baseUrl?.trim() || workspace.path?.trim() || "";
    const directory = workspace.directory?.trim() || "";
    return [
      {
        label: t("session.share_opencode_base_url"),
        value: baseUrl,
      },
      {
        label: t("common.path"),
        value: directory,
        placeholder: t("common.default_parens"),
      },
    ];
  }, [
    options.openrindDesktopServerHostInfo,
    options.openrindDesktopServerSettings,
    shareLocalOpenrindDesktopWorkspaceId,
    shareWorkspace,
  ]);

  const shareNote = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return null;
    if (workspace.workspaceType === "local" && options.engineInfo?.runtime === "direct") {
      return t("session.share_note_direct_runtime");
    }
    return null;
  }, [options.engineInfo, shareWorkspace]);

  const shareServiceDisabledReason = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return t("session.share_select_workspace");
    if (workspace.workspaceType === "remote" && workspace.remoteType !== "openrind-desktop") {
      return t("session.share_openrind_desktop_workers_only");
    }
    if (workspace.workspaceType !== "remote") {
      const baseUrl = options.openrindDesktopServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        options.openrindDesktopServerHostInfo?.ownerToken?.trim() ||
        options.openrindDesktopServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return t("session.share_local_host_not_ready");
      }
    } else {
      const hostUrl = workspace.openrindDesktopHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const token =
        workspace.openrindDesktopToken?.trim() ||
        options.openrindDesktopServerSettings.token?.trim() ||
        "";
      if (!hostUrl) return t("session.share_missing_host_url");
      if (!token) return t("session.share_missing_token");
    }
    return null;
  }, [options.openrindDesktopServerHostInfo, options.openrindDesktopServerSettings, shareWorkspace]);

  const exportDisabledReason = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return t("session.export_desktop_only_local");
    if (workspace.workspaceType === "remote") {
      return t("session.export_local_only");
    }
    if (!isDesktopRuntime()) return t("session.export_desktop_only");
    if (options.exportWorkspaceBusy) return t("session.export_already_running");
    return null;
  }, [options.exportWorkspaceBusy, shareWorkspace]);

  return {
    shareWorkspaceId,
    shareWorkspaceOpen: Boolean(shareWorkspaceId),
    openShareWorkspace,
    closeShareWorkspace,
    shareWorkspace,
    shareWorkspaceName,
    shareWorkspaceDetail,
    shareFields,
    shareNote,
    shareServiceDisabledReason,
    exportDisabledReason,
  };
}
