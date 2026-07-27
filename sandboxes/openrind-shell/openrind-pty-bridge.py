#!/usr/bin/env python3
"""
openrind-pty-bridge — a tiny PTY host that runs the agent (Claude Code /
OpenClaw) on a *real* Linux pseudo-terminal and streams its raw bytes back to
the caller, with terminal resizes delivered out of band.

Why this exists
---------------
On Windows, Openrind Desktop used to run `wsl.exe` through node-pty, which uses the
Windows **ConPTY** (Pseudoconsole). ConPTY keeps its own screen model and
re-serializes it, which mangles full-screen Ink/React TUIs like Claude Code and
OpenClaw — stranded reflow frames (the "gibberish line" over the banner), a
too-narrow welcome box, and a mis-placed composer. Nothing on the xterm.js side
can un-corrupt bytes ConPTY already mangled.

The fix is to take ConPTY out of the byte path: Openrind Desktop now spawns
`wsl.exe` with plain pipes (no ConPTY) and this bridge — launched by setup.sh as
the agent's exec — owns the ONLY PTY the agent renders to. The agent draws
exactly as in a native Linux terminal, and every byte reaches xterm.js untouched.

Two drive modes (auto-detected — see below)
-------------------------------------------
`openshell sandbox connect` cannot carry env/args into the container, and BOTH
the desktop terminal AND the "pop out to an OS terminal" launcher run the same
connect command. So the bridge cannot be told its mode via env; it detects the
mode from the first bytes it reads on stdin:

  * FRAMED (Openrind Desktop): the desktop sends a one-line handshake first:

        \\x00\\x00\\x00\\x00OPENRINDPTY1 <cols> <rows>\\n

    followed by length-prefixed control frames:

        frame := u8 type, u32 big-endian length, <length> bytes payload
          type 0x00 DATA   -> payload written verbatim to the agent PTY (stdin)
          type 0x01 RESIZE -> payload is u16be cols, u16be rows -> TIOCSWINSZ

    The bridge writes the agent's raw PTY output straight to stdout (no framing).

  * RAW PASSTHROUGH (external terminal): no handshake ever arrives; the first
    bytes are the user's keystrokes. The bridge copies stdin<->agent-PTY
    verbatim and mirrors the connect TTY's window size onto the agent PTY (both
    initially and on SIGWINCH), i.e. it behaves like a transparent `script`.

Either way the bridge puts its own stdin (the connect TTY, if it is one) into
raw mode so control frames / keystrokes are byte-transparent — a length byte of
0x03 must never raise SIGINT.

Usage:  openrind-pty-bridge.py <command> [args...]
        (e.g. `openrind-pty-bridge.py env HOME=/home/agent claude`)

Standard-library only — no pip/npm/native build, so it works in the locked-down
sandbox image.
"""

import errno
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time

LOG_PATH = "/tmp/openrind-pty-bridge.log"

# Handshake sentinel: 4 NULs (a terminal never sends these as the first bytes of
# a session) + a version tag. Followed by " <cols> <rows>\n".
HANDSHAKE_MAGIC = b"\x00\x00\x00\x00OPENRINDPTY1"
# Cap on how long the handshake line may be before we give up and treat the
# stream as raw (guards against a byte stream that happens to start with NULs).
HANDSHAKE_MAX = len(HANDSHAKE_MAGIC) + 64
# How long to wait for the handshake before spawning the agent. Only affects the
# initial-size optimization: the true mode is always decided by stream CONTENT,
# never by this timeout. Keep it short so the pop-out terminal launches promptly.
HANDSHAKE_WAIT_S = 0.3

FRAME_DATA = 0x00
FRAME_RESIZE = 0x01

READ_CHUNK = 65536

