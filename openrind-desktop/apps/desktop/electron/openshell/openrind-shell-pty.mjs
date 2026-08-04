// PTY bridge for Openrind Shell sessions. Connects to a sandbox with
// `openshell sandbox connect <name>` so Claude Code and OpenClaw — which both
// refuse to launch without a TTY — get a working stdin/stdout/resize channel.
//
// IMPORTANT: we deliberately do NOT use node-pty here. On Windows, node-pty
// runs wsl.exe through the ConPTY (Windows Pseudoconsole), which keeps its own
// screen model and re-serializes it — mangling full-screen TUIs (stranded
// reflow frames = the "gibberish line" over the banner, a too-narrow welcome
// box, a mis-placed composer). Nothing on the xterm.js side can un-corrupt
// bytes ConPTY already mangled.
//
// So the byte path has no ConPTY at all:
//
//   renderer xterm.js ──IPC── main ──pipe(child_process)── wsl.exe ──
//     openshell sandbox connect <name> ── openrind-pty-bridge.py ── agent TUI
//
// The bridge (openrind-pty-bridge.py, shipped in the sandbox image) owns the
// ONLY PTY the agent renders to, so the agent draws exactly as in a native
// Linux terminal and every byte reaches xterm untouched. Since a pipe carries
// no TTY resize, keystrokes and resizes are muxed to the bridge as
// length-prefixed control frames (see encodeDataFrame / encodeResizeFrame);
// the bridge streams the raw agent output back on its stdout.
//
// One module-level `sessions` Map tracks every open PTY by a fresh
// session id (UUID). The renderer holds the id; main owns the IPty
// handle. Closing the renderer-side terminal calls back here to clean
// up the IPty (kill the wsl child) without removing the sandbox itself
// — that's Openrind Shell's persistence story.
//
// The transport is built from wslSpawn() (plain child_process pipes), so this
// module imports cleanly under `node --test`; the suite still stubs the spawn
// via __testing.installSpawnImpl to avoid needing a real wsl.exe.

import { randomUUID } from "node:crypto";

import { DISTRO_NAME, wslSpawn } from "./wsl.mjs";

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
 * `bufferTimes` is kept strictly parallel to `buffer` (same length, same
 * order): it records the ms-since-openedAt each chunk arrived so the raw
 * stream can be exported as a real asciinema recording with faithful timing
 * (see getBufferRecording). Push and shift must always move in lockstep.
 *
 * @param {Session} session
 * @param {string | Uint8Array} data
 */
