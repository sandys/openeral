/** @jsxImportSource react */
import { t } from "../../../../i18n";

/**
 * Segmented switcher for the sidebar's two object types.
 *
 * Sessions and sandboxes are different things with different lifecycles, and
 * stacking both in one scroll column meant the second one got whatever space
 * was left — in practice a collapsed strip at the bottom. Giving each the full
 * column is the same call Docker Desktop and VS Code make: show one object type
 * at a time and switch, rather than compete for height.
 *
 * Uses the selector-track pattern from DESIGN-LANGUAGE §9, with the flat
 * selected-row treatment (§9, "Flat selected row pattern") rather than a white
 * floating pill — the track sits inside a near-white shell, where a white pill
 * would read as a second surface.
 */

export type SidebarTab = "sessions" | "sandboxes";

export type SidebarTabsProps = {
  value: SidebarTab;
  onChange: (tab: SidebarTab) => void;
  /** Rendered on the sandboxes tab when a sandbox has failed. */
  sandboxWarningCount?: number;
  sandboxCount?: number;
};

export function SidebarTabs(props: SidebarTabsProps) {
  const tabs: Array<{ id: SidebarTab; label: string }> = [
    { id: "sessions", label: t("sidebar.tab_sessions") },
    { id: "sandboxes", label: t("sidebar.tab_sandboxes") },
  ];

  return (
    <div className="shrink-0 px-3 pb-1 pt-3">
      <div
        role="tablist"
        aria-label={t("sidebar.tab_sessions")}
        className="flex items-center gap-1 rounded-full border border-dls-border bg-dls-hover/40 p-1"
      >
        {tabs.map((tab) => {
          const active = props.value === tab.id;
          const warning =
            tab.id === "sandboxes" ? (props.sandboxWarningCount ?? 0) : 0;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`relative flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full text-[12px] transition-colors ${
                active
                  ? "bg-gray-3 font-medium text-gray-12"
                  : "text-gray-10 hover:text-gray-11"
              }`}
              onClick={() => props.onChange(tab.id)}
            >
              <span className="truncate">{tab.label}</span>
              {/* An error dot rather than a count: the exact number lives in
                  the panel header, and a badge here would compete with the
                  label for a very small target. */}
              {warning > 0 && !active ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-9"
                  aria-hidden
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