# Hard ceiling on a single control frame's declared payload length. The 32-bit
# frame header is attacker/mistake-controllable: a peer can claim a length of up
# to 4 GiB, which would make parse_frames() retain the partial frame and keep
# appending every subsequent read until the (possibly never-arriving) remainder
# lands — an unbounded-memory / hung-session vector. Legitimate frames are tiny
# (a RESIZE is 4 bytes; a DATA frame is one xterm `onData` burst — keystrokes,
# or at most a paste). 8 MiB is far larger than any real terminal paste yet
# bounds the worst-case `inbound` buffer to ~MAX_FRAME_LEN + READ_CHUNK, since
# the check reads only the 5-byte header and fires before the huge frame is
# ever buffered.
MAX_FRAME_LEN = 8 * 1024 * 1024

# Set once the mode is known. The SIGWINCH handler consults this so it never
# fights the RESIZE frames in framed mode.
_mode = None  # "framed" | "raw" | None
_agent_master_fd = -1
# The ScrollbackKeeper for this session (framed mode only), so set_winsize()
# can keep its idea of the screen height in sync from every resize path.
_keeper = None

# Terminal hygiene sent to the desktop (framed mode only) so the agent always
# paints onto a pristine screen and a crashed agent never leaves xterm wedged.
# Order matters: leave any leftover alternate-screen buffer FIRST so the clear
# lands on the main screen, then knock down modes a prior session may have left
# enabled (mouse reporting in every encoding, bracketed paste), show the cursor,
# and reset SGR. The agent re-enables whatever it needs on startup.
_TERM_RESET_MODES = (
    b"\x1b[?1049l"  # leave alternate screen buffer
    b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l"  # disable mouse reporting
    b"\x1b[?2004l"  # disable bracketed paste
    b"\x1b[?25h"  # show cursor
    b"\x1b[0m"  # reset colors / attributes
)
# RESET also wipes scrollback + screen so the first paint is on a blank canvas.
TERMINAL_RESET = _TERM_RESET_MODES + b"\x1b[3J\x1b[H\x1b[2J"
# RESTORE (on agent exit) deliberately omits the clear so the user keeps their
# scrollback after the agent quits.
TERMINAL_RESTORE = _TERM_RESET_MODES

# ── Scrollback preservation (framed mode) ──────────────────────────────────
# The agent's own full-screen clear is rewritten on its way out so that it can
# never DESTROY what is already on the desktop terminal.
#
# Why this is needed: `openclaw tui` prints OpenClaw's banner (version, commit
# and the coloured tagline) on stdout, openclaw-launch.sh prints the whole
# progress log above it — and then the TUI initialises its session display.
# That last step goes through pi-tui's requestRender(force=true), whose full
# redraw begins with
#
#     ESC[2J  ESC[H  ESC[3J        erase display, home, erase SCROLLBACK
#
# so that one burst takes the banner and every launch line off the screen AND
# out of the scrollback, leaving nothing to scroll back to. It is unconditional
# inside OpenClaw — pi-tui deliberately sets previousWidth/-Height to -1 to
# force the clearing variant of its full redraw — and there is no flag, config
# key or env var that turns it off. Verified on 2026.7.1-2 with PI_DEBUG_REDRAW=1:
#
#     fullRender: first render (prev=0, new=7, height=30)
#     fullRender: terminal width changed (-1 -> 120) (prev=0, new=8, height=30)
#
# The rewrite: ESC[2J ESC[H becomes "park on the last row, then linefeed a whole
# screenful". A linefeed on the bottom row is the one sequence every emulator
# (xterm, xterm.js, VTE) turns into a scrollback push, whereas both ESC[2J and
# CSI S discard the lines instead. The state the agent then renders onto is
# identical — blank viewport, cursor at home — the only difference is that the
# old screen is now sitting above it instead of being gone. ESC[3J is dropped
# outright: erasing the user's scrollback is never required for the agent's own
# rendering to come out right.
#
# Only the exact ESC[2J ESC[H pair is rewritten. A bare ESC[2J is passed through
# untouched, because ED does not move the cursor and rewriting it would.
CLEAR_AND_HOME = b"\x1b[2J\x1b[H"
ERASE_SCROLLBACK = b"\x1b[3J"
_REWRITE_WINDOW = max(len(CLEAR_AND_HOME), len(ERASE_SCROLLBACK))
# Either sequence can straddle two os.read() boundaries, so up to
# _REWRITE_WINDOW - 1 bytes are held back waiting for the rest. They are flushed
# anyway after this long, so an agent that goes idle mid-sequence can never
# leave bytes stranded inside the bridge. A complete ESC[2J counts as partial
# (it may still become ESC[2J ESC[H), so this is also the worst-case latency of
# a bare screen clear that ends a write — keep it well under a frame.
HOLDBACK_FLUSH_S = 0.01
# Env kill switch: set to 0 to stream the agent's bytes through verbatim.
KEEP_SCROLLBACK_ENV = "OPENRIND_SHELL_PTY_KEEP_SCROLLBACK"

