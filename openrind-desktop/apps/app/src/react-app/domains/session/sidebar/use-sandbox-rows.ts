/**
 * Single source of truth for the sandbox list.
 *
 * Three surfaces need the same rows — the sidebar panel, the command palette,
 * and the "jump to the next sandbox that needs me" keybinding — so the fetch
 * lives here rather than inside the panel. Duplicating it would mean duplicate
 * polling against the OpenShell gateway, and the two copies would disagree
 * about status for up to a minute.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  resolveSandboxStatus,
  sortByStatus,
  needsUserAttention,
  type SandboxStatus,
} from "./sandbox-status";
import { readSandboxProfile, sandboxDisplayName, writeSandboxDisplayName } from "./sandbox-prefs";
import type { SandboxProfile } from "../../../../app/lib/desktop";
import { deriveSandboxName } from "../sandbox-name";

export { deriveSandboxName } from "../sandbox-name";

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

type RawSandboxRow = { name: string; created?: string; phase?: string };

export type SandboxListRow = {
  /** OpenShell sandbox name — the stable identity. */
  name: string;
  /** User-facing label (rename is cosmetic; the sandbox name never changes). */
  displayName: string;
  created?: string | undefined;
  phase?: string | undefined;
  status: SandboxStatus;
  profile: SandboxProfile;
  /** A PTY session for this sandbox is open in the app. */
  hasLiveSession: boolean;
  /** True while a destructive action is in flight for this row. */
  busy: boolean;
};

export type SandboxRowsState = {
  rows: SandboxListRow[];
  loaded: boolean;
  error: string | null;
  warningCount: number;
  refresh: () => Promise<boolean>;
  rename: (name: string, displayName: string) => void;
  remove: (name: string) => Promise<void>;
  clearError: () => void;
};

/** Only Openrind Shell sandboxes belong in this list. */
const NAME_PREFIX = "or-";

export function useSandboxRows(options?: {
  onDeleted?: (name: string) => void;
}): SandboxRowsState {
  const bridge = getBridge();
  const [raw, setRaw] = useState<RawSandboxRow[]>([]);
  const [liveSessions, setLiveSessions] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  // Bumped on rename so the memo below recomputes; display names live in
  // localStorage rather than in this state.
  const [labelVersion, setLabelVersion] = useState(0);
  const refreshPromise = useRef<Promise<boolean> | null>(null);
  const onDeletedRef = useRef(options?.onDeleted);
  onDeletedRef.current = options?.onDeleted;

  const refresh = useCallback(async (): Promise<boolean> => {
    const currentBridge = getBridge();
    if (!currentBridge?.invokeDesktop) return false;
    if (refreshPromise.current) return refreshPromise.current;

    const doRefresh = async (): Promise<boolean> => {
      try {
        const list = (await currentBridge!.invokeDesktop!(
          "openrindListSandboxes",
        )) as RawSandboxRow[];
        if (Array.isArray(list)) {
          setRaw(
            list.filter(
              (row) => typeof row?.name === "string" && row.name.startsWith(NAME_PREFIX),
            ),
          );
        }
        // Best-effort: a failure here only costs the "live session" dot, so it
        // must never fail the whole refresh.
        try {
          const sessions = (await currentBridge!.invokeDesktop!("openrindPtyList")) as Array<{
            sandboxName?: string;
            exited?: boolean;
          }>;
          if (Array.isArray(sessions)) {
            setLiveSessions(
              new Set(
                sessions
                  .filter((entry) => entry && !entry.exited)
                  .map((entry) => entry.sandboxName)
                  .filter((name): name is string => typeof name === "string"),
              ),
            );
          }
        } catch {
          /* leave the previous set in place */
        }
        setLoaded(true);
        return true;
      } finally {
        refreshPromise.current = null;
      }
    };

    refreshPromise.current = doRefresh();
    return refreshPromise.current;
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    // The OpenShell gateway is started lazily and the WSL distro idles down, so
    // the first fetch after a cold app start routinely fails. Back off instead
    // of leaving the panel permanently empty.
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

  const rename = useCallback((name: string, displayName: string) => {
    writeSandboxDisplayName(name, displayName);
    setLabelVersion((value) => value + 1);
  }, []);

  const remove = useCallback(
    async (name: string) => {
      const currentBridge = getBridge();
      if (!currentBridge?.invokeDesktop) return;
      setBusyName(name);
      setError(null);
      try {
        await currentBridge.invokeDesktop("openrindDeleteSandbox", name);
        onDeletedRef.current?.(name);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  const rows = useMemo<SandboxListRow[]>(() => {
    void labelVersion; // recompute when a display name changes
    const mapped = raw.map<SandboxListRow>((row) => {
      const hasLiveSession = liveSessions.has(row.name);
      return {
        name: row.name,
        displayName: sandboxDisplayName(row.name),
        created: row.created,
        phase: row.phase,
        status: resolveSandboxStatus({ phase: row.phase, hasLiveSession }),
        profile: readSandboxProfile(row.name),
        hasLiveSession,
        busy: busyName === row.name,
      };
    });
    return sortByStatus(mapped, (row) => row.status);
  }, [raw, liveSessions, busyName, labelVersion]);

  const warningCount = useMemo(
    () => rows.filter((row) => needsUserAttention(row.status)).length,
    [rows],
  );

  return {
    rows,
    loaded,
    error,
    warningCount,
    refresh,
    rename,
    remove,
    clearError: useCallback(() => setError(null), []),
  };
}
