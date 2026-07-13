/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, ExternalLink, Loader2, Plus, RefreshCcw, Settings, Trash2, X } from "lucide-react";

import type { SandboxProfile } from "../../app/lib/desktop";
import { Button } from "../design-system/button";
import { ConfirmModal } from "../design-system/modals/confirm-modal";
import {
  readSandboxProfile,
  writeSandboxProfile,
} from "../domains/session/sidebar/sandbox-prefs";
import { useBootState } from "./boot-state";

type ElectronBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Desktop bridge unavailable — OpenEral sandboxes need the OpenWork desktop app.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

type SandboxRow = { name: string; created?: string; phase?: string };
type CredentialStatus = {
  databaseUrl: "set" | "unset";
  anthropicApiKey: "set" | "unset";
  stringcostApiKey: "set" | "unset";
  encryptionAvailable: boolean;
};

// Matches the panel/badge/button vocabulary used across Settings so the screen
// reads as a native part of the app.
const panelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const badgeBaseClass =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider";
const pillButtonClass = "h-8 rounded-full px-3 text-xs";

// Mirror of deriveOpenEralSandboxName() in the main process so the user sees the
// real sandbox name as they type.
function deriveSandboxName(workspaceId: string): string {
  const trimmed = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return trimmed ? `openeral-${trimmed}` : "";
}

function phaseBadge(phase?: string): { cls: string; dot: string; label: string } {
  const p = (phase ?? "").toLowerCase();
  if (/ready|running/.test(p))
    return { cls: "border-green-7/60 bg-green-3/30 text-green-12", dot: "bg-green-9", label: phase || "Ready" };
  if (/provision|starting|pending/.test(p))
    return { cls: "border-amber-7/50 bg-amber-2/30 text-amber-12", dot: "bg-amber-9", label: phase || "Provisioning" };
  if (/error|failed|stopped/.test(p))
    return { cls: "border-red-7/50 bg-red-2/30 text-red-12", dot: "bg-red-9", label: phase || "Error" };
  return { cls: "border-gray-7/40 bg-gray-3/30 text-gray-11", dot: "bg-gray-8", label: phase || "Unknown" };
}

