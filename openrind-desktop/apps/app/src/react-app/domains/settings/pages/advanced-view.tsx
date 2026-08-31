/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Cpu, RefreshCcw, Server, Zap } from "lucide-react";

import type { OpencodeConnectStatus } from "../../../../app/types";
import type { OpenrindDesktopServerStatus } from "../../../../app/lib/openrind-desktop-server";
import { t } from "../../../../i18n";

import { ConfigView, type ConfigViewProps } from "./config-view";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const settingsPanelSoftClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

type RuntimeStatusCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  statusLabel: string;
  statusStyle: string;
  statusDot: string;
};

export type AdvancedViewProps = {
  busy: boolean;
  baseUrl: string;
  headerStatus: string;
  clientConnected: boolean;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  openrindDesktopServerStatus: OpenrindDesktopServerStatus;
  openrindDesktopServerUrl: string;
  openrindDesktopReconnectBusy: boolean;
  reconnectOpenrindDesktopServer: () => Promise<boolean>;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  configView: ConfigViewProps;
};

function RuntimeStatusCard(props: RuntimeStatusCardProps) {
  return (
    <div className={`${settingsPanelSoftClass} space-y-3`}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
          {props.icon}
        </div>
        <div>
          <div className="text-sm font-medium text-gray-12">{props.title}</div>
          <div className="text-xs text-gray-9">{props.description}</div>
        </div>
      </div>
      <div
        className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${props.statusStyle}`}
      >
        <span className={`h-2 w-2 rounded-full ${props.statusDot}`} />
        {props.statusLabel}
      </div>
    </div>
  );
}

export function AdvancedView(props: AdvancedViewProps) {
  const [reconnectStatus, setReconnectStatus] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const clientStatusLabel = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return t("status.connecting");
    if (status === "error") return t("settings.connection_failed");
    return props.clientConnected ? t("status.connected") : t("config.status_not_connected");
  })();

  const clientStatusStyle = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (status === "error") return "bg-red-7/10 text-red-11 border-red-7/20";
    return props.clientConnected
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  })();

  const clientStatusDot = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "bg-amber-9";
    if (status === "error") return "bg-red-9";
    return props.clientConnected ? "bg-green-9" : "bg-gray-6";
  })();

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

  const openrindDesktopStatusDot = (() => {
    switch (props.openrindDesktopServerStatus) {
      case "connected":
        return "bg-green-9";
      case "limited":
        return "bg-amber-9";
      default:
        return "bg-gray-6";
    }
  })();

  const handleReconnect = async () => {
    if (props.busy || props.openrindDesktopReconnectBusy || !props.openrindDesktopServerUrl.trim()) return;
    setReconnectStatus(null);
    setReconnectError(null);
    try {
      const ok = await props.reconnectOpenrindDesktopServer();
      if (!ok) {
        setReconnectError(t("settings.reconnect_failed"));
        return;
      }
      setReconnectStatus(t("settings.reconnected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReconnectError(message || t("settings.reconnect_server_failed"));
    }
  };

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-4`}>
        <div>
          <div className="text-sm font-medium text-gray-12">{t("settings.runtime_title")}</div>
          <div className="text-xs text-gray-9">{t("settings.runtime_desc")}</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <RuntimeStatusCard
            icon={<Cpu size={18} />}
            title={t("settings.opencode_engine_label")}
            description={t("settings.opencode_engine_desc")}
            statusLabel={clientStatusLabel}
            statusStyle={clientStatusStyle}
            statusDot={clientStatusDot}
          />
          <RuntimeStatusCard
            icon={<Server size={18} />}
            title={t("settings.openrind_desktop_server_label")}
            description={t("settings.openrind_desktop_server_desc")}
            statusLabel={openrindDesktopStatusLabel}
            statusStyle={openrindDesktopStatusStyle}
            statusDot={openrindDesktopStatusDot}
          />
        </div>
      </div>

      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="text-sm font-medium text-gray-12">{t("settings.developer_mode_title")}</div>
        <div className="text-xs text-gray-9">{t("settings.developer_mode_desc")}</div>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium shadow-sm transition-colors duration-150 focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
              props.developerMode
                ? "border-blue-7/35 bg-blue-3/20 text-blue-11 hover:bg-blue-3/35 hover:text-blue-11 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
                : "border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
            }`}
            onClick={props.toggleDeveloperMode}
          >
            <Zap size={14} className={props.developerMode ? "text-blue-10" : "text-dls-secondary"} />
            {props.developerMode
              ? t("settings.disable_developer_mode")
              : t("settings.enable_developer_mode")}
          </button>
          <div className="text-xs text-gray-10">
            {props.developerMode
              ? t("settings.developer_panel_enabled")
              : t("settings.developer_panel_disabled")}
          </div>
        </div>
      </div>

      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="text-sm font-medium text-gray-12">{t("settings.connection_title")}</div>
        <div className="text-xs text-gray-9">{props.headerStatus}</div>
        <div className="break-all font-mono text-xs text-gray-8">{props.baseUrl}</div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handleReconnect()}
            disabled={props.busy || props.openrindDesktopReconnectBusy || !props.openrindDesktopServerUrl.trim()}
          >
            <RefreshCcw size={14} className={`text-dls-secondary ${props.openrindDesktopReconnectBusy ? "animate-spin" : ""}`} />
            {props.openrindDesktopReconnectBusy ? t("settings.reconnecting") : t("settings.reconnect_server")}
          </button>
        </div>

        {reconnectStatus ? <div className="text-xs text-gray-10">{reconnectStatus}</div> : null}
        {reconnectError ? <div className="text-xs text-red-11">{reconnectError}</div> : null}
      </div>

      {props.developerMode ? <ConfigView {...props.configView} /> : null}
    </div>
  );
}
