/** @jsxImportSource react */
import type { ComponentProps, PointerEventHandler, ReactNode } from "react";
import { X } from "lucide-react";

import { t } from "../../../../i18n";
import { SettingsPage, getSettingsTabLabel } from "./settings-page";
import { WorkspaceSessionList } from "../../session/sidebar/workspace-session-list";
import { SidebarTabs, type SidebarTab } from "../../session/sidebar/sidebar-tabs";

type SettingsPageChromeProps = Omit<ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageChromeProps & {
  selectedWorkspaceName: string;
  headerStatus?: string;
  busyHint?: string | null;
  workspaceSessionListProps: ComponentProps<typeof WorkspaceSessionList>;
  /** Full-height sandbox panel, shown behind the same segmented switcher the
   *  session route uses. Settings must not fall back to a different sidebar
   *  than the rest of the app. */
  sandboxSidebar?: ReactNode;
  sandboxWarningCount?: number;
  sidebarTab?: SidebarTab;
  onSidebarTabChange?: (tab: SidebarTab) => void;
  onClose: () => void;
  sidebarTopSlot?: ReactNode;
  headerLeadingSlot?: ReactNode;
  sidebarWidth?: number;
  onSidebarResizeStart?: PointerEventHandler<HTMLDivElement>;
  children: ReactNode;
  error?: string | null;
  errorSlot?: ReactNode;
  modalSlot?: ReactNode;
  footer?: ReactNode;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);
  const sidebarTab: SidebarTab = props.sidebarTab ?? "sessions";

  return (
    <div className="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 text-gray-12 md:p-4">
      <div className="flex h-full w-full gap-3 md:gap-4">
        <aside
          className="relative hidden shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-2.5 lg:flex"
          style={props.sidebarWidth ? { width: `${props.sidebarWidth}px`, minWidth: `${props.sidebarWidth}px` } : undefined}
        >
          {props.sidebarTopSlot ? <div className="shrink-0">{props.sidebarTopSlot}</div> : null}
          {props.sandboxSidebar ? (
            <SidebarTabs
              value={sidebarTab}
              onChange={(tab) => props.onSidebarTabChange?.(tab)}
              sandboxWarningCount={props.sandboxWarningCount}
            />
          ) : null}
          <div className={`flex min-h-0 flex-1 ${sidebarTab === "sandboxes" ? "hidden" : ""}`}>
            <WorkspaceSessionList {...props.workspaceSessionListProps} />
          </div>
          {/* Kept mounted while hidden so the sandbox poller and its gateway
              warm-up backoff survive a tab switch. */}
          {props.sandboxSidebar ? (
            <div
              className={`flex min-h-0 flex-1 ${sidebarTab === "sandboxes" ? "" : "hidden"}`}
            >
              {props.sandboxSidebar}
            </div>
          ) : null}
          {props.onSidebarResizeStart ? (
            <div
              className="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 md:block"
              onPointerDown={props.onSidebarResizeStart}
              title={t("session.resize_workspace_column")}
              aria-label={t("session.resize_workspace_column")}
            />
          ) : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <div className="flex-1 overflow-y-auto">
            <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
              <div className="flex min-w-0 items-center gap-3">
                {props.headerLeadingSlot}
                <h1 className="truncate text-[15px] font-semibold text-dls-text">{title}</h1>
                <span className="hidden truncate text-[13px] text-dls-secondary lg:inline">
                  {props.selectedWorkspaceName}
                </span>
                {props.developerMode && props.headerStatus ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.headerStatus}
                  </span>
                ) : null}
                {props.busyHint ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.busyHint}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center text-gray-10">
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                  onClick={props.onClose}
                  title={t("dashboard.close_settings")}
                  aria-label={t("dashboard.close_settings")}
                >
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="w-full space-y-10 p-6 md:p-10">
              <SettingsPage {...props}>{props.children}</SettingsPage>
            </div>

            {props.error ? (
              <div className="mx-auto max-w-5xl px-6 pb-24 md:px-10 md:pb-10">
                <div className="space-y-3 rounded-2xl border border-red-7/20 bg-red-1/40 px-5 py-4 text-sm text-red-12">
                  <div>{props.error}</div>
                  {props.errorSlot}
                </div>
              </div>
            ) : null}

            {props.modalSlot}
          </div>

          {props.footer}
        </main>
      </div>
    </div>
  );
}
