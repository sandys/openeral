// Ad-hoc verification for the asciinema-v2 cast built by
// dumpOpenrindShellPtyBuffer() in electron/main.mjs. That function needs
// Electron's `app`/`shell`, so it can't run under `node --test`; this script
// replays the exact same serialisation logic over a stubbed PTY session and
// asserts the result is a well-formed cast.
//
// Run: node scripts/verify-cast-shape.mjs

import assert from "node:assert/strict";

const pty = await import("../electron/openshell/openrind-shell-pty.mjs");

/** Set by the stubbed spawn impl so the test body can drive PTY output. */
let emitter = null;

pty.__testing.installSpawnImpl(async () => {
  let dataHandler = null;
  const fake = {
    pid: 1,
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
    onData(handler) {
      dataHandler = handler;
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
  };
  fake.__emit = (d) => dataHandler?.(d);
  emitter = fake;
  return fake;
});

const { id } = await pty.openSession({
  sandboxName: "openrind-shell-cast",
  cols: 120,
  rows: 32,
});

emitter.__emit("\x1b[2J\x1b[H");
emitter.__emit("hello ");
// A multi-byte glyph split across two chunks — the cast must not inject U+FFFD.
emitter.__emit(new Uint8Array([0xf0, 0x9f]));
emitter.__emit(new Uint8Array([0x9a, 0x80]));
emitter.__emit(" world\r\n");

// ── The serialisation under test (mirrors main.mjs) ──────────────────────
const recording = pty.getBufferRecording(id);
const t0 = recording.chunks.length > 0 ? recording.chunks[0].t : 0;
const header = {
  version: 2,
  width: recording.cols,
  height: recording.rows,
  timestamp: Math.floor((recording.openedAt + t0 * 1000) / 1000),
  env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
};
const lines = [JSON.stringify(header)];
for (const chunk of recording.chunks) {
  lines.push(JSON.stringify([Number((chunk.t - t0).toFixed(6)), "o", chunk.data]));
}
const cast = `${lines.join("\n")}\n`;

// ── Assertions ───────────────────────────────────────────────────────────
const parsed = cast.trimEnd().split("\n").map((l) => JSON.parse(l));
const [head, ...events] = parsed;

assert.equal(head.version, 2, "header declares asciinema v2");
assert.equal(head.width, 120);
assert.equal(head.height, 32);
assert.ok(
  Number.isInteger(head.timestamp) && head.timestamp > 1_600_000_000,
  "header timestamp is a plausible unix-seconds value",
);

assert.ok(events.length > 0, "cast has at least one event");
assert.equal(events[0][0], 0, "first event is rebased to t=0");
let prev = -1;
for (const [t, kind, data] of events) {
  assert.ok(Number.isFinite(t) && t >= prev, "event times are monotonic");
  assert.equal(kind, "o", "every event is an output event");
  assert.equal(typeof data, "string");
  prev = t;
}

const replayed = events.map((e) => e[2]).join("");
assert.equal(
  replayed,
  pty.getBuffer(id),
  "concatenated events reproduce the decoded stream exactly",
);
assert.ok(replayed.includes("hello \u{1F680} world"), "split emoji survived");
assert.ok(!replayed.includes("\uFFFD"), "no replacement chars were injected");

// The .raw side must stay byte-exact.
const raw = pty.getBufferBytes(id);
assert.deepEqual(
  Buffer.from(raw),
  Buffer.from(pty.getBuffer(id), "utf8"),
  ".raw bytes match the stream",
);

pty.__testing.resetAll();
console.log(
  `cast shape OK — ${events.length} events, ${raw.length} raw bytes, header ${JSON.stringify(header)}`,
);
