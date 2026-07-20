/** @jsxImportSource react */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";

import type { SandboxProfile } from "../../../../app/lib/desktop";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import {
  inputClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
} from "../../workspace/modal-styles";
import {
  readSandboxProfile,
  sandboxDisplayName,
  writeSandboxDisplayName,
} from "./sandbox-prefs";

type SandboxRow = { name: string; created?: string; phase?: string };

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

const COLLAPSED_KEY = "openrind-shell-sandboxes-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export type SandboxSessionListProps = {
  selectedSandboxName: string | null;
  onSelectSandbox: (name: string, profile: SandboxProfile) => void;
  onOpenManager: () => void;
  onOpenSettings: () => void;
  onSandboxDeleted?: (name: string) => void;
};

export function SandboxSessionList(props: SandboxSessionListProps) {
  const bridge = getBridge();
  const [rows, setRows] = useState<SandboxRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [rowMenuFor, setRowMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renamingForRef = useRef<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const refreshInFlightRef = useRef(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
      }
      return next;
    });
  }, []);

  const anyMenuOpen = headerMenuOpen || rowMenuFor !== null;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setHeaderMenuOpen(false);
        setRowMenuFor(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHeaderMenuOpen(false);
        setRowMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anyMenuOpen]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const currentBridge = getBridge();
    if (!currentBridge?.invokeDesktop) return false;
    if (refreshInFlightRef.current) return true;
    refreshInFlightRef.current = true;
    try {
      const list = (await currentBridge.invokeDesktop(
        "openrindListSandboxes",
      )) as SandboxRow[];
      if (Array.isArray(list)) {
        setRows(
          list.filter(
            (row) =>
              typeof row?.name === "string" &&
              row.name.startsWith("openrind-shell-"),
          ),
        );
      }
      setLoaded(true);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    const retryDelays = [2_000, 4_000, 8_000, 15_000, 30_000];
    let attempt = 0;
    const kick = async () => {
      const ok = await refresh();
      if (cancelled || ok) return;
      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        attempt += 1;
        retryTimer = window.setTimeout(() => void kick(), delay);
      }
    };
    void kick();
    let debounce: number | null = null;
    const unsubscribe = bridge.openrindShell?.onSessionProgress?.(() => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void refresh();
      }, 1_200);
    });
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe?.();
      if (debounce !== null) window.clearTimeout(debounce);
      window.clearInterval(interval);
    };
  }, [bridge, refresh]);

  const beginRename = useCallback((name: string) => {
    renamingForRef.current = name;
    setRenameValue(sandboxDisplayName(name));
    setRenamingFor(name);
  }, []);

  const cancelRename = useCallback(() => {
    renamingForRef.current = null;
    setRenamingFor(null);
    setRenameValue("");
  }, []);

  const commitRename = useCallback(
    (name: string) => {
      if (renamingForRef.current !== name) return;
      renamingForRef.current = null;
      writeSandboxDisplayName(name, renameValue);
      setRenamingFor(null);
      setRenameValue("");
    },
    [renameValue],
  );

  const confirmDelete = useCallback(async () => {
    const name = deleteTarget;
    setDeleteTarget(null);
    if (!name) return;
    const currentBridge = getBridge();
    if (!currentBridge?.invokeDesktop) return;
    setBusyName(name);
    setDeleteError(null);
    try {
      await currentBridge.invokeDesktop("openrindDeleteSandbox", name);
      props.onSandboxDeleted?.(name);
      await refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  }, [deleteTarget, props, refresh]);

  if (!bridge) return null;

  return (
    <div
      className={`mt-auto flex flex-col border-t border-dls-border pb-2 pt-2 ${
        collapsed ? "shrink-0" : "min-h-0 flex-1"
      }`}
    >
      <div className="relative group shrink-0">
        <div
          role="button"
          tabIndex={0}
          className="w-full flex items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-[13px] text-gray-10"
          onClick={toggleCollapsed}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            toggleCollapsed();
          }}
        >
          <div className="flex min-w-0 items-center gap-3.5">
            <Boxes size={18} className="shrink-0 text-dls-secondary" />
            <div className="min-w-0 whitespace-nowrap text-[13px] font-normal text-dls-text">
              Sandboxes
            </div>
          </div>

          <div className="ml-4 flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenManager();
                }}
                aria-label="New sandbox"
                title="Open the sandbox manager"
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                onClick={(event) => {
                  event.stopPropagation();
                  setRowMenuFor(null);
                  setHeaderMenuOpen((current) => !current);
                }}
                aria-label="Sandbox options"
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
              aria-label={collapsed ? "Expand sandboxes" : "Collapse sandboxes"}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed();
              }}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {headerMenuOpen ? (
          <div
            ref={menuRef}
            className="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
              onClick={() => {
                setHeaderMenuOpen(false);
                props.onOpenSettings();
              }}
            >
              Sandbox settings
            </button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          <div className="relative mt-1 flex flex-col gap-1 pl-2.5 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-3 before:content-['']">
            {deleteError ? (
              <div className="w-full rounded-[15px] border border-red-7/35 bg-red-1/40 px-3 py-2 text-left text-[11px] text-red-11">
                {deleteError}
              </div>
            ) : null}
            {!loaded ? (
              // Loading skeleton — mirrors the workspaces list skeleton so the
              // Sandboxes section shows placeholder rows while the first fetch
              // (and any gateway warmup) is in flight, instead of a bare
              // "Loading…" line.
              <div className="space-y-2">
                {[0, 1, 2].map((idx) => (
                  <div
                    key={`sandbox:skeleton:${idx}`}
                    className="w-full rounded-[15px] border border-dls-border/70 bg-dls-hover/30 px-3 py-2.5"
                  >
                    <div
                      className="h-2.5 rounded-full bg-dls-hover/80 animate-pulse"
                      style={{ width: idx === 0 ? "62%" : idx === 1 ? "78%" : "54%" }}
                    />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <button
                type="button"
                className="w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                onClick={props.onOpenManager}
              >
                No sandboxes yet — create one
              </button>
            ) : (
              rows.map((row) => {
                const selected = props.selectedSandboxName === row.name;
                const busy = busyName === row.name;
                const isRenaming = renamingFor === row.name;
                return (
                  <div key={row.name} className="relative">
                    <div
                      role="button"
                      tabIndex={0}
                      className={`group flex min-h-9 w-full items-center justify-between rounded-xl px-3 py-1.5 text-left text-[13px] transition-colors ${
                        selected
                          ? "bg-gray-3 text-gray-12"
                          : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
                      } ${busy ? "opacity-60" : ""}`}
                      title={row.name}
                      onClick={() => {
                        if (isRenaming || busy) return;
                        props.onSelectSandbox(
                          row.name,
                          readSandboxProfile(row.name),
                        );
                      }}
                      onKeyDown={(event) => {
                        if (isRenaming || busy) return;
                        if (event.key !== "Enter" && event.key !== " ") return;
                        if (
                          event.nativeEvent.isComposing ||
                          event.keyCode === 229
                        )
                          return;
                        event.preventDefault();
                        props.onSelectSandbox(
                          row.name,
                          readSandboxProfile(row.name),
                        );
                      }}
                    >
                      <div className="mr-2.5 flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={`block min-w-0 truncate ${
                            selected
                              ? "font-medium text-gray-12"
                              : "font-normal text-current"
                          }`}
                        >
                          {sandboxDisplayName(row.name)}
                        </span>
                      </div>

                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {busy ? (
                          <Loader2
                            size={13}
                            className="animate-spin text-gray-9"
                          />
                        ) : null}
                        {!isRenaming && (selected || rowMenuFor === row.name) ? (
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-11"
                            aria-label="Sandbox actions"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setHeaderMenuOpen(false);
                              setRowMenuFor((current) =>
                                current === row.name ? null : row.name,
                              );
                            }}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {rowMenuFor === row.name ? (
                      <div
                        ref={menuRef}
                        className="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                          onClick={() => {
                            setRowMenuFor(null);
                            beginRename(row.name);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
                          onClick={() => {
                            setRowMenuFor(null);
                            setDeleteError(null);
                            setDeleteTarget(row.name);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}

      {renamingFor ? (
        <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-12">
                    Rename sandbox
                  </h3>
                  <p className="mt-1 text-sm text-gray-11">
                    Choose a display name for this sandbox in the sidebar.
                  </p>
                </div>
                <button
                  type="button"
                  className={`${pillGhostClass} !p-2 rounded-full`}
                  onClick={cancelRename}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="mt-6">
                <label className="mb-1.5 block text-[13px] font-medium text-dls-text">
                  Name
                </label>
                <input
                  autoFocus
                  type="text"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelRename();
                      return;
                    }
                    if (
                      event.key !== "Enter" ||
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    )
                      return;
                    event.preventDefault();
                    if (renamingFor && renameValue.trim())
                      commitRename(renamingFor);
                  }}
                  placeholder="Sandbox name"
                  className={`${inputClass} bg-gray-3`}
                />
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  className={pillSecondaryClass}
                  onClick={cancelRename}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={pillPrimaryClass}
                  onClick={() => {
                    if (renamingFor) commitRename(renamingFor);
                  }}
                  disabled={!renameValue.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete sandbox?"
        message={
          <span>
            Delete{" "}
            <span className="font-medium text-dls-text">{deleteTarget}</span>?
            The container is removed, but its Postgres-backed{" "}
            <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">
              /home/agent
            </code>{" "}
            data persists and is restored if you recreate a sandbox with the
            same name.
          </span>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
