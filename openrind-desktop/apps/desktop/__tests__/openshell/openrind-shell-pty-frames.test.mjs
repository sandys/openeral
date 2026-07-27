// Unit tests for the control-frame transport in
// apps/desktop/electron/openshell/openrind-shell-pty.mjs.
//
// The desktop side ENCODES frames (Node/Buffer) and the container-side
// openrind-pty-bridge.py DECODES them (Python). These tests pin the wire format
// byte-for-byte and prove a reference decoder (mirroring the Python
// parse_frames) round-trips every frame — so the two ends can never silently
// drift. They also exercise the makePipePty() facade with a fake child: input
// buffering until first output, UTF-8 stream decoding, and exit propagation.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const pty = await import("../../electron/openshell/openrind-shell-pty.mjs");
const {
  encodeDataFrame,
  encodeResizeFrame,
  encodeHandshake,
  makePipePty,
  FRAME_DATA,
  FRAME_RESIZE,
  HANDSHAKE_MAGIC,
} = pty.__testing;

// ── Reference decoder — a faithful JS mirror of the Python bridge's
//    parse_frames(). If this and the Python version ever disagree, the format
//    changed and one side wasn't updated.
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const type = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (buffer.length - offset < 5 + length) break;
    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if (type === FRAME_DATA) {
      frames.push({ type: "data", payload: Buffer.from(payload) });
    } else if (type === FRAME_RESIZE && length === 4) {
      frames.push({
        type: "resize",
        cols: payload.readUInt16BE(0),
        rows: payload.readUInt16BE(2),
      });
    } else {
      frames.push({ type: "unknown" });
    }
  }
  return { frames, consumed: offset };
}

test("encodeDataFrame: byte layout is [0x00][u32be len][payload]", () => {
  const frame = encodeDataFrame("hi");
  assert.equal(frame[0], FRAME_DATA);
  assert.equal(frame.readUInt32BE(1), 2);
  assert.equal(frame.subarray(5).toString("utf8"), "hi");
  assert.equal(frame.length, 5 + 2);
});

test("encodeResizeFrame: byte layout is [0x01][u32be 4][u16be cols][u16be rows]", () => {
  const frame = encodeResizeFrame(120, 32);
  assert.equal(frame[0], FRAME_RESIZE);
  assert.equal(frame.readUInt32BE(1), 4);
  assert.equal(frame.readUInt16BE(5), 120);
  assert.equal(frame.readUInt16BE(7), 32);
  assert.equal(frame.length, 9);
});

test("encodeResizeFrame: clamps to a positive u16 range", () => {
  const zero = encodeResizeFrame(0, 0);
  assert.equal(zero.readUInt16BE(5), 1);
  assert.equal(zero.readUInt16BE(7), 1);
  const huge = encodeResizeFrame(999_999, 999_999);
  assert.equal(huge.readUInt16BE(5), 65_535);
  assert.equal(huge.readUInt16BE(7), 65_535);
});

test("encodeHandshake: 4 NULs + tag + decimal size + newline, no ISIG bytes", () => {
  const hs = encodeHandshake(120, 32);
  // Must start with the magic the bridge (openrind-pty-bridge.py) matches on.
  assert.deepEqual(hs.subarray(0, HANDSHAKE_MAGIC.length), HANDSHAKE_MAGIC);
  assert.equal(hs.subarray(0, 4).toString("hex"), "00000000");
  assert.equal(hs.subarray(4, HANDSHAKE_MAGIC.length).toString("ascii"), "OPENRINDPTY1");
  assert.equal(hs.subarray(HANDSHAKE_MAGIC.length).toString("ascii"), " 120 32\n");
  // Crucially it must contain no 0x03 (Ctrl-C) or 0x1c (Ctrl-\) — those could
  // raise a signal if the container PTY is still cooked when it arrives.
  assert.equal(hs.includes(0x03), false);
  assert.equal(hs.includes(0x1c), false);
});

