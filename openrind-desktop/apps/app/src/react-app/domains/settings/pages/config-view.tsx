/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

import { readDevLogs } from "../../../../app/lib/dev-log";
import { readPerfLogs } from "../../../../app/lib/perf-log";
import {
  buildOpenrindDesktopWorkspaceBaseUrl,
  parseOpenrindDesktopWorkspaceIdFromUrl,
  type OpenrindDesktopServerSettings,
  type OpenrindDesktopServerStatus,
} from "../../../../app/lib/openrind-desktop-server";
import type { OpenrindDesktopServerInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  openrindDesktopServerStatus: OpenrindDesktopServerStatus;
  openrindDesktopServerUrl: string;
  openrindDesktopServerSettings: OpenrindDesktopServerSettings;
  openrindDesktopServerHostInfo: OpenrindDesktopServerInfo | null;
  runtimeWorkspaceId: string | null;

  updateOpenrindDesktopServerSettings: (next: OpenrindDesktopServerSettings) => void;
  resetOpenrindDesktopServerSettings: () => void;
  testOpenrindDesktopServerConnection: (
    next: OpenrindDesktopServerSettings,
  ) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;

  developerMode: boolean;
};

type OpenrindDesktopTestState = "idle" | "testing" | "success" | "error";

export function ConfigView(props: ConfigViewProps) {
  const [openrindDesktopUrl, setOpenrindDesktopUrl] = useState("");
  const [openrindDesktopToken, setOpenrindDesktopToken] = useState("");
  const [openrindDesktopTokenVisible, setOpenrindDesktopTokenVisible] = useState(false);
  const [openrindDesktopTestState, setOpenrindDesktopTestState] =
    useState<OpenrindDesktopTestState>("idle");
  const [openrindDesktopTestMessage, setOpenrindDesktopTestMessage] = useState<string | null>(
    null,
  );
  const [clientTokenVisible, setClientTokenVisible] = useState(false);
  const [ownerTokenVisible, setOwnerTokenVisible] = useState(false);
  const [hostTokenVisible, setHostTokenVisible] = useState(false);
  const [copyingField, setCopyingField] = useState<string | null>(null);
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setOpenrindDesktopUrl(props.openrindDesktopServerSettings.urlOverride ?? "");
    setOpenrindDesktopToken(props.openrindDesktopServerSettings.token ?? "");
  }, [props.openrindDesktopServerSettings]);

  useEffect(() => {
    setOpenrindDesktopTestState("idle");
    setOpenrindDesktopTestMessage(null);
  }, [openrindDesktopUrl, openrindDesktopToken]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const openrindDesktopStatusLabel = (() => {
    switch (props.openrindDesktopServerStatus) {
      case "connected":
        return t("config.status_connected");
      case "limited":
        return t("config.status_limited");
      default:
        return t("config.status_not_connected");
    }
  })();

  const openrindDesktopStatusStyle = (() => {
    switch (props.openrindDesktopServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  })();

  const reloadAvailabilityReason = (() => {
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) return t("config.reload_availability_hint");
    return null;
  })();

  const reloadButtonLabel = props.reloadBusy
    ? t("config.reloading")
    : t("config.reload_engine");
  const reloadButtonTone: "danger" | "secondary" = props.anyActiveRuns
    ? "danger"
    : "secondary";
  const reloadButtonDisabled =
    props.reloadBusy || Boolean(reloadAvailabilityReason);

  const buildOpenrindDesktopSettings = (): OpenrindDesktopServerSettings => ({
    ...props.openrindDesktopServerSettings,
    urlOverride: openrindDesktopUrl.trim() || undefined,
    token: openrindDesktopToken.trim() || undefined,
  });

  const hasOpenrindDesktopChanges = (() => {
    const currentUrl = props.openrindDesktopServerSettings.urlOverride ?? "";
    const currentToken = props.openrindDesktopServerSettings.token ?? "";
    return (
      openrindDesktopUrl.trim() !== currentUrl || openrindDesktopToken.trim() !== currentToken
    );
  })();

  const resolvedWorkspaceId = (() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenrindDesktopWorkspaceIdFromUrl(openrindDesktopUrl) ?? "";
  })();

  const resolvedWorkspaceUrl = (() => {
    const baseUrl = openrindDesktopUrl.trim();
    if (!baseUrl) return "";
    return buildOpenrindDesktopWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId) ?? baseUrl;
  })();

  const hostInfo = props.openrindDesktopServerHostInfo;
  const hostRemoteAccessEnabled = hostInfo?.remoteAccessEnabled === true;
  const hostStatusLabel = !hostInfo?.running
    ? t("config.host_offline")
    : hostRemoteAccessEnabled
      ? t("config.host_remote_enabled")
      : t("config.host_local_only");
  const hostStatusStyle = !hostInfo?.running
    ? "bg-gray-4/60 text-gray-11 border-gray-7/50"
    : "bg-green-7/10 text-green-11 border-green-7/20";
  const hostConnectUrl =
    hostInfo?.connectUrl ??
    hostInfo?.mdnsUrl ??
    hostInfo?.lanUrl ??
    hostInfo?.baseUrl ??
    "";
  const hostConnectUrlUsesMdns = hostConnectUrl.includes(".local");

  const diagnosticsBundleJson = useMemo(() => {
    const urlOverride = props.openrindDesktopServerSettings.urlOverride?.trim() ?? "";
    const token = props.openrindDesktopServerSettings.token?.trim() ?? "";
    const developerLogs = props.developerMode ? readDevLogs(80) : [];
    const perfLogs = props.developerMode ? readPerfLogs(80) : [];
    const bundle = {
      capturedAt: new Date().toISOString(),
      runtime: {
        tauri: isDesktopRuntime(),
        developerMode: props.developerMode,
      },
      workspace: {
        runtimeWorkspaceId: props.runtimeWorkspaceId ?? null,
        clientConnected: props.clientConnected,
        anyActiveRuns: props.anyActiveRuns,
      },
      openrindDesktopServer: {
        status: props.openrindDesktopServerStatus,
        url: props.openrindDesktopServerUrl,
        settings: {
          urlOverride: urlOverride || null,
          tokenPresent: Boolean(token),
        },
        host: hostInfo
          ? {
              running: Boolean(hostInfo.running),
              remoteAccessEnabled: hostInfo.remoteAccessEnabled,
              baseUrl: hostInfo.baseUrl ?? null,
              connectUrl: hostInfo.connectUrl ?? null,
              mdnsUrl: hostInfo.mdnsUrl ?? null,
              lanUrl: hostInfo.lanUrl ?? null,
            }
          : null,
      },
      reload: {
        canReloadWorkspace: props.canReloadWorkspace,
      },
      sharing: {
        hostConnectUrl: hostConnectUrl || null,
        hostConnectUrlUsesMdns,
      },
      performance: {
        retainedEntries: perfLogs.length,
        recent: perfLogs,
      },
      developerLogs: {
        retainedEntries: developerLogs.length,
        recent: developerLogs,
      },
    };
    return JSON.stringify(bundle, null, 2);
  }, [
    hostConnectUrl,
    hostConnectUrlUsesMdns,
    hostInfo,
    props.anyActiveRuns,
    props.canReloadWorkspace,
    props.clientConnected,
    props.developerMode,
    props.openrindDesktopServerSettings.token,
    props.openrindDesktopServerSettings.urlOverride,
    props.openrindDesktopServerStatus,
    props.openrindDesktopServerUrl,
    props.runtimeWorkspaceId,
  ]);

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyingField(field);
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopyingField(null);
        copyTimeoutRef.current = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleTestConnection = async () => {
    if (openrindDesktopTestState === "testing") return;
    const next = buildOpenrindDesktopSettings();
    props.updateOpenrindDesktopServerSettings(next);
    setOpenrindDesktopTestState("testing");
    setOpenrindDesktopTestMessage(null);
    try {
      const ok = await props.testOpenrindDesktopServerConnection(next);
      setOpenrindDesktopTestState(ok ? "success" : "error");
      setOpenrindDesktopTestMessage(
        ok ? t("config.connection_successful") : t("config.connection_failed"),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("config.connection_failed_check");
      setOpenrindDesktopTestState("error");
      setOpenrindDesktopTestMessage(message);
    }
  };

  const renderTokenRow = (
    label: string,
    tokenValue: string | null | undefined,
    hint: string,
    visible: boolean,
    toggle: () => void,
    copyKey: string,
  ) => (
    <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-gray-11">{label}</div>
        <div className="text-xs text-gray-7 font-mono truncate">
          {visible ? tokenValue || "—" : tokenValue ? "••••••••••••" : "—"}
        </div>
        <div className="text-[11px] text-gray-8 mt-1">{hint}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          className="text-xs h-8 py-0 px-3"
          onClick={toggle}
          disabled={!tokenValue}
        >
          {visible ? t("common.hide") : t("common.show")}
        </Button>
        <Button
          variant="outline"
          className="text-xs h-8 py-0 px-3"
          onClick={() => handleCopy(tokenValue ?? "", copyKey)}
          disabled={!tokenValue}
        >
          {copyingField === copyKey ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
    </div>
  );

  return (
    <section className="space-y-6">
      <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div className="text-sm font-medium text-gray-12">
          {t("config.workspace_config_title")}
        </div>
        <div className="text-xs text-gray-10">
          {t("config.workspace_config_desc")}
        </div>
        {props.runtimeWorkspaceId ? (
          <div className="text-[11px] text-gray-7 font-mono truncate">
            {t("config.workspace_id_prefix")}
            {props.runtimeWorkspaceId}
          </div>
        ) : null}
      </div>

      <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div className="text-sm font-medium text-gray-12">
            {t("config.engine_reload_title")}
          </div>
          <div className="text-xs text-gray-10">
            {t("config.engine_reload_desc")}
          </div>
        </div>

        <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-sm text-gray-12">
              {t("config.reload_now_title")}
            </div>
            <div className="text-xs text-gray-7">
              {t("config.reload_now_desc")}
            </div>
            {props.anyActiveRuns ? (
              <div className="text-[11px] text-amber-11">
                {t("config.reload_active_tasks_warning")}
              </div>
            ) : null}
            {props.reloadError ? (
              <div className="text-[11px] text-red-11">{props.reloadError}</div>
            ) : null}
            {reloadAvailabilityReason ? (
              <div className="text-[11px] text-gray-9">
                {reloadAvailabilityReason}
              </div>
            ) : null}
          </div>
          <Button
            variant={reloadButtonTone}
            className="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.reloadWorkspaceEngine}
            disabled={reloadButtonDisabled}
          >
            <RefreshCcw
              size={14}
              className={props.reloadBusy ? "animate-spin" : ""}
            />
            {reloadButtonLabel}
          </Button>
        </div>
      </div>

      {props.developerMode ? (
        <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-gray-12">
                {t("config.diagnostics_title")}
              </div>
              <div className="text-xs text-gray-10">
                {t("config.diagnostics_desc")}
              </div>
            </div>
            <Button
              variant="secondary"
              className="text-xs h-8 py-0 px-3 shrink-0"
              onClick={() =>
                void handleCopy(diagnosticsBundleJson, "debug-bundle")
              }
              disabled={props.busy}
            >
              {copyingField === "debug-bundle"
                ? t("config.copied")
                : t("config.copy")}
            </Button>
          </div>
          <pre className="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
            {diagnosticsBundleJson}
          </pre>
        </div>
      ) : null}

      {hostInfo ? (
        <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-gray-12">
                {t("config.server_sharing_title")}
              </div>
              <div className="text-xs text-gray-10">
                {t("config.server_sharing_desc")}
              </div>
            </div>
            <div
              className={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle}`}
            >
              {hostStatusLabel}
            </div>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-11">
                  {t("config.server_url_label")}
                </div>
                <div className="text-xs text-gray-7 font-mono truncate">
                  {hostConnectUrl || t("config.starting_server")}
                </div>
                {hostConnectUrl ? (
                  <div className="text-[11px] text-gray-8 mt-1">
                    {!hostRemoteAccessEnabled
                      ? t("config.remote_access_off_hint")
                      : hostConnectUrlUsesMdns
                        ? t("config.mdns_hint")
                        : t("config.local_ip_hint")}
                  </div>
                ) : null}
              </div>
              <Button
                variant="outline"
                className="text-xs h-8 py-0 px-3 shrink-0"
                onClick={() => handleCopy(hostConnectUrl, "host-url")}
                disabled={!hostConnectUrl}
              >
                {copyingField === "host-url"
                  ? t("config.copied")
                  : t("config.copy")}
              </Button>
            </div>

            {renderTokenRow(
              t("config.collaborator_token_label"),
              hostInfo?.clientToken,
              hostRemoteAccessEnabled
                ? t("config.collaborator_token_remote_hint")
                : t("config.collaborator_token_disabled_hint"),
              clientTokenVisible,
              () => setClientTokenVisible((prev) => !prev),
              "client-token",
            )}

            {renderTokenRow(
              t("config.owner_token_label"),
              hostInfo?.ownerToken,
              hostRemoteAccessEnabled
                ? t("config.owner_token_remote_hint")
                : t("config.owner_token_disabled_hint"),
              ownerTokenVisible,
              () => setOwnerTokenVisible((prev) => !prev),
              "owner-token",
            )}

            {renderTokenRow(
              t("config.host_admin_token_label"),
              hostInfo?.hostToken,
              t("config.host_admin_token_hint"),
              hostTokenVisible,
              () => setHostTokenVisible((prev) => !prev),
              "host-token",
            )}
          </div>

          <div className="text-xs text-gray-9">
            {t("config.server_sharing_menu_hint")}
          </div>
        </div>
      ) : null}

      <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-medium text-gray-12">
              {t("config.server_section_title")}
            </div>
            <div className="text-xs text-gray-10">
              {t("config.server_section_desc")}
            </div>
          </div>
          <div
            className={`text-xs px-2 py-1 rounded-full border ${openrindDesktopStatusStyle}`}
          >
            {openrindDesktopStatusLabel}
          </div>
        </div>

        <div className="grid gap-3">
          <TextInput
            label={t("config.server_url_input_label")}
            value={openrindDesktopUrl}
            onChange={(event) => setOpenrindDesktopUrl(event.currentTarget.value)}
            placeholder="http://127.0.0.1:<port>"
            hint={t("config.server_url_hint")}
            disabled={props.busy}
          />

          <label className="block">
            <div className="mb-1 text-xs font-medium text-gray-11">
              {t("config.token_label")}
            </div>
            <div className="flex items-center gap-2">
              <input
                type={openrindDesktopTokenVisible ? "text" : "password"}
                value={openrindDesktopToken}
                onChange={(event) => setOpenrindDesktopToken(event.currentTarget.value)}
                placeholder={t("config.token_placeholder")}
                disabled={props.busy}
                className="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
              />
              <Button
                variant="outline"
                className="text-xs h-9 px-3 shrink-0"
                onClick={() => setOpenrindDesktopTokenVisible((prev) => !prev)}
                disabled={props.busy}
              >
                {openrindDesktopTokenVisible ? t("common.hide") : t("common.show")}
              </Button>
            </div>
            <div className="mt-1 text-xs text-gray-10">
              {t("config.token_hint")}
            </div>
          </label>
        </div>

        <div className="space-y-1">
          <div className="text-[11px] text-gray-7 font-mono truncate">
            {t("config.resolved_worker_url")}
            {resolvedWorkspaceUrl || t("config.not_set")}
          </div>
          <div className="text-[11px] text-gray-8 font-mono truncate">
            {t("config.worker_id")}
            {resolvedWorkspaceId || t("config.unavailable")}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void handleTestConnection()}
            disabled={props.busy || openrindDesktopTestState === "testing"}
          >
            {openrindDesktopTestState === "testing"
              ? t("config.testing")
              : t("config.test_connection")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              props.updateOpenrindDesktopServerSettings(buildOpenrindDesktopSettings())
            }
            disabled={props.busy || !hasOpenrindDesktopChanges}
          >
            {t("common.save")}
          </Button>
          <Button
            variant="ghost"
            onClick={props.resetOpenrindDesktopServerSettings}
            disabled={props.busy}
          >
            {t("common.reset")}
          </Button>
        </div>

        {openrindDesktopTestState !== "idle" ? (
          <div
            className={`text-xs ${
              openrindDesktopTestState === "success"
                ? "text-green-11"
                : openrindDesktopTestState === "error"
                  ? "text-red-11"
                  : "text-gray-9"
            }`}
            role="status"
            aria-live="polite"
          >
            {openrindDesktopTestState === "testing"
              ? t("config.testing_connection")
              : (openrindDesktopTestMessage ?? t("config.connection_status_updated"))}
          </div>
        ) : null}

        {openrindDesktopStatusLabel !== t("config.status_connected") ? (
          <div className="text-xs text-gray-9">
            {t("config.server_needed_hint")}
          </div>
        ) : null}
      </div>

      <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div className="text-sm font-medium text-gray-12">
          {t("config.messaging_identities_title")}
        </div>
        <div className="text-xs text-gray-10">
          {t("config.messaging_identities_desc")}
        </div>
      </div>

      {!isDesktopRuntime() ? (
        <div className="text-xs text-gray-9">
          {t("config.desktop_only_hint")}
        </div>
      ) : null}
    </section>
  );
}