function appendToBuffer(session, data) {
  const bytes = typeof data === "string" ? bufferEncoder.encode(data) : data;
  session.buffer.push(bytes);
  session.bufferTimes.push(Date.now() - session.openedAt);
  session.bufferBytes += bytes.length;
  while (session.bufferBytes > BUFFER_CAP_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift();
    session.bufferTimes.shift();
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
 * @property {(() => void)} [pause]   Stop draining the transport (backpressure)
 * @property {(() => void)} [resume]  Resume draining the transport
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} sandboxName
 * @property {string | null} agentSessionId  Openrind Desktop session id this PTY runs
 *   the agent conversation for. null when no specific session was requested
 *   (legacy / "main" behavior). Used to key the registry so switching
 *   sessions in one sandbox tears down the previous PTY (one agent at a time).
 * @property {IPtyLike} pty
 * @property {DataHandler | null} onData
 * @property {ExitHandler | null} onExit
 * @property {{ cols: number; rows: number }} size
 * @property {number} openedAt
 * @property {Uint8Array[]} buffer        Replayable output chunks (raw bytes)
 * @property {number[]} bufferTimes       ms-since-openedAt per `buffer` chunk
 * @property {number} bufferBytes         Running byte total of `buffer`
 * @property {boolean} detached           True while no renderer is attached
 * @property {boolean} paused             True while the renderer has applied
 *   backpressure (see pauseSession). Tracked so detach/attach can never leave
 *   a session paused with nobody left to resume it.
 * @property {{ exitCode: number | null; signal: string | null } | null} exitInfo
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

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

// ── Control-frame protocol (main ⇄ openrind-pty-bridge.py) ──────────────────
//
// `openshell sandbox connect` cannot carry env/args into the container, and the
// "pop out to an OS terminal" launcher runs the SAME connect command, so the
// bridge can't be told its mode via env. Instead we announce ourselves in-band:
// the FIRST bytes we send are a handshake the bridge recognises. An external
// terminal never sends it, so the bridge falls back to a transparent raw
// passthrough for the pop-out path.
//
//   handshake := \x00\x00\x00\x00 "OPENRINDPTY1 <cols> <rows>\n"
//   frame     := u8 type, u32 big-endian length, <length> bytes payload
//     type 0x00 DATA   — payload is raw stdin bytes for the agent PTY
//     type 0x01 RESIZE — payload is u16be cols, u16be rows
//
// Only the desktop→bridge direction is framed (it multiplexes keystrokes and
// resizes over one pipe). The bridge→desktop direction is the raw agent byte
// stream with no framing.
const FRAME_DATA = 0x00;
const FRAME_RESIZE = 0x01;
// 4 NULs a terminal never sends first, then a version tag. Only bytes that are
// safe on a still-cooked tty (no 0x03/0x1c) so it can't trip ISIG before the
// bridge switches to raw mode.
const HANDSHAKE_MAGIC = Buffer.from([0, 0, 0, 0, ...Buffer.from("OPENRINDPTY1", "ascii")]);

function encodeHandshake(cols, rows) {
  const safeCols = Math.max(1, Math.min(65535, Math.floor(cols) || 80));
  const safeRows = Math.max(1, Math.min(65535, Math.floor(rows) || 24));
  return Buffer.concat([
    HANDSHAKE_MAGIC,
    Buffer.from(` ${safeCols} ${safeRows}\n`, "ascii"),
  ]);
}

function encodeDataFrame(data) {
  const payload = Buffer.isBuffer(data)
    ? data
    : Buffer.from(typeof data === "string" ? data : String(data), "utf8");
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = FRAME_DATA;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function encodeResizeFrame(cols, rows) {
  const safeCols = Math.max(1, Math.min(65535, Math.floor(cols) || 1));
  const safeRows = Math.max(1, Math.min(65535, Math.floor(rows) || 1));
  const frame = Buffer.allocUnsafe(9);
  frame[0] = FRAME_RESIZE;
  frame.writeUInt32BE(4, 1);
  frame.writeUInt16BE(safeCols, 5);
  frame.writeUInt16BE(safeRows, 7);
  return frame;
}

/**
 * Wrap a piped wsl.exe child in the IPtyLike interface the rest of this module
 * consumes. Output (bridge stdout) is decoded as UTF-8 with a STREAMING decoder
 * so a multi-byte glyph split across two chunks isn't corrupted — matching the
 * string contract node-pty used to provide.
 *
 * The handshake is sent immediately (it is safe on a still-cooked tty). Control
 * FRAMES, however, are buffered until the first output byte proves the bridge
 * has switched its stdio into raw mode, so a frame's length/payload byte (e.g.
 * 0x03) can't trip the container PTY's line discipline and raise SIGINT.
 *
 * pause()/resume() map onto the child's stdout flow state, which is real
 * end-to-end backpressure: an unread pipe stops being drained, wsl.exe stops
 * reading, and the agent's own write() into the container PTY eventually
 * blocks. That is what keeps a flooding TUI from outrunning xterm's parser
 * instead of letting the queue grow without bound.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} cols  initial columns (announced in the handshake)
 * @param {number} rows  initial rows
 * @returns {IPtyLike}
 */
function makePipePty(child, cols, rows) {
  const decoder = new TextDecoder("utf-8");
  // Announce framed mode + initial size before anything else. Safe pre-raw.
  try {
    child.stdin.write(encodeHandshake(cols, rows));
  } catch {
    /* stdin already closed */
  }
  /** @type {Set<DataHandler>} */
  const dataHandlers = new Set();
  /** @type {Set<(event: { exitCode: number|null, signal?: string }) => void>} */
  const exitHandlers = new Set();
  /** @type {Buffer[]} */
  const pending = [];
  let ready = false;
  let exited = false;

  const flushPending = () => {
    if (ready) return;
    ready = true;
    for (const frame of pending) {
      try {
        child.stdin.write(frame);
      } catch {
        /* stdin already closed */
      }
    }
    pending.length = 0;
  };
  // Fail-safe only: a totally silent agent must still eventually accept input.
  // The FIRST output byte is the real "bridge is in raw mode" signal (the bridge
  // goes raw before it emits anything). We keep this timeout long because
  // setup.sh runs DB migrations / workspace restore BEFORE the bridge starts —
  // its own stdout goes to a log, so no output reaches us during that window,
  // and flushing frames early could land a control byte on a still-cooked
  // container TTY and signal setup.sh. 60s comfortably clears cold bootstrap.
  const readyTimer = setTimeout(flushPending, 60_000);
  if (typeof readyTimer.unref === "function") readyTimer.unref();

  const send = (frame) => {
    if (exited) return;
    if (!ready) {
      pending.push(frame);
      return;
    }
    try {
      child.stdin.write(frame);
    } catch {
      /* stdin already closed */
    }
  };

  child.stdout.on("data", (chunk) => {
    if (!ready) {
      clearTimeout(readyTimer);
      flushPending();
    }
    const text = decoder.decode(chunk, { stream: true });
    if (!text) return;
    for (const handler of dataHandlers) handler(text);
  });

  // wsl.exe / openshell-connect / bridge diagnostics arrive on stderr and are
  // NEVER terminal content — log them instead of injecting them into xterm.
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trimEnd();
    if (text) console.warn("[openrindPty] transport:", text);
  });

  const emitExit = (exitCode, signal) => {
    if (exited) return;
    exited = true;
    clearTimeout(readyTimer);
    for (const handler of exitHandlers) handler({ exitCode, signal });
  };
  child.on("exit", (code, signal) =>
    emitExit(typeof code === "number" ? code : null, signal ?? undefined),
  );
  child.on("error", () => emitExit(null, undefined));

  return {
    get pid() {
      return child.pid;
    },
    write(data) {
      send(encodeDataFrame(data));
    },
    resize(cols, rows) {
      send(encodeResizeFrame(cols, rows));
    },
    kill(signal) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
    pause() {
      try {
        child.stdout?.pause();
      } catch {
        /* stream already destroyed — nothing to throttle */
      }
    },
    resume() {
      try {
        child.stdout?.resume();
      } catch {
        /* stream already destroyed */
      }
    },
    onData(handler) {
      dataHandlers.add(handler);
      return {
        dispose() {
          dataHandlers.delete(handler);
        },
      };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return {
        dispose() {
          exitHandlers.delete(handler);
        },
      };
    },
  };
}