test("round-trip: a DATA frame with arbitrary bytes (incl. 0x03) survives", () => {
  // 0x03 is Ctrl-C; it must be transported as data, never interpreted — this is
  // exactly why the bridge puts its transport fd into raw mode.
  const payload = Buffer.from([0x03, 0x00, 0x1b, 0x5b, 0x41, 0xff]);
  const { frames } = decodeFrames(encodeDataFrame(payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "data");
  assert.deepEqual(frames[0].payload, payload);
});

test("round-trip: concatenated frames decode in order", () => {
  const wire = Buffer.concat([
    encodeResizeFrame(80, 24),
    encodeDataFrame("abc"),
    encodeResizeFrame(100, 40),
  ]);
  const { frames } = decodeFrames(wire);
  assert.deepEqual(
    frames.map((f) => f.type),
    ["resize", "data", "resize"],
  );
  assert.equal(frames[0].cols, 80);
  assert.equal(frames[0].rows, 24);
  assert.equal(frames[1].payload.toString("utf8"), "abc");
  assert.equal(frames[2].cols, 100);
});

test("round-trip: a frame split across reads is only decoded once complete", () => {
  const full = encodeDataFrame("hello");
  const first = decodeFrames(full.subarray(0, 6)); // header + 1 payload byte
  assert.equal(first.frames.length, 0);
  assert.equal(first.consumed, 0);
  const whole = decodeFrames(full);
  assert.equal(whole.frames.length, 1);
  assert.equal(whole.frames[0].payload.toString("utf8"), "hello");
});

// ── Handshake classification — JS mirror of openrind-pty-bridge.py classify() ──
function classify(buf) {
  if (buf.length === 0) return { kind: "need_more" };
  const startsWithMagic =
    buf.length >= HANDSHAKE_MAGIC.length &&
    buf.subarray(0, HANDSHAKE_MAGIC.length).equals(HANDSHAKE_MAGIC);
  const isPrefix =
    buf.length < HANDSHAKE_MAGIC.length &&
    HANDSHAKE_MAGIC.subarray(0, buf.length).equals(buf);
  if (!startsWithMagic && !isPrefix) return { kind: "raw", bytes: buf };
  if (!startsWithMagic) return { kind: "need_more" };
  const nl = buf.indexOf(0x0a, HANDSHAKE_MAGIC.length);
  if (nl === -1) return { kind: "need_more" };
  const line = buf.subarray(HANDSHAKE_MAGIC.length, nl).toString("ascii").trim();
  const [cols, rows] = line.split(/\s+/).map((n) => parseInt(n, 10));
  return { kind: "framed", cols, rows, rest: buf.subarray(nl + 1) };
}

test("classify: a full handshake is framed with the right size + trailing frames", () => {
  const wire = Buffer.concat([encodeHandshake(120, 32), encodeDataFrame("hello")]);
  const result = classify(wire);
  assert.equal(result.kind, "framed");
  assert.equal(result.cols, 120);
  assert.equal(result.rows, 32);
  // The bytes after the handshake are the first frame, intact.
  assert.equal(decodeFrames(result.rest).frames[0].payload.toString("utf8"), "hello");
});

test("classify: ordinary keystrokes (external terminal) are raw passthrough", () => {
  const result = classify(Buffer.from("ls -la\r", "ascii"));
  assert.equal(result.kind, "raw");
});

test("classify: a partial magic prefix asks for more before deciding", () => {
  assert.equal(classify(HANDSHAKE_MAGIC.subarray(0, 3)).kind, "need_more");
  // Full magic but no newline yet → still need more.
  assert.equal(classify(Buffer.concat([HANDSHAKE_MAGIC, Buffer.from(" 80")])).kind, "need_more");
});

// ── makePipePty facade ──────────────────────────────────────────────────────

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = { writes: [], write(buf) { this.writes.push(Buffer.from(buf)); } };
  child.stdout = new EventEmitter();
  child.stdout.flow = [];
  child.stdout.pause = () => child.stdout.flow.push("pause");
  child.stdout.resume = () => child.stdout.flow.push("resume");
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => child.killed.push(signal ?? null);
  return child;
}

test("makePipePty: sends the handshake immediately with the initial size", () => {
  const child = makeFakeChild();
  makePipePty(child, 100, 40);
  // The very first write is the handshake, sent before any output/input.
  assert.equal(child.stdin.writes.length, 1);
  assert.deepEqual(child.stdin.writes[0], encodeHandshake(100, 40));
});

test("makePipePty: buffers FRAMES until first output, then flushes in order", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  // writes[0] is the handshake; drop it so we only assert on frames.
  child.stdin.writes.length = 0;

  term.resize(90, 30); // queued (not ready yet)
  term.write("x"); // queued
  assert.equal(child.stdin.writes.length, 0, "frames must not write before first output");

  child.stdout.emit("data", Buffer.from("banner"));

  // Both queued frames flush, in order, once the bridge has proven it's live.
  const decoded = decodeFrames(Buffer.concat(child.stdin.writes));
  assert.deepEqual(
    decoded.frames.map((f) => f.type),
    ["resize", "data"],
  );
  assert.equal(decoded.frames[0].cols, 90);
  assert.equal(decoded.frames[1].payload.toString("utf8"), "x");

  // After ready, further writes go straight through.
  child.stdin.writes.length = 0;
  term.write("y");
  assert.equal(decodeFrames(child.stdin.writes[0]).frames[0].payload.toString("utf8"), "y");
});

test("makePipePty: onData decodes UTF-8 across chunk boundaries", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  const chunks = [];
  term.onData((text) => chunks.push(text));

  // "€" (U+20AC) is 0xE2 0x82 0xAC — split it across two stdout chunks.
  const euro = Buffer.from("€", "utf8");
  child.stdout.emit("data", euro.subarray(0, 1));
  child.stdout.emit("data", euro.subarray(1));

  assert.equal(chunks.join(""), "€", "multi-byte glyph must not be corrupted");
});

test("makePipePty: onExit reports the child's exit code", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  let seen = null;
  term.onExit((event) => {
    seen = event;
  });
  child.emit("exit", 7, null);
  assert.deepEqual(seen, { exitCode: 7, signal: undefined });
});

test("makePipePty: kill forwards the signal to the child", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  term.kill("SIGTERM");
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("makePipePty: pause/resume map onto the child's stdout flow state", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  // Backpressure has to land on the stream itself: an undrained pipe is what
  // stops wsl.exe reading, which is what eventually blocks the agent's write
  // into the container PTY. Buffering in the renderer would not throttle it.
  term.pause();
  term.resume();
  assert.deepEqual(child.stdout.flow, ["pause", "resume"]);
});

test("makePipePty: pause/resume never throw once the stream is gone", () => {
  const child = makeFakeChild();
  const term = makePipePty(child, 80, 24);
  child.stdout = null;
  term.pause();
  term.resume();
});