# How many clears are rewritten before the pair is left alone.
#
# Everything this filter exists to protect — the banner, the launch log, a
# degraded-mode explanation — is printed BEFORE the agent's TUI settles, so only
# the first few clears have anything above them worth saving. Every later full
# redraw repaints the SAME UI, and pushing each one into the scrollback is not
# preservation but noise: it evicts the very content the first rewrite saved.
#
# The realistic trigger is a window resize, not token streaming. pi-tui takes the
# clearing variant of its full redraw whenever the dimensions change, so dragging
# the Openrind Desktop window emits one clear per resize event; unbudgeted, a few
# seconds of dragging pushes hundreds of duplicate frames and the banner falls off
# the end of xterm.js's scrollback.
#
# Past the budget the pair is forwarded verbatim, which is exactly what the agent
# gets with no bridge at all: an in-place erase. Nothing is corrupted, the screen
# state the agent asked for is identical either way, and the only difference is
# that the outgoing frame is discarded instead of saved. 4 covers every
# legitimate case with headroom (healthy launch uses 1; local-mode fallback uses
# 2 — the launcher's own clear_screen() plus pi-tui's first render).
#
# ESC[3J is dropped regardless of this budget: erasing the user's scrollback is
# never required for the agent's own rendering to be correct.
MAX_SCROLL_REWRITES = 4
MAX_SCROLL_REWRITES_ENV = "OPENRIND_SHELL_PTY_MAX_SCROLL_REWRITES"


def _env_int(name, default):
    """Non-negative integer from the environment; anything else keeps the
    default. A bad value must never be able to disable the filter by accident."""
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw.isdigit() else default