/**
 * LEGACY escape hatch: the pre-fix node-pty/ConPTY transport. Renders with the
 * ConPTY corruption (gibberish banner line etc.), but it is the proven path and
 * gives `connect` a real TTY — so if the pipe transport ever fails to connect
 * on a given machine, setting OPENRIND_DESKTOP_PTY_CONPTY=1 restores a working
 * (if ugly) terminal without a rebuild. The container-side bridge still runs;
 * with no handshake it just transparently passes bytes through.
 */
async function legacyConptySpawn({ sandboxName, cols, rows, extraEnv }) {
  const pty = await import("node-pty");
  const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;
  const shellCmd =
    `stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; ` +
    `exec openshell sandbox connect ${quotedName}`;
  return pty.spawn("wsl.exe", ["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd], {
    name: "xterm-256color",
    cols,
    rows,
    env: extraEnv ? buildWslEnv(extraEnv) : process.env,
    cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
  });
}

/**
 * Default spawn: launch `openshell sandbox connect <name>` over plain pipes
 * (no ConPTY). Framed mode + the initial size are announced IN-BAND via the
 * handshake makePipePty writes first — `connect` cannot carry env/args into the
 * container, so env can't be used for either. Later resizes arrive as RESIZE
 * frames from the renderer.
 *
 * @param {{ sandboxName: string, cols: number, rows: number,
 *           extraEnv?: Record<string, string> | null }} opts
 * @returns {Promise<IPtyLike>}
 */
