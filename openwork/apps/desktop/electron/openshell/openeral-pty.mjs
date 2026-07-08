// PTY bridge for OpenEral sessions. Spawns the platform-correct
// `openshell sandbox connect <name>` command inside a real pseudo-
// terminal (node-pty) so Claude Code and OpenClaw — which both refuse
// to launch without a TTY — get a working stdin/stdout/resize channel.
//
// The bytes flow:
//
//   renderer xterm.js ──IPC── main process ──node-pty.write── wsl.exe ──
//     openshell sandbox connect <name> ── docker exec ── Claude Code TUI
//
//   …and back the other way.
//
// One module-level `sessions` Map tracks every open PTY by a fresh
// session id (UUID). The renderer holds the id; main owns the IPty
// handle. Closing the renderer-side terminal calls back here to clean
// up the IPty (kill the wsl child) without removing the sandbox itself
// — that's OpenEral's persistence story.
//
// node-pty is lazy-loaded inside spawnSession() so this module can be
// imported under `node --test` (the test suite stubs out spawnSession
// via __testing.installSpawnImpl).

import { randomUUID } from "node:crypto";

import { DISTRO_NAME } from "./wsl.mjs";

// Each live session keeps a bounded ring-buffer of the raw bytes the PTY
// has emitted. When the renderer unmounts on navigation we DETACH (keep
// the wsl child + buffer alive) instead of killing it; when the user
// returns we re-attach and replay this buffer into a fresh xterm so the
// terminal comes back instantly with its scrollback intact — the same
// "switch away and back is lossless" behaviour as the chat sessions.
//
// Buffer is stored as raw bytes (not strings) so the cap is an exact byte
// count and a future on-disk persistence layer is trivial. Decode happens
// once, on the merged byte array, in getBuffer().
const BUFFER_CAP_BYTES = 768 * 1024; // ~768 KB of replayable scrollback
const bufferEncoder = new TextEncoder();

/**
 * Append PTY output to a session's ring-buffer, evicting the oldest chunks
 * once the byte cap is exceeded. Never empties the buffer mid-stream (keeps
 * at least the most recent chunk even if a single chunk exceeds the cap).
 *
 * @param {Session} session
 * @param {string | Uint8Array} data
 */
function appendToBuffer(session, data) {
  const bytes = typeof data === "string" ? bufferEncoder.encode(data) : data;
  session.buffer.push(bytes);
  session.bufferBytes += bytes.length;
  while (session.bufferBytes > BUFFER_CAP_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift();
    session.bufferBytes -= dropped.length;
  }
}

/** @typedef {(data: string | Uint8Array) => void} DataHandler */
/** @typedef {(exitCode: number | null, signal?: string | null) => void} ExitHandler */

/**
 * @typedef {Object} IPtyLike
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {(handler: DataHandler) => { dispose: () => void }} onData
 * @property {(handler: (event: { exitCode: number; signal?: number | undefined }) => void) => { dispose: () => void }} onExit
 * @property {number | undefined} pid
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} sandboxName
 * @property {IPtyLike} pty
 * @property {DataHandler | null} onData
 * @property {ExitHandler | null} onExit
 * @property {{ cols: number; rows: number }} size
 * @property {number} openedAt
 * @property {Uint8Array[]} buffer        Replayable output chunks (raw bytes)
 * @property {number} bufferBytes         Running byte total of `buffer`
 * @property {boolean} detached           True while no renderer is attached
 * @property {{ exitCode: number | null; signal: string | null } | null} exitInfo
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * Default spawn implementation: lazy-loads node-pty and spawns wsl.exe
 * with the openshell sandbox connect command. Overridable via
 * __testing.installSpawnImpl for the unit suite.
 *
 * @param {{ sandboxName: string; cols: number; rows: number }} opts
 * @returns {Promise<IPtyLike>}
 */

/**
 * Build a WSL-forwarded env object. Any keys in `extra` are added to
 * the Electron process.env AND appended to WSLENV so wsl.exe passes
 * them through to the distro (and from there into the sandbox container
 * via openshell's exec). Without WSLENV, Windows env vars are stripped
 * by wsl.exe before the linux process sees them.
 *
 * @param {Record<string, string>} extra
 * @returns {Record<string, string>}
 */
