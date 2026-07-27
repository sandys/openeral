#!/usr/bin/env python3
"""Unit tests for openrind-pty-bridge.py's ScrollbackKeeper.

The keeper rewrites the agent's own full-screen clear so it cannot destroy
OpenClaw's banner and the launch progress log (see the long comment in the
bridge). It sits directly in the byte path of every keystroke and every frame
the desktop terminal renders, so the exact substitutions — and, just as
importantly, everything it must NOT touch — are pinned here.

No Docker, no PostgreSQL, no network. Run:  python3 tests/test_pty_bridge_scrollback.py
"""
import importlib.util
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent.parent / "sandboxes/openrind-shell/openrind-pty-bridge.py"

spec = importlib.util.spec_from_file_location("openrind_pty_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ROWS = 3


def scroll(used, rows=ROWS):
    """What the keeper substitutes for ESC[2J ESC[H.

    Park on the last row, push only the rows the agent actually DREW into the
    scrollback one linefeed at a time, erase whatever is left, then home.

    Pushing only the drawn rows is the point: scrolling a full screen also
    pushes the blank tail, which buried OpenClaw's banner 29 lines above the
    viewport. The trailing ESC[2J is what makes the estimate safe — short and
    the erase cleans up, long and we pushed a couple of blank lines.
    """
    return (
        b"\x1b[%d;1H" % rows
        + b"\n" * min(used + 1, rows)
        + b"\x1b[2J"
        + b"\x1b[H"
    )


# Nothing drawn before the clear -> one row pushed.
SCROLL = scroll(0)
# The exact burst pi-tui's forced full redraw emits (tui.js: "Clear screen,
# home, then clear scrollback").
PI_TUI_CLEAR = b"\x1b[2J\x1b[H\x1b[3J"

failures = []


def check(label, got, want):
    if got == want:
        print("  ok    %s" % label)
    else:
        failures.append("%s\n          got  %r\n          want %r" % (label, got, want))
        print("  FAIL  %s" % label)


def keeper(enabled=True):
    return bridge.ScrollbackKeeper(ROWS, enabled=enabled)


print("\n--- ScrollbackKeeper: the rewrite ---")

k = keeper()
check("pi-tui clear burst is rewritten and ESC[3J dropped", k.feed(b"A" + PI_TUI_CLEAR + b"B"), b"A" + SCROLL + b"B")
check("counters record one rewrite and one drop", (k.scrolls, k.drops), (1, 1))

k = keeper()
k.set_rows(50)
check(
    "the scroll follows the live screen height",
    k.feed(b"\x1b[2J\x1b[H"),
    scroll(0, rows=50),
)

print("\n--- ScrollbackKeeper: only the DRAWN rows are preserved ---")

# Five lines drawn -> six rows pushed (the five plus the one being written).
k = keeper(enabled=True)
k.set_rows(40)
body = b"line1\nline2\nline3\nline4\nline5\n"
check("plain output passes through untouched", k.feed(body), body)
check("...and only those rows are pushed", k.feed(b"\x1b[2J\x1b[H"), scroll(5, rows=40))

# pi-tui addresses rows directly rather than only appending, so an absolute CUP
# has to raise the estimate too.
k = keeper()
k.set_rows(40)
k.feed(b"\x1b[12;1Hdrawn down here")
check("an absolute cursor move raises the estimate", k.feed(b"\x1b[2J\x1b[H"), scroll(12, rows=40))

# Never more than one screen, however much was drawn.
k = keeper()
k.set_rows(4)
k.feed(b"a\nb\nc\nd\ne\nf\ng\n")
check("the push is capped at one screen", k.feed(b"\x1b[2J\x1b[H"), scroll(99, rows=4))

# The estimate resets, so a second clear does not push the first clear's rows.
k = keeper()
k.set_rows(40)
k.feed(b"x\ny\nz\n")
k.feed(b"\x1b[2J\x1b[H")
check("the estimate resets after each clear", k.feed(b"\x1b[2J\x1b[H"), scroll(0, rows=40))

# Whatever the estimate, the agent must end up on a blank screen at home.
for used in (0, 3, 999):
    k = keeper()
    k.set_rows(20)
    k.feed(b"\n" * used if used < 100 else b"")
    out = k.feed(b"\x1b[2J\x1b[H")
    if not out.endswith(b"\x1b[2J\x1b[H"):
        failures.append("blank-screen guarantee missing for used=%d: %r" % (used, out))
check("every rewrite still ends with erase+home", True, True)

print("\n--- ScrollbackKeeper: what must NOT change ---")

# ED does not move the cursor. Rewriting a bare ESC[2J into a scroll would, so
# only the ESC[2J ESC[H pair pi-tui actually emits may be touched.
check("a bare ESC[2J is passed through", keeper().feed(b"\x1b[2Jx"), b"\x1b[2Jx")

# `clear` emits ESC[3J ESC[H ESC[2J — home first, so the erase stands. Only the
# scrollback wipe is dropped, which is what VTE has always done for `clear`.
k = keeper()
check("clear(1) keeps its screen erase", k.feed(b"\x1b[3J\x1b[H\x1b[2J") + k.flush(), b"\x1b[H\x1b[2J")

noise = b"\x1b[?25l\x1b[0m\x1b[38;5;209mOpenClaw\x1b[39m\x1b[12J\x1b[?2026h\x1b]8;;\x07"
check("unrelated escapes are untouched", keeper().feed(noise), noise)

body = b"".join(b"line %d\r\n" % i for i in range(500))
check("bulk text is byte-identical", keeper().feed(body), body)

check("the kill switch is the identity function", keeper(enabled=False).feed(PI_TUI_CLEAR), PI_TUI_CLEAR)

print("\n--- ScrollbackKeeper: read-boundary safety ---")

# A PTY read can split anywhere. Every split must produce the same stream, and
# no byte may ever be lost.
payload = b"A" + PI_TUI_CLEAR + b"B"
expected = b"A" + SCROLL + b"B"
split_failures = []
for cut in range(len(payload) + 1):
    k = keeper()
    if k.feed(payload[:cut]) + k.feed(payload[cut:]) + k.flush() != expected:
        split_failures.append(cut)
check("identical output for a split at any of %d offsets" % (len(payload) + 1), split_failures, [])

k = keeper()
check(
    "byte-at-a-time delivery",
    b"".join(k.feed(payload[i : i + 1]) for i in range(len(payload))) + k.flush(),
    expected,
)

k = keeper()
check("a trailing ESC is held, not corrupted", k.feed(b"abc\x1b"), b"abc")
check("...and completes on the next read", k.feed(b"[2J\x1b[H"), SCROLL)

k = keeper()
check("a partial sequence is held", k.feed(b"z\x1b[2"), b"z")
check("holding is observable to the select loop", k.holding, True)
check("flush() releases it", k.flush(), b"\x1b[2")
check("nothing is held afterwards", k.holding, False)

if failures:
    print("\n%d failure(s):" % len(failures))
    for entry in failures:
        print("    " + entry)
    sys.exit(1)
print("\n\u2713 All ScrollbackKeeper checks passed\n")
