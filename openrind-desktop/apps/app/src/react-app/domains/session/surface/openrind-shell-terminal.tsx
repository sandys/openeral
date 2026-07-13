/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Settings,
  Square,
  Trash2,
} from "lucide-react";

import type { SandboxProfile } from "../../../../app/lib/desktop";
import { Button } from "../../../design-system/button";
import { useVoiceInput } from "./composer/voice/use-voice-input";
import { VoiceEngineMenu } from "./composer/voice/voice-engine-menu";

// Shared flat "ghost" toolbar button, matching the chat session header so the
// Openrind Shell terminal toolbar reads as the same product surface.
const TOOLBAR_BTN =
  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60";

// xterm.js is loaded dynamically so it doesn't bloat the workspace
// dashboard bundle for users who never open an Openrind Shell session.
type TerminalType = import("@xterm/xterm").Terminal;
type FitAddonType = import("@xterm/addon-fit").FitAddon;

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Electron desktop bridge is not available.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

export type OpenrindShellTerminalProps = {
   workspaceId: string;
  profile: SandboxProfile;
  /** Optional agent conversation binding. When set, the launched agent is
   *  bound to this id (Claude Code `--session-id`/`--resume`, OpenClaw
   *  `--session`) and the PTY registry keys on (sandbox, sessionId) —
   *  sessions are CONCURRENT, so other conversations' PTYs keep working
   *  while this one is shown. Null/undefined ⇒ the sandbox's default
   *  conversation (the sidebar Sandboxes entries use this). */
  sessionId?: string | null;
  /** Optional callback when the renderer decides to fully tear down the
   *  workspace (clicked "Delete sandbox" + confirmed). Caller is
   *  responsible for navigating away. */
  onSandboxDeleted?: () => void;
  /** Optional callback to route the user to Settings when the bootstrap
   *  fails. Credential errors (DATABASE_URL / ANTHROPIC_API_KEY) target the
   *  Environment page where the sandbox keys are managed; infrastructure
   *  errors (gateway / installer) target the Sandbox page. */
  onOpenSettings?: (target: "environment" | "sandbox") => void;
  /** When provided, a "Chat" button appears in the toolbar letting the
   *  user switch back to the regular Openrind Desktop chat UI. The PTY session
   *  ends but the sandbox persists — switching back to Terminal reconnects. */
  onSwitchToChat?: () => void;
  /** When provided, called after the user commits a display-label rename.
   *  The settings TestLaunchPanel uses this to stop the current session and
   *  update the workspace ID so the next "Launch session" connects to a
   *  fresh sandbox with the new name. In the main session view this prop is
   *  NOT passed — the rename is cosmetic (localStorage) only. */
  onRenameCommit?: (newName: string) => void;
};

type Phase =
  | "starting"
  | "ensuring-sandbox"
  | "mounting-terminal"
  | "connecting-pty"
  | "connected"
  | "exited"
  | "error";

/**
 * Mirrors deriveOpenrindShellSandboxName() in openrind-shell-terminal.mjs.
 * Used to pre-populate lastKnownSandboxNameRef so deleteAndReconnect can
 * delete a broken sandbox even when openrindEnsureSandbox throws before
 * returning (i.e. before setSandboxName is ever called).
 */
function deriveExpectedSandboxName(workspaceId: string): string {
  const trimmed = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `openrind-shell-${trimmed}`;
}