export function SandboxesRoute() {
  const navigate = useNavigate();
  // This route is the app's default landing view, so it must dismiss the
  // boot overlay itself — the overlay only fades once BOTH the desktop boot
  // and the first route's data load are ready (see useBootOverlayVisible).
  const { markRouteReady: markBootRouteReady } = useBootState();

  const [rows, setRows] = useState<SandboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [creds, setCreds] = useState<CredentialStatus | null>(null);

  const [profile, setProfile] = useState<SandboxProfile>("openeral-claude");
  const [newName, setNewName] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const [list, status] = await Promise.all([
        // No openeralListSessions fallback: that handler returns PTY session
        // records (a different shape) and rendered as blank rows. A list
        // failure now surfaces as listError with the Refresh retry.
        invoke<SandboxRow[]>("openeralListSandboxes"),
        invoke<CredentialStatus>("openeralCredentialStatus").catch(() => null),
      ]);
      setRows(Array.isArray(list) ? list : []);
      setCreds(status);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      // First data load complete (success or error) — let the boot overlay
      // dismiss. Idempotent, so repeated refreshes are harmless.
      markBootRouteReady();
    }
  }, [markBootRouteReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dbReady = creds?.databaseUrl === "set";
  const previewName = useMemo(() => deriveSandboxName(newName), [newName]);
  const nameTaken = useMemo(
    () => Boolean(previewName) && rows.some((r) => r.name === previewName),
    [previewName, rows],
  );
  // Fail-open on the credential gate: while the probe is still running (or
  // failed — cold gateway), `creds` is null and blocking Create here made the
  // form feel dead with zero feedback. Only block when we POSITIVELY know
  // DATABASE_URL is unset; a truly missing credential is surfaced with a
  // proper error card + "Open settings" by the terminal bootstrap itself.
  const dbBlocked = creds !== null && !dbReady;
  const canCreate = Boolean(previewName) && !nameTaken && !dbBlocked;

  // Open/create hand off to the session route: the sandbox becomes the
  // selected entry in the sidebar Sandboxes section and its terminal mounts
  // as the session surface (creating the sandbox on first connect). The
  // profile is persisted so reopening an existing sandbox launches the same
  // agent it was created with.
  const openSandbox = (name: string, p: SandboxProfile) => {
    writeSandboxProfile(name, p);
    navigate("/session", {
      state: { openeralSandbox: { name, profile: p } },
    });
  };

  const handleCreate = () => {
    if (!canCreate) return;
    writeSandboxProfile(previewName, profile);
    navigate("/session", {
      state: { openeralSandbox: { name: previewName, profile } },
    });
  };

  const confirmDelete = async () => {
    const name = deleteTarget;
    setDeleteTarget(null);
    if (!name) return;
    setBusyName(name);
    try {
      await invoke("openeralDeleteSandbox", name);
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  // ── Manager view ────────────────────────────────────────────────────────────
  return (
    <div className="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 text-gray-12 md:p-4">
      <main className="flex h-full w-full flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        {/* Header — mirrors the Settings shell header */}
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Boxes size={17} className="shrink-0 text-dls-accent" />
            <h1 className="truncate text-[15px] font-semibold text-dls-text">OpenEral Sandboxes</h1>
            <span className="hidden truncate text-[13px] text-dls-secondary lg:inline">
              Persistent, Postgres-backed agent sandboxes
            </span>
          </div>
          <div className="flex items-center gap-1 text-gray-10">
            <button
              type="button"
              className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:opacity-50"
              onClick={() => void refresh()}
              disabled={loading}
              title="Refresh"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
              onClick={() => navigate("/session")}
              title="Close"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-6 p-6 md:p-10">
            {/* Credentials warning */}
            {creds && !dbReady ? (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-7/40 bg-amber-2/20 p-4 text-amber-12">
                <Settings size={16} className="mt-0.5 shrink-0" />
                <div className="flex-1 text-[13px]">
                  <div className="font-medium">DATABASE_URL is not configured</div>
                  <div className="opacity-90">
                    OpenEral sandboxes need a PostgreSQL connection for persistence. Set it before creating one.
                  </div>
                </div>
                <Button
                  variant="outline"
                  className={`${pillButtonClass} border-amber-7/50 text-amber-12 hover:bg-amber-2/40`}
                  onClick={() => navigate("/settings/environment")}
                >
                  Configure
                </Button>
              </div>
            ) : null}

            {/* Create */}
            <section className={panelClass}>
              <div className="mb-1 flex items-center gap-2">
                <Plus size={15} className="text-dls-accent" />
                <h2 className="text-sm font-semibold text-dls-text">New sandbox</h2>
              </div>
              <p className="mb-4 text-[13px] text-dls-secondary">
                Name it and launch — the agent starts automatically inside a fresh, persistent sandbox.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-gray-8">
                    Sandbox name
                  </div>
                  <input
                    className="h-9 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text placeholder:text-dls-secondary shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                    placeholder="my-project"
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canCreate) handleCreate();
                    }}
                  />
                </div>
                <div className="w-full sm:w-52">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-gray-8">Agent</div>
                  <select
                    className="h-9 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value as SandboxProfile)}
                  >
                    <option value="openeral-claude">Claude Code</option>
                    <option value="openeral-openclaw">OpenClaw</option>
                  </select>
                </div>
                <Button
                  variant="primary"
                  className="h-9 rounded-full px-4 text-xs"
                  onClick={handleCreate}
                  disabled={!canCreate}
                >
                  Create &amp; launch
                </Button>
              </div>
              {nameTaken ? (
                <div className="mt-2 text-[11px] text-amber-11">
                  A sandbox with this name already exists.
                </div>
              ) : previewName ? (
                <div className="mt-2 text-[11px] text-dls-secondary">
                  Creates{" "}
                  <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">{previewName}</code>
                </div>
              ) : null}
            </section>

            {/* List */}
            <section className={panelClass}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-dls-text">
                  Your sandboxes
                  {rows.length ? <span className="ml-1.5 text-dls-secondary">({rows.length})</span> : null}
                </h2>
              </div>

              {listError ? (
                <div className="mb-4 rounded-xl border border-red-7/40 bg-red-2/30 p-3 text-[13px] text-red-12">
                  {listError}
                </div>
              ) : null}

              {loading && rows.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-dls-secondary">
                  <Loader2 size={16} className="animate-spin" />
                  Loading sandboxes…
                </div>
              ) : rows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-dls-border py-10 text-center">
                  <Boxes size={26} className="mx-auto mb-2 text-dls-secondary" />
                  <div className="text-sm font-medium text-dls-text">No sandboxes yet</div>
                  <div className="mt-1 text-[13px] text-dls-secondary">
                    Create your first one above to launch an agent.
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-dls-border overflow-hidden rounded-2xl border border-dls-border">
                  {rows.map((row) => {
                    const badge = phaseBadge(row.phase);
                    const busy = busyName === row.name;
                    return (
                      <li key={row.name} className="flex items-center gap-3 bg-dls-surface px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-dls-text">{row.name}</span>
                            <span className={`${badgeBaseClass} ${badge.cls}`}>
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                              {badge.label}
                            </span>
                          </div>
                          {row.created ? (
                            <div className="mt-0.5 text-[11px] text-dls-secondary">Created {row.created}</div>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          className="h-8 w-8 !rounded-full !p-0"
                          onClick={() =>
                            openSandbox(row.name, readSandboxProfile(row.name))
                          }
                          disabled={busy}
                          title={`Open ${row.name}`}
                          aria-label={`Open ${row.name}`}
                        >
                          <ExternalLink size={14} />
                        </Button>
                        <Button
                          variant="outline"
                          className="h-8 w-8 !rounded-full !p-0 border-red-7/50 text-red-12 hover:bg-red-2/30"
                          onClick={() => setDeleteTarget(row.name)}
                          disabled={busy}
                          title={`Delete ${row.name}`}
                          aria-label={`Delete ${row.name}`}
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete sandbox?"
        message={
          <span>
            Delete <span className="font-medium text-dls-text">{deleteTarget}</span>? The container is
            removed, but its Postgres-backed <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">/home/agent</code>{" "}
            data persists and is restored if you recreate a sandbox with the same name.
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