function buildWslEnv(extra) {
  const names = Object.keys(extra).filter((k) => extra[k]);
  if (names.length === 0) return process.env;
  const existing = process.env.WSLENV ? process.env.WSLENV.split(":") : [];
  const merged = Array.from(new Set([...existing, ...names]));
  return {
    ...process.env,
    ...Object.fromEntries(names.map((k) => [k, extra[k]])),
    WSLENV: merged.join(":"),
  };
}

let spawnImpl = async ({ sandboxName, cols, rows, extraEnv }) => {
  const pty = await import("node-pty");
  const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;
  // Two-layer stty strategy:
  //
  // Layer 1 (WSL PTY): `stty cols X rows Y -icanon -echo min 1 time 0`
  // on the WSL bash PTY BEFORE `openshell sandbox exec` runs.
  //
  //   • Dimension flags (cols/rows): ensure the PTY reports the correct
  //     TIOCGWINSZ. Fixes the racy ConPTY → WSL2 dimension propagation
  //     that can leave the linux-PTY at cols=1 at connection time.
  //
  //   • Raw-mode flags (-icanon -echo min 1 time 0): `openshell sandbox
  //     connect` relays stdin bidirectionally over its SSH tunnel. For
  //     each keystroke to arrive individually (not line-buffered) and to
  //     avoid echo artifacts, the outer WSL PTY must be in raw mode
  //     before connect starts. Setting -icanon removes line-buffering so
  //     every keypress is sent immediately. -echo is OFF so xterm.js
  //     initialization escape sequences (resize, capability queries,
  //     focus-tracking requests) are not echoed back by the outer PTY
  //     and re-processed by xterm.js as terminal commands (which would
  //     produce junk characters and corrupt the TUI rendering).
  //
  // Layer 2: `openshell sandbox connect` starts the container's configured
  // entrypoint (openeral → Claude Code) and relays stdin bidirectionally
  // over its SSH/gRPC tunnel. This is the correct command for interactive
  // sessions — `sandbox exec` only relays stdout/stderr and ignores the
  // outer process's stdin, which is why pressing keys had no effect.
  // `connect` reads TIOCGWINSZ from the outer WSL PTY (already set to
  // cols/rows above) to size the container PTY correctly.
  const shellCmd =
    `stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; ` +
    `exec openshell sandbox connect ${quotedName}`;
  return pty.spawn(
    "wsl.exe",
    ["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd],
    {
      name: "xterm-256color",
      cols,
      rows,
      // Forward credentials (ANTHROPIC_API_KEY, STRINGCOST_API_KEY, etc.)
      // via WSLENV so the `openeral` entrypoint inside the sandbox can
      // auto-configure Claude Code on first run without prompting the user.
      env: extraEnv ? buildWslEnv(extraEnv) : process.env,
      // CWD doesn't really matter for wsl.exe, but cleanup-safe default.
      cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
    },
  );
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

// Terminal dimensions end up interpolated into an `stty cols X rows Y`
// command line, so clamp to a positive integer (or the fallback) in every
// path that accepts renderer-supplied sizes.
function clampDimension(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Open a new PTY session against an existing OpenEral sandbox.
 *
 * @param {Object} opts
 * @param {string} opts.sandboxName
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {Record<string, string>} [opts.extraEnv]  Extra env vars forwarded
 *   into WSL via WSLENV (e.g. ANTHROPIC_API_KEY, STRINGCOST_API_KEY). These
 *   are needed so Claude Code can auto-configure its provider on first run
 *   inside the sandbox without prompting the user interactively.
 * @param {DataHandler} [opts.onData]   Receives PTY stdout/stderr bytes
 * @param {ExitHandler} [opts.onExit]   Called when the wsl child exits
 * @returns {Promise<{ id: string, sandboxName: string, reused: boolean }>}
 */
export async function openSession(opts) {
  if (!opts?.sandboxName) {
    throw new Error("openSession: sandboxName is required");
  }
  const cols = clampDimension(opts.cols, DEFAULT_COLS);
  const rows = clampDimension(opts.rows, DEFAULT_ROWS);
  const extraEnv = opts.extraEnv ?? null;

  // Adoption / idempotency: if a still-live session already owns this
  // sandbox, re-attach to it instead of spawning a second wsl child. This
  // makes openSession safe to call from any path (legacy openeralPtyOpen,
  // a racy double-mount) without ever leaking a duplicate PTY against the
  // same sandbox.
  const existing = findSessionBySandbox(opts.sandboxName);
  if (existing) {
    if (!existing.exitInfo) {
      // Still live → adopt it; never spawn a second wsl child for one sandbox.
      attachHandlers(existing.id, { onData: opts.onData, onExit: opts.onExit });
      resizeSession(existing.id, cols, rows);
      return { id: existing.id, sandboxName: existing.sandboxName, reused: true };
    }
    // Dead (exited) session for this sandbox is lingering for replay — a fresh
    // openSession means the user is reconnecting, so forget it and spawn anew.
    // This guarantees at most one session per sandbox after openSession.
    closeSession(existing.id);
  }

  const pty = await spawnImpl({ sandboxName: opts.sandboxName, cols, rows, extraEnv });
  const id = randomUUID();

  /** @type {Session} */
  const session = {
    id,
    sandboxName: opts.sandboxName,
    pty,
    onData: opts.onData ?? null,
    onExit: opts.onExit ?? null,
    size: { cols, rows },
    openedAt: Date.now(),
    buffer: [],
    bufferBytes: 0,
    detached: false,
    exitInfo: null,
  };

  // Wire data → buffer (always, even while detached) → caller (only when a
  // renderer is attached). node-pty's onData fires for both stdout and
  // stderr — there's no TTY-side distinction, which is exactly what
  // xterm.js expects.
  pty.onData((data) => {
    appendToBuffer(session, data);
    session.onData?.(data);
  });

  pty.onExit((event) => {
    const code = typeof event?.exitCode === "number" ? event.exitCode : null;
    const signal =
      typeof event?.signal === "number" ? String(event.signal) : event?.signal ?? null;
    // Retain the session (do NOT delete from the map) so a renderer that
    // re-attaches AFTER the wsl child died can still replay the final
    // output plus this notice and offer "Reconnect". The map entry is
    // removed only by an explicit closeSession()/closeAllSessions().
    session.exitInfo = { exitCode: code, signal };
    appendToBuffer(
      session,
      `\r\n\x1b[33m[Session ended (exit ${code ?? "?"}).]\x1b[0m\r\n`,
    );
    session.onExit?.(code, signal);
  });

  sessions.set(id, session);
  return { id, sandboxName: opts.sandboxName, reused: false };
}

/**
 * Write bytes from the renderer's xterm to the PTY's stdin. Returns
 * `false` if the session is unknown (caller can decide whether to
 * surface that or swallow it — keystrokes after close are noise).
 */
export function writeSession(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  // The wsl child has exited but the session is retained for replay — no
  // stdin to write to. Swallow rather than throw on a dead pty.
  if (session.exitInfo) return false;
  session.pty.write(typeof data === "string" ? data : String(data));
  return true;
}

/**
 * Forward an xterm.js resize. Returns `false` if the session is gone.
 * No-op (returns true) if the size hasn't changed — saves the SIGWINCH
 * cost on every renderer re-paint.
 */
export function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.exitInfo) return false;
  const safeCols = clampDimension(cols, session.size.cols);
  const safeRows = clampDimension(rows, session.size.rows);
  if (safeCols === session.size.cols && safeRows === session.size.rows) {
    return true;
  }
  session.pty.resize(safeCols, safeRows);
  session.size = { cols: safeCols, rows: safeRows };
  return true;
}

/**
 * Kill the PTY's wsl child and remove the session from the map. This is
 * the authoritative deleter — `onExit` only marks a session dead (so it
 * can be replayed); `closeSession` is what actually forgets it. Use this
 * for an explicit "end session" / "delete sandbox", NOT for navigation
 * (navigation should detachSession() to keep the buffer alive). The
 * OpenEral sandbox itself persists — that's the whole point of OpenEral's
 * PostgreSQL-backed /home/agent.
 */
export function closeSession(id, signal = "SIGTERM") {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.exitInfo) {
    // Already exited — safe to delete unconditionally.
    sessions.delete(id);
    return true;
  }
  try {
    session.pty.kill(signal);
  } catch {
    // kill() threw unexpectedly — PTY may still be running; don't delete so
    // the caller can retry (e.g. with SIGKILL) or the session stays trackable.
    return false;
  }
  sessions.delete(id);
  return true;
}