async function defaultSpawnImpl(opts) {
  // Escape hatch — see legacyConptySpawn. Off by default; the whole point of
  // this module is to NOT use ConPTY.
  if (process.env.OPENRIND_DESKTOP_PTY_CONPTY === "1") {
    return legacyConptySpawn(opts);
  }
  const { sandboxName, cols, rows, extraEnv } = opts;
  const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;
  // No stty here: there is no WSL-side TTY to configure (our stdio are pipes),
  // and the bridge puts the container PTY into raw mode itself. `connect`
  // starts the sandbox entry command, which execs openrind-pty-bridge.py.
  const shellCmd = `exec openshell sandbox connect ${quotedName}`;
  // extraEnv (ANTHROPIC_API_KEY, OPENRIND_GATEWAY_API_KEY, …) is still forwarded via
  // WSLENV as before; the sandbox's own launch config also bakes credentials in.
  const child = wslSpawn(["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd], {
    env: extraEnv ? buildWslEnv(extraEnv) : process.env,
    // CWD doesn't matter for wsl.exe, but a cleanup-safe default is polite.
    cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
  });
  return makePipePty(child, cols, rows);
}

let spawnImpl = defaultSpawnImpl;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

// Terminal dimensions are packed into the handshake and RESIZE control frames,
// so clamp to a positive integer (or the fallback) in every path that accepts
// renderer-supplied sizes.
function clampDimension(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Open a new PTY session against an existing Openrind Shell sandbox.
 *
 * @param {Object} opts
 * @param {string} opts.sandboxName
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {Record<string, string>} [opts.extraEnv]  Extra env vars forwarded
 *   into WSL via WSLENV (e.g. ANTHROPIC_API_KEY, OPENRIND_GATEWAY_API_KEY). These
 *   are needed so Claude Code can auto-configure its provider on first run
 *   inside the sandbox without prompting the user interactively.
 * @param {string | null} [opts.agentSessionId]  Openrind Desktop session id whose
 *   agent conversation this PTY runs. Agent sessions are CONCURRENT by
 *   design: each (sandbox, agentSessionId) pair owns at most one PTY, and a
 *   sandbox may host several live PTYs at once — one per session — so
 *   switching tasks in the sidebar never interrupts another session's
 *   in-flight work. Passing an id whose PTY is still live adopts it
 *   (lossless re-attach after navigation); other sessions' PTYs are never
 *   touched.
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
  const agentSessionId = opts.agentSessionId ?? null;

  // Adoption / idempotency: if a still-live PTY already runs THIS agent
  // session, re-attach to it instead of spawning a second wsl child. This
  // makes openSession safe to call from any path (legacy openrindPtyOpen, a
  // racy double-mount) without ever leaking a duplicate PTY for one session.
  // PTYs owned by OTHER sessions in the same sandbox are left untouched —
  // their agents keep working in the background.
  const existing = findSessionBySandboxAndAgent(
    opts.sandboxName,
    agentSessionId,
  );
  if (existing) {
    if (!existing.exitInfo) {
      // Still live → adopt it; never spawn a second wsl child for one session.
      attachHandlers(existing.id, { onData: opts.onData, onExit: opts.onExit });
      resizeSession(existing.id, cols, rows);
      return {
        id: existing.id,
        sandboxName: existing.sandboxName,
        reused: true,
      };
    }
    // This session's prior PTY exited (lingering for replay) — a fresh
    // openSession means the user is reconnecting it, so forget the corpse
    // and spawn anew. Guarantees at most one PTY per (sandbox, session).
    closeSession(existing.id);
  }

  const pty = await spawnImpl({
    sandboxName: opts.sandboxName,
    cols,
    rows,
    extraEnv,
  });
  const id = randomUUID();

  /** @type {Session} */
  const session = {
    id,
    sandboxName: opts.sandboxName,
    agentSessionId,
    pty,
    onData: opts.onData ?? null,
    onExit: opts.onExit ?? null,
    size: { cols, rows },
    openedAt: Date.now(),
    buffer: [],
    bufferTimes: [],
    bufferBytes: 0,
    detached: false,
    paused: false,
    exitInfo: null,
  };

  // Wire data → buffer (always, even while detached) → caller (only when a
  // renderer is attached). The agent's stdout and stderr are merged onto the
  // bridge's PTY, so onData delivers one interleaved stream — exactly what
  // xterm.js expects.
  pty.onData((data) => {
    appendToBuffer(session, data);
    session.onData?.(data);
  });

  pty.onExit((event) => {
    const code = typeof event?.exitCode === "number" ? event.exitCode : null;
    const signal =
      typeof event?.signal === "number"
        ? String(event.signal)
        : (event?.signal ?? null);
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
 * Apply renderer backpressure: stop draining the bridge's stdout so the agent
 * can't push more output than xterm's parser is consuming. Paired with
 * resumeSession() from the renderer's write-callback drain (see the flow
 * control block in openrind-shell-terminal.tsx).
 *
 * Idempotent, and a no-op on an exited session (nothing left to throttle).
 * `pause` is optional on IPtyLike so test stubs need not implement it.
 *
 * @param {string} id
 */
export function pauseSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.exitInfo || session.paused) return false;
  session.paused = true;
  session.pty.pause?.();
  return true;
}

