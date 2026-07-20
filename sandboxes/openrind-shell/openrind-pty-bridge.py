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

# Set once the mode is known. The SIGWINCH handler consults this so it never
# fights the RESIZE frames in framed mode.
_mode = None  # "framed" | "raw" | None
_agent_master_fd = -1


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


def parse_frames(buffer, master_fd):
    """Consume complete control frames from `buffer` (a bytearray, mutated in
    place). Partial trailing bytes are left for the next read."""
    while len(buffer) >= 5:
        frame_type = buffer[0]
        length = int.from_bytes(buffer[1:5], "big")
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
    global _mode, _agent_master_fd

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

    # os.openpty() opens /dev/ptmx (a symlink to /dev/pts/ptmx). The sandbox's
    # Landlock policy must grant /dev/pts for this to succeed — see policy.yaml.
    master_fd, slave_fd = os.openpty()
    _agent_master_fd = master_fd
    set_winsize(slave_fd, cols, rows)
    # Disable echo BEFORE the agent starts so terminal-query responses / mouse
    # events the desktop sends back during startup aren't echoed as gibberish
    # above the agent's UI (see disable_input_echo).
    disable_input_echo(slave_fd)

    pid = spawn_child(master_fd, slave_fd, argv)
    os.close(slave_fd)

    # If framed and we buffered the first frame bytes, apply them now.
    if _mode == "framed" and inbound:
        parse_frames(inbound, master_fd)
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

        try:
            readable, _, _ = select.select([0, master_fd], [], [], 0.25)
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
            write_all(1, chunk)
            continue

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
                    parse_frames(inbound, master_fd)
                elif result[0] == "raw":
                    _mode = "raw"
                    write_all(master_fd, bytes(inbound))
                    inbound = bytearray()
                continue
            if _mode == "framed":
                inbound.extend(chunk)
                parse_frames(inbound, master_fd)
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