/**
 * Find a live-or-dead session by its sandbox name. Used to re-attach a
 * re-mounted renderer to an already-running PTY instead of spawning a new
 * one. Returns the first match, or null.
 *
 * @param {string} sandboxName
 * @returns {Session | null}
 */
export function findSessionBySandbox(sandboxName) {
  if (!sandboxName) return null;
  for (const session of sessions.values()) {
    if (session.sandboxName === sandboxName) return session;
  }
  return null;
}

/**
 * Return the session's replayable scrollback as a string. The byte chunks
 * are concatenated and decoded ONCE so a multibyte UTF-8 sequence split
 * across a cap-driven eviction boundary doesn't produce replacement
 * characters. Empty string for an unknown session.
 *
 * @param {string} id
 * @returns {string}
 */
export function getBuffer(id) {
  const session = sessions.get(id);
  if (!session) return "";
  const merged = new Uint8Array(session.bufferBytes);
  let offset = 0;
  for (const chunk of session.buffer) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Detach the renderer from a live session WITHOUT killing the wsl child.
 * The module-level pty.onData keeps appending to the buffer while detached
 * so scrollback accrued during navigation is replayed on the next attach.
 * Returns `false` for an unknown session.
 *
 * @param {string} id
 */
export function detachSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.onData = null;
  session.onExit = null;
  session.detached = true;
  return true;
}