class ScrollbackKeeper:
    """Stream filter over the agent's PTY output. See the comment above."""

    def __init__(self, rows, enabled=True, max_rewrites=MAX_SCROLL_REWRITES):
        self.enabled = enabled
        self.scrolls = 0
        self.drops = 0
        # Clears forwarded untouched after the rewrite budget ran out.
        self.passthroughs = 0
        self._max_rewrites = max(0, int(max_rewrites))
        self._rows = max(1, int(rows))
        self._held = b""
        self._held_at = 0.0
        # How far down the screen the agent has drawn since the last clear. Only
        # this many rows are worth pushing into the scrollback; scrolling the
        # full screen also pushes the blank tail, which is what buried OpenClaw's
        # banner 29 lines above the viewport instead of ~8.
        self._used_rows = 0

    def set_rows(self, rows):
        """Track the live screen height; the scroll can never exceed one screen."""
        self._rows = max(1, int(rows))

    def _note_output(self, data, start, end):
        """Count linefeeds in a run of plain output to approximate how far down
        the screen the agent has drawn."""
        if self._used_rows < self._rows:
            self._used_rows += data.count(0x0A, start, end)

    def _note_cursor_row(self, params):
        """An absolute CUP (ESC[<row>;<col>H) also tells us how far down the
        agent is drawing — pi-tui addresses rows directly rather than only
        appending."""
        head = params.split(b";")[0]
        if not head.isdigit():
            return
        try:
            self._used_rows = max(self._used_rows, int(head))
        except ValueError:
            pass

    def _scroll_out(self):
        """Push the drawn region into the scrollback, then guarantee a blank
        screen for the agent to paint on.

        The trailing ESC[2J is what makes the row estimate safe: if it is short,
        the erase removes whatever is left; if it is long, we only pushed a few
        blank lines. Either way the agent gets exactly the clean screen it asked
        for, and only the rows it actually used reach the scrollback.
        """
        used = max(1, min(self._used_rows + 1, self._rows))
        self._used_rows = 0
        return (
            b"\x1b[%d;1H" % self._rows  # park on the last row
            + b"\n" * used  # push the drawn rows into scrollback
            + b"\x1b[2J"  # erase whatever remains (in place; ED never moves the cursor)
            + b"\x1b[H"  # ...then home, as the agent asked
        )

    def feed(self, chunk):
        """Return the bytes to forward for this read. May buffer a partial
        sequence; see expired() / flush()."""
        if not self.enabled:
            return chunk
        data = self._held + chunk if self._held else chunk
        self._held = b""
        out = bytearray()
        index = 0
        size = len(data)
        while index < size:
            esc = data.find(0x1B, index)
            if esc == -1:
                # Plain output to the end of the chunk. Count it too: a burst
                # with no escape at all is the common case for a log-style
                # screen, and missing it left the row estimate at zero.
                self._note_output(data, index, size)
                out += data[index:]
                break
            self._note_output(data, index, esc)
            out += data[index:esc]
            window = data[esc : esc + _REWRITE_WINDOW]
            if window.startswith(CLEAR_AND_HOME):
                index = esc + len(CLEAR_AND_HOME)
                if self.scrolls < self._max_rewrites:
                    used = self._used_rows
                    out += self._scroll_out()
                    self.scrolls += 1
                    if self.scrolls == 1:
                        log(
                            "scrollback: rewrote agent full-screen clear "
                            "(rows=%d, pushed=%d) — banner/launch log preserved"
                            % (self._rows, min(used + 1, self._rows))
                        )
                    continue
                # Budget spent: hand the agent's own clear straight through, the
                # way an unbridged terminal would. Reset the row estimate anyway
                # — the screen really is being cleared, so the drawn-rows count
                # restarts regardless of who performs the erase.
                self._used_rows = 0
                self.passthroughs += 1
                if self.passthroughs == 1:
                    log(
                        "scrollback: rewrite budget (%d) reached — later clears "
                        "pass through so repeated redraws cannot evict the "
                        "preserved banner/launch log" % self._max_rewrites
                    )
                out += CLEAR_AND_HOME
                continue
            # Absolute cursor positioning tells us how far down the agent draws.
            if window.startswith(b"\x1b["):
                final = data.find(b"H", esc + 2, esc + 12)
                if final != -1:
                    self._note_cursor_row(data[esc + 2 : final])
            if window.startswith(ERASE_SCROLLBACK):
                self.drops += 1
                index = esc + len(ERASE_SCROLLBACK)
                continue
            if len(window) < _REWRITE_WINDOW and (
                CLEAR_AND_HOME.startswith(window) or ERASE_SCROLLBACK.startswith(window)
            ):
                # Truncated at the read boundary and still a possible match.
                self._held = bytes(window)
                self._held_at = time.monotonic()
                break
            out += data[esc : esc + 1]
            index = esc + 1
        return bytes(out)

    @property
    def holding(self):
        """True while a partial sequence is buffered (the select() loop polls
        faster so the holdback is never user-visible)."""
        return bool(self._held)

    def expired(self):
        """Held-back bytes once they have waited longer than HOLDBACK_FLUSH_S."""
        if not self._held or time.monotonic() - self._held_at < HOLDBACK_FLUSH_S:
            return b""
        return self.flush()

    def flush(self):
        """Held-back bytes, unconditionally (session teardown)."""
        held = self._held
        self._held = b""
        return held


