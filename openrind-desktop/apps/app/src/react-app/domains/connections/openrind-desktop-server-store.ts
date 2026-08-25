import { useSyncExternalStore } from "react";

import { t, currentLocale } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  openrindDesktopServerInfo,
  openrindDesktopServerRestart,
  type OpenrindDesktopServerInfo,
} from "../../../app/lib/desktop";
import {
  clearOpenrindDesktopServerSettings,
  createOpenrindDesktopServerClient,
  isLoopbackOpenrindDesktopServerUrl,
  normalizeOpenrindDesktopServerUrl,
  readOpenrindDesktopServerSettings,
  writeOpenrindDesktopServerSettings,
  type OpenrindDesktopAuditEntry,
  type OpenrindDesktopServerCapabilities,
  type OpenrindDesktopServerClient,
  type OpenrindDesktopServerDiagnostics,
  type OpenrindDesktopServerError,
  type OpenrindDesktopServerSettings,
  type OpenrindDesktopServerStatus,
} from "../../../app/lib/openrind-desktop-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  openrindDesktopHostUrl: string;
  openrindDesktopToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type OpenrindDesktopServerStoreSnapshot = {
  openrindDesktopServerSettings: OpenrindDesktopServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  openrindDesktopServerUrl: string;
  openrindDesktopServerBaseUrl: string;
  openrindDesktopServerAuth: { token?: string; hostToken?: string };
  openrindDesktopServerClient: OpenrindDesktopServerClient | null;
  openrindDesktopServerStatus: OpenrindDesktopServerStatus;
  openrindDesktopServerCapabilities: OpenrindDesktopServerCapabilities | null;
  openrindDesktopServerReady: boolean;
  openrindDesktopServerWorkspaceReady: boolean;
  resolvedOpenrindDesktopCapabilities: OpenrindDesktopServerCapabilities | null;
  openrindDesktopServerCanWriteSkills: boolean;
  openrindDesktopServerCanWritePlugins: boolean;
  openrindDesktopServerHostInfo: OpenrindDesktopServerInfo | null;
  openrindDesktopServerDiagnostics: OpenrindDesktopServerDiagnostics | null;
  openrindDesktopReconnectBusy: boolean;
  openrindDesktopAuditEntries: OpenrindDesktopAuditEntry[];
  openrindDesktopAuditStatus: "idle" | "loading" | "error";
  openrindDesktopAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type OpenrindDesktopServerStore = ReturnType<typeof createOpenrindDesktopServerStore>;

type CreateOpenrindDesktopServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  openrindDesktopServerSettings: OpenrindDesktopServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  openrindDesktopServerUrl: string;
  openrindDesktopServerStatus: OpenrindDesktopServerStatus;
  openrindDesktopServerCapabilities: OpenrindDesktopServerCapabilities | null;
  openrindDesktopServerCheckedAt: number | null;
  openrindDesktopServerHostInfo: OpenrindDesktopServerInfo | null;
  openrindDesktopServerHostInfoReady: boolean;
  openrindDesktopServerDiagnostics: OpenrindDesktopServerDiagnostics | null;
  openrindDesktopReconnectBusy: boolean;
  openrindDesktopAuditEntries: OpenrindDesktopAuditEntry[];
  openrindDesktopAuditStatus: "idle" | "loading" | "error";
  openrindDesktopAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function createOpenrindDesktopServerStore(options: CreateOpenrindDesktopServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: OpenrindDesktopServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let snapshot: OpenrindDesktopServerStoreSnapshot;

  let state: MutableState = {
    openrindDesktopServerSettings: readOpenrindDesktopServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    openrindDesktopServerUrl: "",
    openrindDesktopServerStatus: "disconnected",
    openrindDesktopServerCapabilities: null,
    openrindDesktopServerCheckedAt: null,
    openrindDesktopServerHostInfo: null,
    openrindDesktopServerHostInfoReady: !isDesktopRuntime(),
    openrindDesktopServerDiagnostics: null,
    openrindDesktopReconnectBusy: false,
    openrindDesktopAuditEntries: [],
    openrindDesktopAuditStatus: "idle",
    openrindDesktopAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const pref = options.startupPreference();
    const hostInfo = state.openrindDesktopServerHostInfo;
    const settingsUrl = normalizeOpenrindDesktopServerUrl(state.openrindDesktopServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackOpenrindDesktopServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const pref = options.startupPreference();
    const hostInfo = state.openrindDesktopServerHostInfo;
    const settingsUrl = normalizeOpenrindDesktopServerUrl(state.openrindDesktopServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.openrindDesktopServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.openrindDesktopServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackOpenrindDesktopServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackOpenrindDesktopServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackOpenrindDesktopServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createOpenrindDesktopServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = () => {
    const openrindDesktopServerBaseUrl = getBaseUrl().trim();
    const openrindDesktopServerAuth = getAuth();
    const openrindDesktopServerClient = getClient();
    const openrindDesktopServerReady = state.openrindDesktopServerStatus === "connected";
    const openrindDesktopServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedOpenrindDesktopCapabilities = state.openrindDesktopServerCapabilities;

    const pref = options.startupPreference();
    const info = state.openrindDesktopServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOpenrindDesktopServerUrl(state.openrindDesktopServerSettings.urlOverride ?? "") ?? "";

    let openrindDesktopServerUrl = hostUrl || settingsUrl;
    if (pref === "local") openrindDesktopServerUrl = hostUrl;
    if (pref === "server") openrindDesktopServerUrl = settingsUrl;
    state.openrindDesktopServerUrl = openrindDesktopServerUrl;

    snapshot = {
      openrindDesktopServerSettings: state.openrindDesktopServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      openrindDesktopServerUrl,
      openrindDesktopServerBaseUrl,
      openrindDesktopServerAuth,
      openrindDesktopServerClient,
      openrindDesktopServerStatus: state.openrindDesktopServerStatus,
      openrindDesktopServerCapabilities: state.openrindDesktopServerCapabilities,
      openrindDesktopServerReady,
      openrindDesktopServerWorkspaceReady,
      resolvedOpenrindDesktopCapabilities,
      openrindDesktopServerCanWriteSkills:
        openrindDesktopServerReady &&
        openrindDesktopServerWorkspaceReady &&
        (resolvedOpenrindDesktopCapabilities?.skills?.write ?? false),
      openrindDesktopServerCanWritePlugins:
        openrindDesktopServerReady &&
        openrindDesktopServerWorkspaceReady &&
        (resolvedOpenrindDesktopCapabilities?.plugins?.write ?? false),
      openrindDesktopServerHostInfo: state.openrindDesktopServerHostInfo,
      openrindDesktopServerDiagnostics: state.openrindDesktopServerDiagnostics,
      openrindDesktopReconnectBusy: state.openrindDesktopReconnectBusy,
      openrindDesktopAuditEntries: state.openrindDesktopAuditEntries,
      openrindDesktopAuditStatus: state.openrindDesktopAuditStatus,
      openrindDesktopAuditError: state.openrindDesktopAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setOpenrindDesktopServerSettings = (next: SetStateAction<OpenrindDesktopServerSettings>) => {
    const resolved = applyStateAction(state.openrindDesktopServerSettings, next);
    mutateState((current) => ({ ...current, openrindDesktopServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateOpenrindDesktopServerSettings = (next: OpenrindDesktopServerSettings) => {
    const stored = writeOpenrindDesktopServerSettings(next);
    mutateState((current) => ({ ...current, openrindDesktopServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetOpenrindDesktopServerSettings = () => {
    clearOpenrindDesktopServerSettings();
    mutateState((current) => ({ ...current, openrindDesktopServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.openrindDesktopServerHostInfoReady;

  const shouldRetryStartupCheck = (status: OpenrindDesktopServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkOpenrindDesktopServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOpenrindDesktopServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as OpenrindDesktopServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OpenrindDesktopServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenrindDesktopServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OpenrindDesktopServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as OpenrindDesktopServerStatus, capabilities };
    } catch (error) {
      const resolved = error as OpenrindDesktopServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OpenrindDesktopServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenrindDesktopServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) return;
    if (shouldWaitForLocalHostInfo()) return;
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      mutateState((current) => ({
        ...current,
        openrindDesktopServerStatus: "disconnected",
        openrindDesktopServerCapabilities: null,
        openrindDesktopServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkOpenrindDesktopServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await openrindDesktopServerInfo();
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            openrindDesktopServerHostInfo: info,
            openrindDesktopServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkOpenrindDesktopServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      healthDelayMs =
        result.status === "connected" || result.status === "limited"
          ? 10_000
          : Math.min(healthDelayMs * 2, 60_000);

      mutateState((current) => ({
        ...current,
        openrindDesktopServerStatus: result.status,
        openrindDesktopServerCapabilities: result.capabilities,
        openrindDesktopServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        openrindDesktopServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    refreshSnapshot();
    emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.openrindDesktopServerHostInfo?.port;
    if (!port) return;
    if (state.openrindDesktopServerSettings.portOverride === port) return;

    updateOpenrindDesktopServerSettings({
      ...state.openrindDesktopServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await openrindDesktopServerInfo();
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openrindDesktopServerHostInfo: info,
            openrindDesktopServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openrindDesktopServerHostInfo: null,
            openrindDesktopServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("openrindDesktopServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.openrindDesktopServerStatus === "disconnected") {
        setStateField("openrindDesktopServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("openrindDesktopServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("openrindDesktopServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          openrindDesktopAuditEntries: [],
          openrindDesktopAuditStatus: "idle",
          openrindDesktopAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          openrindDesktopAuditEntries: [],
          openrindDesktopAuditStatus: "idle",
          openrindDesktopAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        openrindDesktopAuditStatus: "loading",
        openrindDesktopAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openrindDesktopAuditEntries: Array.isArray(result.items) ? result.items : [],
            openrindDesktopAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openrindDesktopAuditEntries: [],
            openrindDesktopAuditStatus: "error",
            openrindDesktopAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load", currentLocale()),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testOpenrindDesktopServerConnection = async (next: OpenrindDesktopServerSettings) => {
    const derived = normalizeOpenrindDesktopServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        openrindDesktopServerStatus: "disconnected",
        openrindDesktopServerCapabilities: null,
        openrindDesktopServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkOpenrindDesktopServer(derived, next.token);
    mutateState((current) => ({
      ...current,
      openrindDesktopServerStatus: result.status,
      openrindDesktopServerCapabilities: result.capabilities,
      openrindDesktopServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "openrind-desktop";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            openrindDesktopHostUrl: derived,
            openrindDesktopToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOpenrindDesktopServer = async () => {
    if (state.openrindDesktopReconnectBusy) return false;
    setStateField("openrindDesktopReconnectBusy", true);

    try {
      let hostInfo = state.openrindDesktopServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await openrindDesktopServerInfo();
          mutateState((current) => ({ ...current, openrindDesktopServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("openrindDesktopServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = state.openrindDesktopServerSettings;
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateOpenrindDesktopServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          openrindDesktopServerStatus: "disconnected",
          openrindDesktopServerCapabilities: null,
          openrindDesktopServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkOpenrindDesktopServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        openrindDesktopServerStatus: result.status,
        openrindDesktopServerCapabilities: result.capabilities,
        openrindDesktopServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("openrindDesktopReconnectBusy", false);
    }
  };

  async function ensureLocalOpenrindDesktopServerClient(): Promise<OpenrindDesktopServerClient | null> {
    let hostInfo = state.openrindDesktopServerHostInfo;
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createOpenrindDesktopServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (options.startupPreference() !== "server") {
          await reconnectOpenrindDesktopServer();
        }
        return existing;
      } catch {
        // Fall through to a local restart.
      }
    }

    if (!isDesktopRuntime()) return null;

    try {
      hostInfo = await openrindDesktopServerRestart({
        remoteAccessEnabled: state.openrindDesktopServerSettings.remoteAccessEnabled === true,
      });
      mutateState((current) => ({ ...current, openrindDesktopServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectOpenrindDesktopServer();
    }

    return createOpenrindDesktopServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.openrindDesktopServerSettings;
    const next: OpenrindDesktopServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateOpenrindDesktopServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker", currentLocale()));
        }
        await reconnectOpenrindDesktopServer();
      }
    } catch (error) {
      updateOpenrindDesktopServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access", currentLocale()),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setOpenrindDesktopServerSettings,
    updateOpenrindDesktopServerSettings,
    resetOpenrindDesktopServerSettings,
    saveShareRemoteAccess,
    checkOpenrindDesktopServer,
    testOpenrindDesktopServerConnection,
    reconnectOpenrindDesktopServer,
    ensureLocalOpenrindDesktopServerClient,
  };
}

export function useOpenrindDesktopServerStoreSnapshot(store: OpenrindDesktopServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