/**
 * Renderer-safe view of every live session. Used by the workspace tab
 * UI to show "session active" badges and by the doctor to count open
 * sessions per sandbox.
 */
export function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    sandboxName: s.sandboxName,
    cols: s.size.cols,
    rows: s.size.rows,
    openedAt: s.openedAt,
    pid: s.pty.pid ?? null,
  }));
}

/**
 * Replace data/exit handlers for a live session. Used when the renderer
 * remounts (e.g., user toggles between session tabs) so the new
 * component picks up the existing PTY without spawning a new one.
 *
 * @param {string} id
 * @param {{ onData?: DataHandler | null, onExit?: ExitHandler | null }} [handlers]
 */
export function attachHandlers(id, handlers = {}) {
  const { onData, onExit } = handlers;
  const session = sessions.get(id);
  if (!session) return false;
  if (onData !== undefined) session.onData = onData ?? null;
  if (onExit !== undefined) session.onExit = onExit ?? null;
  // A renderer is now (re)attached — clear the detached flag so the
  // buffer-append path knows there's a live consumer again.
  if (session.onData || session.onExit) session.detached = false;
  return true;
}

/** Tear down every session. Called on app quit / runtime shutdown. */
export function closeAllSessions() {
  for (const id of Array.from(sessions.keys())) {
    closeSession(id);
  }
}

export const __testing = {
  /**
   * Replace the node-pty spawn with a stub. The stub receives the same
   * options openSession would pass and must return an IPty-like object.
   * Use clearSpawnImpl() to restore the default.
   */
  installSpawnImpl(fn) {
    spawnImpl = fn;
  },
  clearSpawnImpl() {
    spawnImpl = async ({ sandboxName, cols, rows, extraEnv }) => {
      const pty = await import("node-pty");
      const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;
      const shellCmd =
        `stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; ` +
        `exec openshell sandbox connect ${quotedName}`;
      return pty.spawn(
        "wsl.exe",
        ["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd],
        {
          name: "xterm-256color",
          cols,
          rows,
          env: extraEnv ? buildWslEnv(extraEnv) : process.env,
          cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
        },
      );
    };
  },
  getSessionCount() {
    return sessions.size;
  },
  /** Raw session object for buffer / detached / exitInfo assertions. */
  getSession(id) {
    return sessions.get(id) ?? null;
  },
  resetAll() {
    closeAllSessions();
    sessions.clear();
  },
};