def log(message):
    """Append a diagnostic line to a file. We must NEVER write diagnostics to
    fd 1/fd 2 — those are the terminal the agent renders on (fd 2 usually points
    at the same PTY as fd 1), so a stray log line would corrupt the TUI."""
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(message + "\n")
    except Exception:
        pass


def make_raw(fd):
    """Put `fd` into raw mode; return the original attrs for restore(). No-op
    (returns None) when fd is not a tty."""
    try:
        original = termios.tcgetattr(fd)
    except Exception:
        return None
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(fd)
    iflag &= ~(
        termios.IGNBRK
        | termios.BRKINT
        | termios.PARMRK
        | termios.ISTRIP
        | termios.INLCR
        | termios.IGNCR
        | termios.ICRNL
        | termios.IXON
    )
    oflag &= ~termios.OPOST
    lflag &= ~(
        termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN
    )
    cflag &= ~(termios.CSIZE | termios.PARENB)
    cflag |= termios.CS8
    try:
        termios.tcsetattr(
            fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, ispeed, ospeed, cc]
        )
    except Exception:
        return None
    return original


def restore_termios(fd, original):
    if original is None:
        return
    try:
        termios.tcsetattr(fd, termios.TCSANOW, original)
    except Exception:
        pass


def get_winsize(fd):
    """Return (cols, rows) from `fd`'s TIOCGWINSZ, or None if fd isn't a tty."""
    try:
        packed = fcntl.ioctl(fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        rows, cols, _, _ = struct.unpack("HHHH", packed)
        if cols > 0 and rows > 0:
            return cols, rows
    except Exception:
        pass
    return None


def disable_input_echo(fd):
    """Turn OFF echo + canonical input on the agent PTY.

    Closes the startup window during which the PTY is in the default cooked
    mode: Claude/OpenClaw query the terminal (cursor position, colors, mouse
    tracking) as they boot, and Openrind Desktop's xterm sends the responses (and,
    on a text selection, SGR mouse events like \\x1b[<..m) back as INPUT. A
    cooked PTY echoes that input onto the screen — which is exactly the
    gibberish that lands above the agent banner and "changes when you select".
    The agent flips the PTY to full raw mode itself once it starts; this just
    beats it to the echo/canonical flags so nothing leaks in the meantime.
    Output processing (OPOST) is left ON so a plain `bash -i` command's \\n
    still becomes \\r\\n (no staircase).
    """
    try:
        attrs = termios.tcgetattr(fd)
    except Exception:
        return
    lmask = 0
    for name in (
        "ECHO",
        "ECHOE",
        "ECHOK",
        "ECHONL",
        "ECHOCTL",
        "ECHOKE",
        "ICANON",
        "ISIG",
        "IEXTEN",
    ):
        lmask |= getattr(termios, name, 0)
    attrs[3] &= ~lmask  # lflag
    try:
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except Exception:
        pass


def set_winsize(fd, cols, rows):
    """Resize the PTY. Setting TIOCSWINSZ on the master also delivers SIGWINCH
    to the agent, which is exactly how a real terminal triggers a repaint."""
    cols = max(1, min(65535, int(cols)))
    rows = max(1, min(65535, int(rows)))
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception as exc:  # pragma: no cover - depends on kernel/pty state
        log("set_winsize(%d,%d) failed: %r" % (cols, rows, exc))
    # Every resize path in this file targets the agent PTY, so this is the one
    # place the ScrollbackKeeper's screen height has to be kept current.
    if _keeper is not None:
        _keeper.set_rows(rows)


def classify(buf):
    """Classify accumulated stdin bytes.

    Returns one of:
      ("framed", cols, rows, rest_bytes)  full handshake consumed; rest is frames
      ("raw", all_bytes)                  not our handshake; all bytes are input
      ("need_more",)                      inconclusive; read more
    """
    if not buf:
        return ("need_more",)
    prefix = HANDSHAKE_MAGIC[: len(buf)]
    if bytes(buf) != prefix and not bytes(buf).startswith(HANDSHAKE_MAGIC):
        # Diverged from the magic before completing it → definitely raw.
        return ("raw", bytes(buf))
    if not bytes(buf).startswith(HANDSHAKE_MAGIC):
        # Still a proper prefix of the magic but incomplete.
        return ("need_more",)
    newline = buf.find(b"\n", len(HANDSHAKE_MAGIC))
    if newline == -1:
        if len(buf) > HANDSHAKE_MAX:
            return ("raw", bytes(buf))
        return ("need_more",)
    line = bytes(buf[len(HANDSHAKE_MAGIC) : newline]).strip()
    rest = bytes(buf[newline + 1 :])
    cols, rows = 80, 24
    try:
        parts = line.split()
        cols = int(parts[0])
        rows = int(parts[1])
    except Exception:
        pass
    return ("framed", cols, rows, rest)


def write_all(fd, data):
    """Write every byte of `data` to `fd`, tolerating short/interrupted writes."""
    if not data:
        return True
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                select.select([], [fd], [], 0.05)
                continue
            return False
        view = view[written:]
    return True


def kill_and_reap(pid):
    """SIGHUP the agent and reap it, ignoring errors. Used to tear the session
    down after a fatal transport violation."""
    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        pass


def parse_frames(buffer, master_fd):
    """Consume complete control frames from `buffer` (a bytearray, mutated in
    place). Partial trailing bytes are left for the next read.

    Returns True normally, or False when a frame's declared length exceeds
    MAX_FRAME_LEN — a corrupt or hostile stream. The caller MUST tear the
    session down on False: continuing to feed such a stream would let the bogus
    length grow `buffer` without bound. The check inspects only the 5-byte
    header, so it fires before the oversize frame is buffered, and we clear
    `buffer` so memory stays bounded even if the caller is slow to react."""
    while len(buffer) >= 5:
        frame_type = buffer[0]
        length = int.from_bytes(buffer[1:5], "big")
        if length > MAX_FRAME_LEN:
            log(
                "fatal: framed peer declared frame length %d > MAX_FRAME_LEN %d "
                "(type=%d) — aborting frame parse"
                % (length, MAX_FRAME_LEN, frame_type)
            )
            del buffer[:]
            return False
        if len(buffer) < 5 + length:
            break
        payload = bytes(buffer[5 : 5 + length])
        del buffer[: 5 + length]
        if frame_type == FRAME_DATA:
            write_all(master_fd, payload)
        elif frame_type == FRAME_RESIZE and length == 4:
            cols = int.from_bytes(payload[0:2], "big")
            rows = int.from_bytes(payload[2:4], "big")
            set_winsize(master_fd, cols, rows)
        else:
            log("dropping unknown frame type=%d len=%d" % (frame_type, length))
    return True


def spawn_child(master_fd, slave_fd, argv):
    """Fork the agent onto the PTY slave as a new session leader."""
    pid = os.fork()
    if pid != 0:
        return pid

    # ── Child ────────────────────────────────────────────────────────────
    try:
        os.setsid()
    except OSError:
        pass
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except Exception:
        pass
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    try:
        os.close(master_fd)
    except OSError:
        pass
    # A PTY app reads its size from TIOCGWINSZ; leaving stale COLUMNS/LINES in
    # the env would fight the live winsize after a resize. Drop them, and
    # guarantee a TERM the TUIs understand.
    for name in ("COLUMNS", "LINES", "OPENRIND_PTY_COLS", "OPENRIND_PTY_ROWS"):
        os.environ.pop(name, None)
    os.environ.setdefault("TERM", "xterm-256color")
    try:
        os.execvp(argv[0], argv)
    except Exception as exc:  # pragma: no cover - exec failure path
        try:
            os.write(
                1,
                ("openrind-pty-bridge: failed to exec %r: %s\r\n" % (argv[0], exc)).encode(),
            )
        except Exception:
            pass
        os._exit(127)


def main():
    global _mode, _agent_master_fd, _keeper

    argv = sys.argv[1:]
    if not argv:
        log("no command given")
        return 2

    # Silence our OWN stderr onto the log file. connect frequently gives an
    # entry command a single PTY for fd 0/1/2, so anything we print on fd 2
    # would land in the middle of the agent's screen.
    try:
        log_fd = os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(log_fd, 2)
        if log_fd > 2:
            os.close(log_fd)
    except Exception:
        pass

    original_termios = make_raw(0)  # raw transport; no-op if fd 0 is a pipe

    # ── Phase 1: try to read the handshake so the agent's FIRST paint is at the
    #    correct size. Mode is still ultimately decided by content, so a timeout
    #    here only means "spawn at the TTY's size and classify later".
    inbound = bytearray()
    init_cols = 0
    init_rows = 0
    deadline = time.monotonic() + HANDSHAKE_WAIT_S
    while _mode is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            readable, _, _ = select.select([0], [], [], remaining)
        except (InterruptedError, OSError):
            continue
        if 0 not in readable:
            break
        try:
            chunk = os.read(0, READ_CHUNK)
        except OSError:
            chunk = b""
        if not chunk:
            # Transport closed before we saw anything — nothing to run.
            restore_termios(0, original_termios)
            return 0
        inbound.extend(chunk)
        result = classify(inbound)
        if result[0] == "framed":
            _mode = "framed"
            init_cols, init_rows = result[1], result[2]
            inbound = bytearray(result[3])
        elif result[0] == "raw":
            _mode = "raw"
            # inbound already holds the raw bytes to forward to the agent.

    tty_size = get_winsize(0)
    if _mode == "framed" and init_cols > 0 and init_rows > 0:
        cols, rows = init_cols, init_rows
    elif tty_size:
        cols, rows = tty_size
    else:
        cols, rows = 80, 24

    # Keep the agent from erasing the banner / launch log out of the desktop's
    # scrollback (see ScrollbackKeeper). It is only ever applied in framed mode
    # — decided at use time, since the mode can still be settled late — because
    # raw passthrough must stay byte-transparent for the user's own terminal.
    _keeper = ScrollbackKeeper(
        rows,
        enabled=os.environ.get(KEEP_SCROLLBACK_ENV, "1").strip().lower()
        not in ("0", "false", "no"),
        max_rewrites=_env_int(MAX_SCROLL_REWRITES_ENV, MAX_SCROLL_REWRITES),
    )

    # os.openpty() opens /dev/ptmx (a symlink to /dev/pts/ptmx). The sandbox's
    # Landlock policy must grant /dev/pts for this to succeed — see policy.yaml.
    master_fd, slave_fd = os.openpty()
    _agent_master_fd = master_fd
    set_winsize(slave_fd, cols, rows)
    # Disable echo BEFORE the agent starts so terminal-query responses / mouse
    # events the desktop sends back during startup aren't echoed as gibberish
    # above the agent's UI (see disable_input_echo).
    disable_input_echo(slave_fd)

    # Hand the agent a pristine terminal (framed/desktop only — a pop-out
    # external terminal is the user's to manage). Written straight to stdout so
    # it reaches xterm BEFORE the agent's first byte of output.
    if _mode == "framed":
        write_all(1, TERMINAL_RESET)

    pid = spawn_child(master_fd, slave_fd, argv)
    os.close(slave_fd)

    # If framed and we buffered the first frame bytes, apply them now.
    if _mode == "framed" and inbound:
        if not parse_frames(inbound, master_fd):
            # Oversize frame already in the startup buffer — tear down before
            # entering the main loop (see parse_frames / MAX_FRAME_LEN).
            kill_and_reap(pid)
            restore_termios(0, original_termios)
            try:
                os.close(master_fd)
            except OSError:
                pass
            return 1
    # If raw and we buffered keystrokes, forward them now.
    elif _mode == "raw" and inbound:
        write_all(master_fd, bytes(inbound))
        inbound = bytearray()

    # Mirror the connect TTY's resizes onto the agent PTY in raw/undecided mode.
    # In framed mode the desktop is authoritative via RESIZE frames, so ignore.
    def on_winch(_signum, _frame):
        if _mode == "framed":
            return
        size = get_winsize(0)
        if size:
            set_winsize(_agent_master_fd, size[0], size[1])

    try:
        signal.signal(signal.SIGWINCH, on_winch)
    except Exception:
        pass

    def forward_signal(signum, _frame):
        try:
            os.kill(pid, signum)
        except Exception:
            pass

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        try:
            signal.signal(sig, forward_signal)
        except Exception:
            pass

    child_exited = False
    exit_code = 0

    while True:
        if not child_exited:
            try:
                waited_pid, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                waited_pid, status = pid, 0
            if waited_pid == pid:
                child_exited = True
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)

        # Poll fast while a partial escape sequence is held back, so releasing it
        # costs milliseconds instead of a full idle tick.
        try:
            readable, _, _ = select.select(
                [0, master_fd], [], [], 0.005 if _keeper.holding else 0.25
            )
        except InterruptedError:
            continue
        except OSError:
            break

        if master_fd in readable:
            try:
                chunk = os.read(master_fd, READ_CHUNK)
            except OSError:
                chunk = b""
            if not chunk:
                break  # agent closed the PTY — session over
            if _mode == "framed":
                write_all(1, _keeper.feed(chunk))
            else:
                write_all(1, chunk)
            continue

        # Nothing to read: release any bytes the keeper is holding for a sequence
        # that never completed, so an idle agent's last output is never stuck.
        write_all(1, _keeper.expired())

        if 0 in readable:
            try:
                chunk = os.read(0, READ_CHUNK)
            except OSError:
                chunk = b""
            if not chunk:
                try:
                    os.kill(pid, signal.SIGHUP)
                except Exception:
                    pass
                break
            if _mode is None:
                # Late classification: content decides, size already set.
                inbound.extend(chunk)
                result = classify(inbound)
                if result[0] == "framed":
                    _mode = "framed"
                    set_winsize(master_fd, result[1], result[2])
                    inbound = bytearray(result[3])
                    if not parse_frames(inbound, master_fd):
                        kill_and_reap(pid)
                        child_exited = True
                        exit_code = 1
                        break
                elif result[0] == "raw":
                    _mode = "raw"
                    write_all(master_fd, bytes(inbound))
                    inbound = bytearray()
                continue
            if _mode == "framed":
                inbound.extend(chunk)
                if not parse_frames(inbound, master_fd):
                    # Fatal framing violation: drop the connection rather than
                    # buffer a bogus multi-GB frame (see MAX_FRAME_LEN).
                    kill_and_reap(pid)
                    child_exited = True
                    exit_code = 1
                    break
            else:
                write_all(master_fd, chunk)
            continue

        if child_exited:
            break

    if not child_exited:
        try:
            _, status = os.waitpid(pid, 0)
            if os.WIFEXITED(status):
                exit_code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                exit_code = 128 + os.WTERMSIG(status)
        except Exception:
            pass

    # Restore the desktop terminal so a crashed or abruptly-exited TUI never
    # leaves xterm stuck in alt-screen, mouse-reporting, hidden-cursor, or a
    # non-default color state. Release any partial sequence the keeper is still
    # holding first, so the agent's very last bytes are not swallowed.
    if _mode == "framed":
        write_all(1, _keeper.flush())
        write_all(1, TERMINAL_RESTORE)

    restore_termios(0, original_termios)
    try:
        os.close(master_fd)
    except OSError:
        pass
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