export function OpenrindShellTerminal(props: OpenrindShellTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalType | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Persists the last successfully resolved sandbox name so that the
  // "Delete sandbox" and "Pop out" buttons remain functional even when
  // sandboxName state is null (e.g. after an error before first connect).
  const lastKnownSandboxNameRef = useRef<string | null>(null);
  // Buffer to hold PTY bytes that arrive before xterm.js finishes
  // mounting and the data subscription is set up.
  const earlyBufferRef = useRef<string[]>([]);
  // True when the current unmount is an explicit "end session" / delete
  // (kill the PTY) rather than navigation (detach + keep the PTY alive so
  // returning replays the buffer). cleanup() reads this to choose between
  // openrindPtyDetach and openrindPtyClose.
  const explicitEndRef = useRef(false);

  const [sandboxName, setSandboxName] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  // True only while a FIRST-TIME bootstrap is running (image pull / sandbox
  // create / fresh connect). A lossless re-attach to an already-running PTY
  // leaves this false so the 3-step bootstrap overlay never flashes.
  const [isFreshBootstrap, setIsFreshBootstrap] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [popoutBusy, setPopoutBusy] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);

  // Overflow ("⋮") menu for secondary/management actions, so the main toolbar
  // stays to its essentials.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // User-editable display name for the sandbox. The actual sandbox name
  // used by openshell never changes — this is purely cosmetic.
  const [displayName, setDisplayName] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // Derived sandbox name from workspaceId — available immediately without
  // waiting for openrindEnsureSandbox to return. Shown in the header from
  // the very first render so the user never sees "(no sandbox)".
  const expectedSandboxName = useMemo(
    () => deriveExpectedSandboxName(props.workspaceId),
    [props.workspaceId],
  );

  // Stable callback for "reconnect" so the user can rebuild a dead PTY
  // without rerendering the whole component.
  const [reconnectKey, setReconnectKey] = useState(0);
  const reconnect = useCallback(() => setReconnectKey((k) => k + 1), []);

  // True when the user deliberately cancelled a provisioning operation.
  // While true, run() exits immediately to "exited" phase so the spinner
  // disappears. handleLaunch clears this flag and increments reconnectKey.
  const [userAborted, setUserAborted] = useState(false);
  const lastAbortedWorkspaceRef = useRef<string | null>(null);

  const handleAbort = useCallback(() => {
    lastAbortedWorkspaceRef.current = props.workspaceId;
    setUserAborted(true);
    setReconnectKey((k) => k + 1); // triggers cleanup of the current run()
  }, [props.workspaceId]);

  const handleLaunch = useCallback(() => {
    setUserAborted(false);
    lastAbortedWorkspaceRef.current = null;
    explicitEndRef.current = false;
    // Close any stale (likely exited) session first so the next run()'s probe
    // doesn't re-attach to the corpse — we want a genuinely fresh connect.
    const staleId = sessionIdRef.current;
    sessionIdRef.current = null;
    void (async () => {
      if (staleId) {
        try {
          await invoke("openrindPtyClose", staleId);
        } catch {
          // Best-effort — a fresh bootstrap recovers regardless.
        }
      }
      setReconnectKey((k) => k + 1);
    })();
  }, []);



  // Track whether this component has ever reached "connected" phase so we
  // can show "Launch session" on first open vs "Reconnect" after a drop.
  const [hasEverConnected, setHasEverConnected] = useState(false);

  // True when the current error message means the sandbox must be deleted
  // before a retry can succeed (stuck-provisioning or container error state).
  // Used to make the toolbar button call deleteAndReconnect instead of reconnect
  // so the broken sandbox is removed even if the user skips the error card.
  const errorNeedsDelete = Boolean(
    errorMessage &&
    (/STUCK_PROVISIONING:/i.test(errorMessage) ||
      /is in error state/i.test(errorMessage)),
  );

  // Load/persist the user-facing display name from localStorage.
  // Uses sandboxName (confirmed by backend) when available, falls back to
  // expectedSandboxName (derived from workspaceId) so the header is
  // populated from first render instead of showing "(no sandbox)".
  useEffect(() => {
    const name = sandboxName ?? expectedSandboxName;
    const stored = localStorage.getItem(`openrind-shell-display:${name}`);
    setDisplayName(stored ?? name);
  }, [sandboxName, expectedSandboxName]);

  const commitRename = useCallback(() => {
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName) return;
    const trimmed = renameValue.trim();
    const next = trimmed || effectiveName;
    if (trimmed)
      localStorage.setItem(`openrind-shell-display:${effectiveName}`, trimmed);
    else localStorage.removeItem(`openrind-shell-display:${effectiveName}`);
    setDisplayName(next);
    setIsRenaming(false);
    // Clear any stale error so the error card doesn't linger after a rename.
    setErrorMessage(null);
    setPhase((prev) => (prev === "error" ? "exited" : prev));
    // If onRenameCommit is provided (settings TestLaunchPanel), calling it
    // will stop the current session and swap the workspace ID — reset
    // hasEverConnected so the button reads "Launch session" for the new
    // workspace. In the main session view (no prop), the rename is cosmetic
    // only and the button correctly stays "Reconnect" for the same sandbox.
    if (trimmed && props.onRenameCommit) {
      setHasEverConnected(false);
      props.onRenameCommit(trimmed);
    }
  }, [sandboxName, renameValue, props.onRenameCommit]);

  // Mark first successful connection and auto-focus the terminal so the
  // user can type immediately without having to click.
  useEffect(() => {
    if (phase !== "connected") return;
    setHasEverConnected(true);
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubProgress: (() => void) | undefined;

    const writeToTerm = (data: string) => {
      if (termRef.current) {
        termRef.current.write(data);
      } else {
        earlyBufferRef.current.push(data);
      }
    };

    const cleanup = async () => {
      cancelled = true;
      unsubData?.();
      unsubExit?.();
      unsubProgress?.();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (sessionIdRef.current) {
        const id = sessionIdRef.current;
        sessionIdRef.current = null;
        try {
          // Navigation (workspace switch, route change, switch-to-chat) ⇒
          // DETACH: keep the wsl child + output buffer alive in main so the
          // next mount replays the scrollback instantly. Only an explicit
          // end/delete CLOSES (kills) the PTY.
          await invoke(
            explicitEndRef.current ? "openrindPtyClose" : "openrindPtyDetach",
            id,
          );
        } catch {
          // Best-effort.
        }
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      earlyBufferRef.current = [];
    };

    const run = async () => {
      try {
        // If the user deliberately cancelled the previous provisioning attempt
        // for this same workspace, stay in "exited" state and do nothing — the
        // handleLaunch callback will reset userAborted + increment reconnectKey
        // to start a fresh run when the user explicitly clicks "Launch session".
        if (
          userAborted &&
          lastAbortedWorkspaceRef.current === props.workspaceId
        ) {
          setPhase("exited");
          return;
        }

        // Pre-populate the sandbox name ref from the workspace ID so that
        // deleteAndReconnect can delete a broken sandbox even when
        // openrindEnsureSandbox throws before returning (sandbox in error
        // state, stuck-provisioning, etc.) — i.e. before setSandboxName
        // is ever called. Only set if not already known from a prior run.
        if (!lastKnownSandboxNameRef.current) {
          lastKnownSandboxNameRef.current = deriveExpectedSandboxName(
            props.workspaceId,
          );
        }

        // 0. Subscribe to bootstrap progress events BEFORE calling
        // openrindEnsureSandbox so the founder sees the pull / stage /
        // create phases stream in. The session-progress channel is the
        // same one Phase O4's TestLaunchPanel uses.
        const bridge = getBridge();
        // Clear any stale message from a previous run so polling messages
        // ("Sandbox is Provisioning, waiting…") are visible instead of
        // being hidden behind a stale "ready" message.
        setBootstrapMessage(null);
        // Reset per-run so switching between two Openrind Shell workspaces (the
        // component stays mounted, only props change) doesn't carry the prior
        // workspace's bootstrap flag into a lossless re-attach. The fresh
        // branch sets it true again only when there is no live session.
        setIsFreshBootstrap(false);
        unsubProgress = bridge?.openrindShell?.onSessionProgress?.((evt) => {
          if (cancelled) return;
          if (evt.message) setBootstrapMessage(evt.message);
        });

        // 1. Subscribe to PTY events BEFORE opening/attaching the PTY so the
        // initial sandbox-connect output (welcome banner, prompt) and any
        // live bytes that arrive mid-attach aren't lost. Handlers gate on
        // sessionIdRef so they only fire once we own a session.
        unsubData = bridge?.openrindShell?.onPtyData?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            writeToTerm(payload.data);
          }
        });
        unsubExit = bridge?.openrindShell?.onPtyExit?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            // Keep sessionIdRef set: the dead session is retained in the main
            // process (with its buffer) so Reconnect / End session can close
            // it by id, and a re-attach after navigation replays its output.
            writeToTerm(
              `\r\n\x1b[33m[Session ended (exit ${payload.exitCode ?? "?"}). Click Reconnect to start a new session.]\x1b[0m\r\n`,
            );
            setPhase("exited");
          }
        });

        // 2. Mount xterm.js FIRST — both so we have real cols/rows to hand to
        // the PTY and so we have a live terminal to replay buffered scrollback
        // into on a re-attach. The bootstrap overlay (gated on
        // isFreshBootstrap) sits ON TOP of this container via absolute
        // positioning, so mounting underneath first is invisible.
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");
        const { Unicode11Addon } = await import("@xterm/addon-unicode11");
        if (cancelled || !containerRef.current) return;

        // Wait for the browser to complete layout so fit() can measure
        // real pixel dimensions. Two RAFs are the minimum: the first fires
        // before the style-recalc commit, the second fires after it.
        // This prevents cols=1 (vertical text) on first open.
        const waitFrames = (n: number) =>
          new Promise<void>((resolve) => {
            const step = (remaining: number) =>
              remaining <= 0
                ? resolve()
                : requestAnimationFrame(() => step(remaining - 1));
            step(n);
          });
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // If the container still has 0 width after 2 frames (can happen
        // when the parent's height is derived purely from flexbox), keep
        // polling up to ~600 ms before giving up and using defaults.
        // (The absolute-inset-0 wrapper in session-page.tsx should prevent
        // this, but this guard catches any remaining edge cases.)
        let pollAttempts = 0;
        while (
          containerRef.current &&
          containerRef.current.clientWidth === 0 &&
          pollAttempts < 10
        ) {
          await waitFrames(2);
          if (cancelled) return;
          pollAttempts++;
        }
        if (cancelled || !containerRef.current) return;

        // The PTY runs `wsl.exe` through a Windows ConPTY (node-pty). xterm.js
        // needs to know that, or it mis-renders ConPTY's reflowed/padded
        // full-width lines — which showed up as a gibberish first line (Claude
        // Code's welcome-box border). buildNumber comes from the host; 0 on
        // non-Windows so we omit the option there.
        const hostBuild = await invoke<number>("openrindHostBuild").catch(
          () => 0,
        );
        if (cancelled || !containerRef.current) return;

        const term = new Terminal({
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 13,
          cursorBlink: true,
          scrollback: 5_000,
          allowProposedApi: true,
          ...(hostBuild > 0
            ? {
                windowsPty: {
                  backend: "conpty" as const,
                  buildNumber: hostBuild,
                },
              }
            : {}),
          theme: {
            background: "#0a0a0a",
            foreground: "#e6e6e6",
            cursor: "#e6e6e6",
            selectionBackground: "#444",
          },
        });
        const fit = new FitAddon();
        // Load Unicode 11 width tables BEFORE any content is written so emoji /
        // CJK cell widths match what Claude Code's Ink renderer assumes
        // (string-width / wcwidth v11). xterm defaults to Unicode 6, where most
        // modern emoji measure as width 1; that mismatch desyncs the cursor and
        // leaves stray emoji/number glyphs and a garbled banner line at the top.
        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.unicode.activeVersion = "11";
        term.loadAddon(fit);
        term.open(containerRef.current);
        // Initial fit — may give cols=1 if the browser hasn't committed
        // layout for the container yet (timing race on first mount).
        try {
          fit.fit();
        } catch {
          // ignore
        }
        termRef.current = term;
        fitRef.current = fit;

        // Flush any bytes that arrived during mount.
        if (earlyBufferRef.current.length > 0) {
          for (const chunk of earlyBufferRef.current) term.write(chunk);
          earlyBufferRef.current = [];
        }

        // ── Key fix for the cols=1 / vertical-text bug ──────────────────
        // Set up the ResizeObserver NOW, before the PTY is opened.
        // The ResizeObserver fires once on the FIRST frame after observe()
        // regardless of whether the size changed — this gives fit.fit() a
        // second chance to measure with fully-committed CSS dimensions.
        // We then wait two frames so that callback has run and corrected
        // term.cols before we pass it to openrindPtyOpen.
        //
        // Without this, the initial fit() above can race against the browser
        // layout commit and measure 0px → cols=1. Once cols=1 is set,
        // a ResizeObserver firing later calls fit.fit() → still cols=1 (no
        // change) → term.onResize never fires → no SIGWINCH → cols stays 1.
        if (containerRef.current) {
          const ro = new ResizeObserver(() => {
            try {
              fitRef.current?.fit();
            } catch {
              // Container unmounted — ignore.
            }
          });
          ro.observe(containerRef.current);
          resizeObserverRef.current = ro;
        }

        // Wait for the ResizeObserver initial callback to complete.
        // RO fires at the end of each rendering frame (after RAF).
        // Two frames is sufficient: frame N fires RAF → frame N+1 the
        // RO callback runs → fit.fit() corrects cols/rows.
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // Hard fallback: if fit() still reports cols ≤ 2 the container
        // genuinely has 0px CSS width.  Force a sane default so Claude
        // Code TUI at least opens usably; the ResizeObserver will correct
        // the PTY dimensions once the user resizes or the layout settles.
        if (term.cols <= 2) {
          try {
            term.resize(120, term.rows > 2 ? term.rows : 32);
          } catch {
            // ignore
          }
        }

        // Wire terminal input → PTY stdin (every keystroke, incl. arrows)
        // and xterm's own resize → PTY SIGWINCH. Identical for the re-attach
        // and fresh-open paths, so define once and call in each branch.
        const wireTerminalIO = () => {
          term.onData((data) => {
            if (!sessionIdRef.current) return;
            void invoke("openrindPtyWrite", {
              sessionId: sessionIdRef.current,
              data,
            });
          });
          term.onResize(({ cols, rows }) => {
            if (!sessionIdRef.current) return;
            void invoke("openrindPtyResize", {
              sessionId: sessionIdRef.current,
              cols,
              rows,
            });
          });
        };

        // 3. Probe for an already-running PTY for THIS sandbox AND this
        // session. If one exists the renderer simply navigated away earlier
        // (we detached, keeping the wsl child + scrollback alive), so we
        // re-attach losslessly — no re-bootstrap, no agent relaunch. A live
        // PTY for a DIFFERENT session in this sandbox is NOT a match: it means
        // the user switched tasks, so we fall through to a fresh open (which
        // tears the old PTY down — one agent per sandbox at a time).
        const agentSessionId = props.sessionId ?? null;
        let liveSession = false;
        try {
          const sessionsList =
            await invoke<
              Array<{ sandboxName: string; agentSessionId: string | null }>
            >("openrindPtyList");
          liveSession = sessionsList.some(
            (s) =>
              s.sandboxName === expectedSandboxName &&
              (s.agentSessionId ?? null) === agentSessionId,
          );
        } catch {
          liveSession = false;
        }
        if (cancelled) return;

        if (liveSession) {
          // ── Lossless re-attach (two-phase) ─────────────────────────────
          // Phase 1: get session id + buffered scrollback. The main process
          // does NOT call attachHandlers here, so no pty-data events fly yet.
          const attached = await invoke<{
            id: string;
            buffered: string;
            cols?: number;
            rows?: number;
            exited: boolean;
          }>("openrindPtyAttachOrOpen", {
            sandboxName: expectedSandboxName,
            cols: term.cols,
            rows: term.rows,
            sessionId: agentSessionId,
            profile: props.profile,
          });
          if (cancelled) return;
          setSandboxName(expectedSandboxName);
          lastKnownSandboxNameRef.current = expectedSandboxName;
          // Set sessionIdRef BEFORE phase 2 so the onPtyData handler accepts
          // events the moment the main process starts streaming.
          sessionIdRef.current = attached.id;
          // Replay the buffered bytes at the geometry they were RECORDED at.
          // The buffer is a ConPTY frame: absolute cursor moves plus hard
          // wraps at the pty's width. Replaying a 120-col frame into a
          // differently-sized xterm mis-wraps every full-width row and
          // strands garbled fragments above the agent's next repaint — the
          // gibberish line pinned over the banner (reproduced byte-for-byte
          // with a headless-xterm replay harness). So: temporarily match the
          // recorded size, replay, and only then fit to the real pane — the
          // resulting resize makes ConPTY re-emit a clean full frame.
          const recordedCols = attached.cols ?? term.cols;
          const recordedRows = attached.rows ?? term.rows;
          if (attached.buffered) {
            if (term.cols !== recordedCols || term.rows !== recordedRows) {
              try {
                term.resize(recordedCols, recordedRows);
              } catch {
                // ignore — worst case the replay wraps like before
              }
            }
            // Wait for the replay to PARSE before any further resize: xterm
            // parses writes asynchronously, and resizing with the replay
            // still queued would re-wrap it at the new size again.
            await new Promise<void>((resolve) =>
              term.write(attached.buffered, resolve),
            );
          }
          if (cancelled) return;
          if (earlyBufferRef.current.length > 0) {
            for (const chunk of earlyBufferRef.current) term.write(chunk);
            earlyBufferRef.current = [];
          }
          // Phase 2: wire live PTY streaming now that sessionIdRef is set.
          if (!attached.exited) {
            await invoke("openrindPtyAttach", attached.id);
          }
          if (cancelled) return;
          wireTerminalIO();
          // Now fit to the actual container. For a live session the resize
          // reaches the PTY (wireTerminalIO is up) and ConPTY repaints the
          // whole frame at the new size. A dead session stays at its
          // recorded geometry so the corpse replay stays legible.
          if (!attached.exited) {
            try {
              fitRef.current?.fit();
            } catch {
              // ignore
            }
          }
          setHasEverConnected(true);
          setPhase(attached.exited ? "exited" : "connected");
          return;
        }

        // ── Fresh bootstrap ───────────────────────────────────────────────
        // No live session: this is a first open (or a reconnect after the PTY
        // was explicitly closed). Now show the bootstrap overlay, ensure the
        // sandbox is up (idempotent), then open a new PTY.
        setIsFreshBootstrap(true);
        setPhase("ensuring-sandbox");
        const sandbox = await invoke<{ sandboxName: string; existed: boolean }>(
          "openrindEnsureSandbox",
          { workspaceId: props.workspaceId, profile: props.profile },
        );
        if (cancelled) return;
        setSandboxName(sandbox.sandboxName);
        lastKnownSandboxNameRef.current = sandbox.sandboxName;

        // Open the PTY. Pass the current xterm size — now guaranteed to be the
        // result of a ResizeObserver-corrected fit() call.
        setPhase("connecting-pty");
        const pty = await invoke<{ id: string }>("openrindPtyOpen", {
          sandboxName: sandbox.sandboxName,
          cols: term.cols,
          rows: term.rows,
          sessionId: agentSessionId,
          profile: props.profile,
        });
        if (cancelled) {
          await invoke("openrindPtyClose", pty.id).catch(() => {});
          return;
        }
        sessionIdRef.current = pty.id;
        // Flush any bytes that queued between open and this point.
        if (earlyBufferRef.current.length > 0) {
          for (const chunk of earlyBufferRef.current) term.write(chunk);
          earlyBufferRef.current = [];
        }
        wireTerminalIO();
        setPhase("connected");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setPhase("error");
      }
    };

    void run();
    return () => {
      void cleanup();
    };
  }, [
    props.workspaceId,
    props.profile,
    props.sessionId,
    reconnectKey,
    userAborted,
  ]);

  const popOut = useCallback(async () => {
    const name = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!name) return;
    setPopoutBusy(true);
    setPopoutError(null);
    try {
      await invoke("openrindPopOutTerminal", name);
    } catch (err) {
      setPopoutError(err instanceof Error ? err.message : String(err));
    } finally {
      setPopoutBusy(false);
    }
  }, [sandboxName]);

  const deleteSandbox = useCallback(async () => {
    const nameToDelete = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!nameToDelete) return;
    const ok = window.confirm(
      `Delete sandbox "${nameToDelete}"?\n\n` +
        "The Postgres-backed /home/agent will remain, but this sandbox " +
        "instance is gone. Reopening the workspace will create a fresh " +
        "sandbox and restore the home directory from PostgreSQL.",
    );
    if (!ok) return;
    // Kill the local PTY before tearing down the sandbox so we never leave a
    // wsl child pointed at a deleted container. explicitEndRef makes the
    // subsequent unmount a CLOSE (no-op, already closed) rather than a detach.
    explicitEndRef.current = true;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id) {
      await invoke("openrindPtyClose", id).catch(() => {});
    }
    try {
      await invoke("openrindDeleteSandbox", nameToDelete);
      props.onSandboxDeleted?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [sandboxName, props.onSandboxDeleted, props]);

  /** Delete the stuck sandbox silently then immediately reconnect so
   *  openrindEnsureSandbox creates a brand-new one. Used from the
   *  BootstrapErrorCard when the sandbox is stuck in Provisioning. */
  const deleteAndReconnect = useCallback(async () => {
    const nameToDelete = sandboxName ?? lastKnownSandboxNameRef.current;
    if (nameToDelete) {
      try {
        await invoke("openrindDeleteSandbox", nameToDelete);
      } catch {
        // Best-effort — even if delete fails, attempt a reconnect; the
        // "already exists" guard in createOpenrindShellSandbox handles partial state.
      }
    }
    handleLaunch();
  }, [sandboxName, handleLaunch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — styled to match the SessionPage chat header (which is
          hidden while a sandbox terminal is showing) so the surface reads
          as ONE consistent header instead of two stacked ones. */}
      <div className="z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-dls-border bg-dls-surface px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {isRenaming ? (
            <input
              autoFocus
              className="h-7 rounded-md border border-dls-border bg-dls-hover px-2 font-mono text-[13px] text-dls-text outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setIsRenaming(false);
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              className="group flex min-w-0 items-center gap-1.5 text-left"
              title={
                sandboxName
                  ? `Display label (cosmetic only)\nActual sandbox: ${sandboxName}\n\nClick to rename`
                  : "Click to rename display label"
              }
              onClick={() => {
                setRenameValue(displayName);
                setIsRenaming(true);
              }}
            >
              <span className="truncate text-[15px] font-semibold text-dls-text">
                {displayName || sandboxName || expectedSandboxName}
              </span>
              <Pencil
                size={11}
                className="shrink-0 text-dls-secondary opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )}
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
              phase === "connected"
                ? "border-green-7/60 bg-green-3/30 text-green-11"
                : phase === "exited" || phase === "error"
                  ? "border-red-7/50 bg-red-2/30 text-red-11"
                  : "border-amber-7/50 bg-amber-2/30 text-amber-11"
            }`}
          >
            {phaseLabel(phase)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {phase === "connected" ? (
            <TerminalMicButton
              onText={(text) => {
                const id = sessionIdRef.current;
                if (!id) return;
                // Flatten newlines so dictation never accidentally submits the
                // prompt — the user reviews the text and presses Enter.
                const flat = text.replace(/\r?\n/g, " ").trim();
                if (!flat) return;
                void invoke("openrindPtyWrite", { sessionId: id, data: flat });
                try {
                  termRef.current?.focus();
                } catch {
                  /* ignore */
                }
              }}
              onError={(message) => {
                // Surface failures directly in the terminal so they're not
                // lost behind a tooltip.
                try {
                  termRef.current?.write(
                    `\r\n\x1b[31m[voice] ${message}\x1b[0m\r\n`,
                  );
                } catch {
                  /* ignore */
                }
              }}
            />
          ) : null}

          {phase === "exited" || phase === "error" ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={
                errorNeedsDelete
                  ? () => void deleteAndReconnect()
                  : handleLaunch
              }
              onMouseDown={(e) => e.preventDefault()}
              title={
                errorNeedsDelete
                  ? "Delete the broken sandbox and launch a fresh one"
                  : hasEverConnected
                    ? "Reconnect to the sandbox"
                    : "Launch a new session"
              }
            >
              <RotateCcw size={16} />
              <span>
                {errorNeedsDelete
                  ? "Delete & relaunch"
                  : hasEverConnected
                    ? "Reconnect"
                    : "Launch session"}
              </span>
            </button>
          ) : phase !== "connected" ? (
            // During provisioning — show a Cancel button so the user is never
            // stuck at the spinner with no escape.
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={handleAbort}
              onMouseDown={(e) => e.preventDefault()}
              title="Cancel provisioning and return to the launch screen"
            >
              <span>Cancel</span>
            </button>
          ) : null}

          {phase === "connected" && props.onSwitchToChat ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={props.onSwitchToChat}
              onMouseDown={(e) => e.preventDefault()}
              title="Switch to the regular Openrind Desktop chat UI. The session keeps running — switch back to resume it instantly."
            >
              <MessageSquare size={16} />
              <span className="hidden lg:inline">Chat</span>
            </button>
          ) : null}



          {/* Overflow menu for secondary / management actions. onMouseDown
              preventDefault keeps keyboard focus on xterm.js. */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen ? (
              <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-52 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    (!sandboxName && !lastKnownSandboxNameRef.current) ||
                    popoutBusy
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    void popOut();
                  }}
                >
                  {popoutBusy ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <ExternalLink size={15} />
                  )}
                  Open in OS terminal
                </button>
                {props.onOpenSettings ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onOpenSettings?.("sandbox");
                    }}
                  >
                    <Settings size={15} />
                    Sandbox settings
                  </button>
                ) : null}
                <div className="my-1 h-px bg-dls-border" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!sandboxName && !lastKnownSandboxNameRef.current}
                  onClick={() => {
                    setMenuOpen(false);
                    void deleteSandbox();
                  }}
                >
                  <Trash2 size={15} />
                  Delete sandbox
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {popoutError ? (
        <div className="border-b border-red-7/40 bg-red-2/20 px-4 py-2 text-xs text-red-12">
          Pop out failed: {popoutError}
        </div>
      ) : null}
      {/* The terminal container is always in the DOM with real CSS dimensions
          so xterm.js fit() measures correctly on first paint (avoids cols=1
          vertical-text bug). Loading / error overlays sit on top via absolute
          positioning rather than hiding the container with display:none. */}
      <div className="relative flex-1 min-h-0">
        {/* Terminal container: always focused when the cursor is over it.
            focus-on-hover means the user doesn't need to click after
            interacting with toolbar buttons — moving the mouse back over
            the terminal instantly restores keystroke capture so Claude
            Code's TUI (theme selectors, menus, etc.) responds correctly.
            onClick is a fallback for touch/keyboard navigation.

            The padded wrapper (matching the xterm theme background) keeps
            the TUI's bottom-anchored input row from sitting flush against
            the app chrome below the pane. FitAddon measures containerRef
            (the inner h-full div), so the proposed rows already account
            for the padding — the last row is never clipped. */}
        <div
          className="absolute inset-0 bg-[#0a0a0a] px-2 pb-2 pt-1"
          onMouseEnter={() => {
            try {
              termRef.current?.focus();
            } catch {
              /* ignore */
            }
          }}
          onClick={() => {
            try {
              termRef.current?.focus();
            } catch {
              /* ignore */
            }
          }}
        >
          <div ref={containerRef} className="h-full w-full" />
        </div>
        {errorMessage && phase === "error" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dls-surface p-6">
            <BootstrapErrorCard
              message={errorMessage}
              profile={props.profile}
              onRetry={reconnect}
              onDeleteAndReconnect={deleteAndReconnect}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        ) : isFreshBootstrap &&
          phase !== "connected" &&
          phase !== "exited" &&
          phase !== "error" ? (
          // Only show the 3-step bootstrap overlay during a FIRST-TIME launch.
          // A lossless re-attach (isFreshBootstrap === false) skips it so
          // returning to a workspace is instant with no spinner flash.
          // "error" without an errorMessage (cleared by commitRename) falls
          // through here — don't show the spinner, just show the terminal.
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dls-surface p-6">
            <BootstrapProgress
              phase={phase}
              bootstrapMessage={bootstrapMessage}
              existed={false}
              onAbort={handleAbort}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Microphone button for the terminal toolbar. Records speech, transcribes it
 * on-device (Whisper, via the shared useVoiceInput hook), and hands the text
 * to onText — which the terminal writes into the PTY so it lands in Claude
 * Code's input box. Renders nothing when the runtime can't record/transcribe.
 */
function TerminalMicButton(props: {
  onText: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const { status, error, modelProgress, modelReady, start, stop } =
    useVoiceInput(props.onText, props.onError);
  if (status === "unsupported") return null;

  const recording = status === "recording";
  const transcribing = status === "transcribing";
  // First-run only: the model is still downloading/loading. Subsequent runs
  // have modelReady === true and just show a brief spinner.
  const loadingModel = transcribing && !modelReady;
  const pct = modelProgress != null ? Math.round(modelProgress * 100) : null;

  let title = "Dictate into the terminal (on-device voice)";
  if (recording) title = "Stop recording";
  else if (loadingModel)
    title =
      pct != null
        ? `Downloading speech model… ${pct}%`
        : "Loading speech model…";
  else if (transcribing) title = "Transcribing…";
  else if (status === "error" && error) title = `${error} — click to try again`;

  return (
    <div className="flex items-center gap-1.5">
      {loadingModel ? (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-amber-11">
          {pct != null
            ? `Downloading speech model… ${pct}%`
            : "Loading speech model…"}
        </span>
      ) : null}
      <button
        type="button"
        className={`flex items-center justify-center rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          recording
            ? "bg-red-3 text-red-11 hover:bg-red-4"
            : "text-gray-10 hover:bg-gray-2/70 hover:text-dls-text"
        }`}
        onClick={() => {
          if (props.disabled || transcribing) return;
          if (recording) stop();
          else start();
        }}
        onMouseDown={(e) => e.preventDefault()}
        disabled={props.disabled || transcribing}
        title={title}
        aria-label={title}
        aria-pressed={recording}
      >
        {transcribing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : recording ? (
          <Square size={13} fill="currentColor" className="animate-pulse" />
        ) : (
          <Mic size={16} />
        )}
      </button>
      <VoiceEngineMenu direction="down" align="right" />
    </div>
  );
}

type BootstrapProgressProps = {
  phase: Phase;
  bootstrapMessage: string | null;
  existed: boolean;
  /** When provided, renders a "Cancel provisioning" link inside the card.
   *  Calling it sets userAborted=true so run() exits immediately, and the
   *  user can re-launch manually via the toolbar "Launch session" button. */
  onAbort?: () => void;
};

function BootstrapProgress(props: BootstrapProgressProps) {
  const steps: Array<{ id: Phase; label: string }> = [
    { id: "ensuring-sandbox", label: "Pulling image + creating sandbox" },
    { id: "mounting-terminal", label: "Mounting terminal" },
    { id: "connecting-pty", label: "Opening PTY" },
  ];
  const phaseOrder: Phase[] = [
    "starting",
    "ensuring-sandbox",
    "mounting-terminal",
    "connecting-pty",
    "connected",
  ];
  const currentIdx = phaseOrder.indexOf(props.phase);
  return (
    <div className="w-full max-w-lg space-y-4 rounded-2xl border border-dls-border bg-dls-surface p-6">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="animate-spin text-gray-10" />
        <div className="text-sm font-medium text-gray-12">
          Starting Openrind Shell session
        </div>
      </div>
      <div className="space-y-2">
        {steps.map((step) => {
          const stepIdx = phaseOrder.indexOf(step.id);
          const state =
            stepIdx < currentIdx
              ? "done"
              : stepIdx === currentIdx
                ? "active"
                : "pending";
          return (
            <div key={step.id} className="flex items-center gap-3 text-xs">
              <div
                className={`h-2 w-2 rounded-full ${
                  state === "done"
                    ? "bg-green-9"
                    : state === "active"
                      ? "bg-amber-9 animate-pulse"
                      : "bg-gray-6"
                }`}
              />
              <span
                className={state === "pending" ? "text-gray-8" : "text-gray-11"}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
      {props.bootstrapMessage ? (
        <div className="rounded-xl border border-dls-border bg-gray-1/40 p-3 font-mono text-[11px] text-gray-10">
          {props.bootstrapMessage}
        </div>
      ) : null}
      {props.onAbort ? (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            className="text-xs text-gray-8 hover:text-gray-11 transition-colors underline-offset-2 hover:underline"
            onClick={props.onAbort}
          >
            Cancel provisioning
          </button>
        </div>
      ) : null}
    </div>
  );
}

type BootstrapErrorCardProps = {
  message: string;
  profile: SandboxProfile;
  onRetry: () => void;
  onDeleteAndReconnect?: () => void;
  onOpenSettings?: (target: "environment" | "sandbox") => void;
};

function BootstrapErrorCard(props: BootstrapErrorCardProps) {
  // Detect actionable errors so the founder sees a clear next step
  // instead of a raw stderr dump.
  //
  // NOTE: Electron IPC wraps thrown errors with the prefix
  // "Error invoking remote method 'openrind-desktop:desktop': Error: " before the
  // original message reaches the renderer. All pattern matches therefore
  // use regex /test/ rather than String.startsWith so they work regardless
  // of this wrapping.
  const stuckProvisioning = /STUCK_PROVISIONING:/i.test(props.message);
  // Sandbox reached the "error" phase (Docker container failed to start,
  // setup.sh crashed, etc.). The sandbox must be deleted and recreated.
  const sandboxErrorState = /is in error state/i.test(props.message);
  const missingDatabase = /DATABASE_URL is not configured/i.test(props.message);
  // Backend throws "ANTHROPIC_API_KEY is not configured" (not "is required")
  const missingApiKey = /ANTHROPIC_API_KEY is not configured/i.test(
    props.message,
  );
  const openshellUnready = /OpenShell is not ready/i.test(props.message);
  const gatewayUnresponsive =
    /gateway is not responding|sandbox list timed out/i.test(props.message);
  const credentialIssue = missingDatabase || missingApiKey;
  const needsDeleteAndRecreate = stuckProvisioning || sandboxErrorState;

  let title = "Could not start Openrind Shell session.";
  let detail = props.message;
  if (stuckProvisioning) {
    title = "Sandbox is stuck in Provisioning.";
    detail =
      "The sandbox has been provisioning for over 90 seconds and hasn't become ready. " +
      "This usually means the OpenShell gateway lost track of the container. " +
      'Click "Delete & start fresh" to remove the stuck sandbox and create a new one.';
  } else if (sandboxErrorState) {
    title = "Sandbox is in an error state.";
    detail =
      "The sandbox container failed to start or encountered a fatal error during setup. " +
      'Click "Delete & start fresh" to delete the broken sandbox and create a new one.';
  } else if (missingDatabase) {
    title = "DATABASE_URL is not configured.";
    detail =
      "Openrind Shell stores workspace state in PostgreSQL. Open Settings → Environment → " +
      "Sandbox credentials and paste your connection string.";
  } else if (missingApiKey) {
    title = "ANTHROPIC_API_KEY is not configured.";
    detail =
      "Openrind Shell needs an Anthropic API key to auto-provision the Claude provider. " +
      "Open Settings → Environment → Sandbox credentials and paste your Anthropic API key.";
  } else if (gatewayUnresponsive) {
    title = "OpenShell gateway is not responding.";
    detail =
      "The openshell CLI couldn't reach its gateway. Open Settings → Sandbox → " +
      "OpenShell health and click Restart Gateway, then try again.";
  } else if (openshellUnready) {
    title = "OpenShell stack isn't ready.";
    detail =
      "Open Settings → Sandbox and run the installer / Doctor — the WSL distro, " +
      "Docker, OpenShell CLI, or gateway is missing or unhealthy.";
  }

  return (
    <div className="max-w-lg space-y-4 rounded-2xl border border-red-7/40 bg-red-2/20 p-5">
      <div className="flex items-center gap-2 text-red-12">
        <AlertTriangle size={16} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="text-sm text-gray-11">{detail}</div>
      {!credentialIssue && !needsDeleteAndRecreate ? (
        <div className="font-mono text-xs text-red-12 break-words">
          {props.message}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {needsDeleteAndRecreate && props.onDeleteAndReconnect ? (
          <Button variant="primary" onClick={props.onDeleteAndReconnect}>
            <RotateCcw size={14} className="mr-1.5" />
            Delete &amp; start fresh
          </Button>
        ) : null}
        {credentialIssue && props.onOpenSettings ? (
          <Button
            variant="primary"
            onClick={() => props.onOpenSettings?.("environment")}
          >
            <Settings size={14} className="mr-1.5" />
            Open Settings → Environment
          </Button>
        ) : null}
        {(openshellUnready || gatewayUnresponsive) && props.onOpenSettings ? (
          <Button
            variant="primary"
            onClick={() => props.onOpenSettings?.("sandbox")}
          >
            <Settings size={14} className="mr-1.5" />
            Open Settings → Sandbox
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "starting":
      return "Starting...";
    case "ensuring-sandbox":
      return "Preparing sandbox (pull + create)...";
    case "mounting-terminal":
      return "Mounting terminal...";
    case "connecting-pty":
      return "Opening PTY...";
    case "connected":
      return "Connected";
    case "exited":
      return "Disconnected";
    case "error":
      return "Error";
    default:
      return phase;
  }
}