/**
 * Release backpressure applied by pauseSession(). Safe to call unconditionally
 * — returns false when the session wasn't paused.
 *
 * @param {string} id
 */
export function resumeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (!session.paused) return false;
  session.paused = false;
  session.pty.resume?.();
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
 * Openrind Shell sandbox itself persists — that's the whole point of Openrind Shell's
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
 * Find the PTY owned by a specific (sandbox, agentSessionId) pair. Agent
 * sessions run concurrently — one live PTY per pair — so lookups must always
 * match on BOTH keys; matching on the sandbox alone would grab some other
 * session's PTY. `agentSessionId` null matches the legacy default-
 * conversation PTY (no specific session requested).
 *
 * @param {string} sandboxName
 * @param {string | null} agentSessionId
 * @returns {Session | null}
 */
export function findSessionBySandboxAndAgent(sandboxName, agentSessionId) {
  if (!sandboxName) return null;
  const wanted = agentSessionId ?? null;
  for (const session of sessions.values()) {
    if (
      session.sandboxName === sandboxName &&
      (session.agentSessionId ?? null) === wanted
    ) {
      return session;
    }
  }
  return null;
}

/**
 * Close every PTY (live or lingering-dead) that targets a sandbox. Used when
 * the sandbox itself is deleted — with concurrent per-session PTYs there can
 * be several, and each would otherwise die slowly on a broken tunnel.
 *
 * @param {string} sandboxName
 * @returns {number} how many sessions were closed
 */
export function closeSessionsForSandbox(sandboxName) {
  if (!sandboxName) return 0;
  let closed = 0;
  for (const session of Array.from(sessions.values())) {
    if (session.sandboxName === sandboxName) {
      if (closeSession(session.id)) closed++;
    }
  }
  return closed;
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
  const bytes = getBufferBytes(id);
  if (!bytes) return "";
  return new TextDecoder().decode(bytes);
}

/**
 * Return the session's retained scrollback as the RAW bytes the PTY emitted,
 * with no decoding step at all. This is the byte-exact stream the agent wrote,
 * so dumping it to a file and `cat`-ing that file into a known-good terminal
 * reproduces the agent's output independently of xterm.js. That is the
 * measurement that separates "xterm.js mis-parsed a sequence" from "the
 * renderer painted it wrong" — do this before concluding anything about the
 * emulator.
 *
 * @param {string} id
 * @returns {Uint8Array | null} null for an unknown session
 */
export function getBufferBytes(id) {
  const session = sessions.get(id);
  if (!session) return null;
  const merged = new Uint8Array(session.bufferBytes);
  let offset = 0;
  for (const chunk of session.buffer) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Return the retained scrollback as an asciinema-v2-shaped recording: the
 * per-chunk arrival times captured in appendToBuffer plus the chunk payloads.
 *
 * Chunks are decoded with a SINGLE streaming decoder walked over them in
 * order, not one decode per chunk. A multi-byte glyph split across a chunk
 * boundary therefore stays intact (its tail simply lands at the head of the
 * next chunk's string) and concatenating every payload reproduces the merged
 * decode exactly. Decoding each chunk independently would inject U+FFFD at
 * every boundary — i.e. it would fabricate the very corruption we are trying
 * to diagnose.
 *
 * @param {string} id
 * @returns {{ chunks: Array<{ t: number, data: string }>, cols: number,
 *   rows: number, openedAt: number, sandboxName: string } | null}
 */
export function getBufferRecording(id) {
  const session = sessions.get(id);
  if (!session) return null;
  const decoder = new TextDecoder("utf-8");
  const chunks = [];
  for (let i = 0; i < session.buffer.length; i++) {
    const data = decoder.decode(session.buffer[i], { stream: true });
    // A chunk that was pure continuation bytes decodes to "" — drop it rather
    // than emit an empty asciinema event.
    if (!data) continue;
    chunks.push({ t: (session.bufferTimes[i] ?? 0) / 1000, data });
  }
  return {
    chunks,
    cols: session.size.cols,
    rows: session.size.rows,
    openedAt: session.openedAt,
    sandboxName: session.sandboxName,
  };
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
  // Never leave a detached session throttled: the renderer that applied the
  // backpressure is gone, so nothing would ever call resumeSession() and the
  // agent would stay blocked on write for the whole time the user is away.
  resumeSession(id);
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
    agentSessionId: s.agentSessionId ?? null,
    cols: s.size.cols,
    rows: s.size.rows,
    openedAt: s.openedAt,
    pid: s.pty.pid ?? null,
    paused: s.paused,
  }));
}

// NOTE: there is deliberately no BEL (\x07) → "needs attention" detection here.
// It was tried and removed: Claude Code rings the bell during a perfectly
// healthy startup, so every new session immediately claimed it was waiting for
// the user. BEL is not a reliable "needs input" signal across these agents, and
// a warning that fires on success is worse than no warning at all. If this is
// revisited, it needs a per-agent signal that actually means "blocked", not a
// bell count.

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
  // A fresh renderer starts with an empty write queue and no memory of an
  // earlier pause, so hand it a flowing stream.
  resumeSession(id);
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
   * Replace the spawn implementation with a stub. The stub receives the same
   * options openSession would pass and must return an IPty-like object.
   * Use clearSpawnImpl() to restore the default.
   */
  installSpawnImpl(fn) {
    spawnImpl = fn;
  },
  clearSpawnImpl() {
    spawnImpl = defaultSpawnImpl;
  },
  /** Encode a keystroke DATA frame (exposed for the frame-protocol tests). */
  encodeDataFrame,
  /** Encode a RESIZE frame (exposed for the frame-protocol tests). */
  encodeResizeFrame,
  /** Encode the in-band mode handshake (exposed for the frame-protocol tests). */
  encodeHandshake,
  /** Wrap a fake child in the IPtyLike facade (exposed for the facade tests). */
  makePipePty,
  FRAME_DATA,
  FRAME_RESIZE,
  HANDSHAKE_MAGIC,
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
