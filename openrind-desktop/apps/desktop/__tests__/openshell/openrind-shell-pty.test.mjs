// Unit tests for apps/desktop/electron/openshell/openrind-shell-pty.mjs.
//
// Stub the transport through __testing.installSpawnImpl and verify the session
// map, lifecycle, and handler dispatch with a plain EventEmitter
// pretending to be an IPty.

import test from "node:test";
import assert from "node:assert/strict";

const pty = await import("../../electron/openshell/openrind-shell-pty.mjs");

/**
 * Build a fake IPty. Captures every write/resize/kill, lets the test
 * fire data/exit events on demand.
 */
function makeFakePty() {
  let dataHandler = null;
  let exitHandler = null;
  const events = { writes: [], resizes: [], kills: [], flow: [] };
  const fake = {
    pid: 12_345,
    write(data) {
      events.writes.push(data);
    },
    resize(cols, rows) {
      events.resizes.push({ cols, rows });
    },
    kill(signal) {
      events.kills.push(signal ?? null);
    },
    pause() {
      events.flow.push("pause");
    },
    resume() {
      events.flow.push("resume");
    },
    onData(handler) {
      dataHandler = handler;
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandler = handler;
      return { dispose() {} };
    },
  };
  return {
    fake,
    events,
    emit(data) {
      dataHandler?.(data);
    },
    exit(exitCode, signal) {
      exitHandler?.({ exitCode, signal });
    },
  };
}

let lastSpawnArgs = null;
let activeFake = null;

test.beforeEach(() => {
  lastSpawnArgs = null;
  activeFake = null;
  pty.__testing.installEnsureGatewayImpl(async () => undefined);
  pty.__testing.installSpawnImpl(async (opts) => {
    lastSpawnArgs = opts;
    activeFake = makeFakePty();
    return activeFake.fake;
  });
});

test.afterEach(() => {
  pty.__testing.resetAll();
});

// ── openSession ────────────────────────────────────────────────────────

test("openSession: spawns with the given sandbox name + size + returns id", async () => {
  const result = await pty.openSession({
    sandboxName: "openrind-shell-demo",
    cols: 100,
    rows: 30,
  });
  assert.ok(result.id);
  assert.equal(result.sandboxName, "openrind-shell-demo");
  assert.equal(lastSpawnArgs.sandboxName, "openrind-shell-demo");
  assert.equal(lastSpawnArgs.cols, 100);
  assert.equal(lastSpawnArgs.rows, 30);
});

test("openSession: defaults to 120x32 when cols/rows omitted", async () => {
  await pty.openSession({ sandboxName: "x" });
  assert.equal(lastSpawnArgs.cols, 120);
  assert.equal(lastSpawnArgs.rows, 32);
});

test("openSession: rejects empty sandbox name", async () => {
  await assert.rejects(
    () => pty.openSession({ sandboxName: "" }),
    /sandboxName is required/,
  );
});

test("openSession: forwards PTY data to onData callback", async () => {
  const received = [];
  await pty.openSession({
    sandboxName: "x",
    onData: (data) => received.push(data),
  });
  activeFake.emit("hello world\n");
  activeFake.emit("more\n");
  assert.deepEqual(received, ["hello world\n", "more\n"]);
});

test("openSession: tracks the session in listSessions", async () => {
  const before = pty.listSessions();
  assert.equal(before.length, 0);
  const result = await pty.openSession({ sandboxName: "openrind-shell-demo" });
  const after = pty.listSessions();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, result.id);
  assert.equal(after[0].sandboxName, "openrind-shell-demo");
  assert.equal(after[0].cols, 120);
  assert.equal(after[0].rows, 32);
  assert.equal(after[0].pid, 12_345);
  assert.ok(after[0].openedAt > 0);
});

// ── writeSession ───────────────────────────────────────────────────────

test("writeSession: forwards string data to the PTY", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  const ok = pty.writeSession(id, "ls\n");
  assert.equal(ok, true);
  assert.deepEqual(activeFake.events.writes, ["ls\n"]);
});

test("writeSession: returns false for unknown session", () => {
  const ok = pty.writeSession("not-a-real-id", "hello");
  assert.equal(ok, false);
});

test("writeSession: coerces non-string input to string", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.writeSession(id, 42);
  assert.deepEqual(activeFake.events.writes, ["42"]);
});

// ── resizeSession ──────────────────────────────────────────────────────

test("resizeSession: forwards new size to the PTY", async () => {
  const { id } = await pty.openSession({
    sandboxName: "x",
    cols: 80,
    rows: 24,
  });
  const ok = pty.resizeSession(id, 100, 40);
  assert.equal(ok, true);
  assert.deepEqual(activeFake.events.resizes, [{ cols: 100, rows: 40 }]);
});

test("resizeSession: no-op when size hasn't changed (skips SIGWINCH)", async () => {
  const { id } = await pty.openSession({
    sandboxName: "x",
    cols: 80,
    rows: 24,
  });
  pty.resizeSession(id, 80, 24);
  assert.equal(activeFake.events.resizes.length, 0);
});

test("resizeSession: floors fractional sizes", async () => {
  const { id } = await pty.openSession({
    sandboxName: "x",
    cols: 80,
    rows: 24,
  });
  pty.resizeSession(id, 100.7, 40.3);
  assert.deepEqual(activeFake.events.resizes, [{ cols: 100, rows: 40 }]);
});

test("resizeSession: returns false for unknown session", () => {
  assert.equal(pty.resizeSession("not-a-real-id", 100, 40), false);
});

test("resizeSession: keeps previous size when called with NaN", async () => {
  const { id } = await pty.openSession({
    sandboxName: "x",
    cols: 80,
    rows: 24,
  });
  pty.resizeSession(id, NaN, NaN);
  assert.equal(activeFake.events.resizes.length, 0);
  const sessions = pty.listSessions();
  assert.equal(sessions[0].cols, 80);
  assert.equal(sessions[0].rows, 24);
});

// ── closeSession ───────────────────────────────────────────────────────

test("closeSession: kills the PTY with SIGTERM by default", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.closeSession(id);
  assert.deepEqual(activeFake.events.kills, ["SIGTERM"]);
});

test("closeSession: accepts a custom signal", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.closeSession(id, "SIGKILL");
  assert.deepEqual(activeFake.events.kills, ["SIGKILL"]);
});

test("closeSession: removes the session from the map immediately (does not wait for onExit)", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.listSessions().length, 1);
  pty.closeSession(id);
  // closeSession is the authoritative deleter — the map is clean right away,
  // even before the transport's onExit fires.
  assert.equal(pty.listSessions().length, 0);
  // A late onExit on the orphaned session must not resurrect or crash.
  activeFake.exit(0);
  assert.equal(pty.listSessions().length, 0);
});

test("closeSession: returns false for unknown session", () => {
  assert.equal(pty.closeSession("not-a-real-id"), false);
});

// ── onExit handler dispatch ────────────────────────────────────────────

test("onExit handler fires with exit code + signal", async () => {
  const exits = [];
  await pty.openSession({
    sandboxName: "x",
    onExit: (code, signal) => exits.push({ code, signal }),
  });
  activeFake.exit(7, "SIGTERM");
  assert.deepEqual(exits, [{ code: 7, signal: "SIGTERM" }]);
});

test("host lifecycle exit capture survives renderer detach and fires once", async () => {
  const lifecycle = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_capture",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  pty.detachSession(id);
  activeFake.exit(9, "SIGKILL");

  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].id, id);
  assert.equal(lifecycle[0].sandboxName, "x");
  assert.equal(lifecycle[0].agentSessionId, "ses_capture");
  assert.equal(lifecycle[0].exitCode, 9);
  assert.equal(lifecycle[0].signal, "SIGKILL");
  assert.equal(lifecycle[0].terminationCause, "process-exit");
  assert.equal(lifecycle[0].closeRequestedAt, null);
  assert.ok(lifecycle[0].endedAt >= lifecycle[0].openedAt);
});

test("explicit close is reported as Desktop cancellation to host lifecycle capture", async () => {
  const lifecycle = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_cancel",
    onLifecycleExit: (event) => lifecycle.push(event),
  });

  assert.equal(pty.closeSession(id), true);
  activeFake.exit(null, "SIGTERM");

  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].terminationCause, "desktop-close");
  assert.equal(typeof lifecycle[0].closeRequestedAt, "number");
  assert.equal(lifecycle[0].signal, "SIGTERM");
});

test("onExit RETAINS the session (marks exitInfo) so it can be replayed on re-attach", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.listSessions().length, 1);
  activeFake.exit(3, "SIGHUP");
  // Session is kept in the map so a renderer that re-attaches after the wsl
  // child died can still replay the final output and offer "Reconnect".
  assert.equal(pty.listSessions().length, 1);
  const session = pty.__testing.getSession(id);
  assert.deepEqual(session.exitInfo, { exitCode: 3, signal: "SIGHUP" });
});

test("post-exit: writeSession and resizeSession return false (no writes to a dead pty)", async () => {
  const { id } = await pty.openSession({
    sandboxName: "x",
    cols: 80,
    rows: 24,
  });
  activeFake.exit(0);
  assert.equal(pty.writeSession(id, "ls\n"), false);
  assert.equal(pty.resizeSession(id, 100, 40), false);
  assert.equal(activeFake.events.writes.length, 0);
  assert.equal(activeFake.events.resizes.length, 0);
});

// ── output buffer + replay ──────────────────────────────────────────────

test("getBuffer: accumulates emitted output for replay", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  activeFake.emit("hello ");
  activeFake.emit("world");
  assert.equal(pty.getBuffer(id), "hello world");
});

test("getBuffer: returns empty string for an unknown session", () => {
  assert.equal(pty.getBuffer("not-a-real-id"), "");
});

test("getBuffer: decodes the MERGED byte array (multibyte char split across chunks is intact)", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  // "é" is 0xC3 0xA9 in UTF-8 — emit each byte as its own chunk. A per-chunk
  // decode would yield replacement chars; a merged decode reconstructs "é".
  activeFake.emit(new Uint8Array([0xc3]));
  activeFake.emit(new Uint8Array([0xa9]));
  assert.equal(pty.getBuffer(id), "é");
});

test("buffer cap: evicts oldest output, retains the tail, stays within the byte cap", async () => {
  const CAP = 768 * 1024;
  const { id } = await pty.openSession({ sandboxName: "x" });
  activeFake.emit("START" + "a".repeat(400_000));
  activeFake.emit("b".repeat(400_000)); // total > cap → first chunk evicted
  activeFake.emit("ENDMARKER");
  const buffered = pty.getBuffer(id);
  assert.ok(
    new TextEncoder().encode(buffered).length <= CAP,
    "within byte cap",
  );
  assert.ok(buffered.includes("ENDMARKER"), "retains the newest output");
  assert.ok(!buffered.includes("START"), "evicts the oldest output");
});

// ── raw stream capture (diagnostics) ────────────────────────────────────

test("getBufferBytes: returns the byte-exact stream, not a decoded round-trip", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  // A lone 0x80 is invalid UTF-8. Decoding would replace it with U+FFFD and
  // re-encoding that is 3 different bytes — so a decoded round-trip could not
  // reproduce this stream. The raw accessor must hand back the original bytes.
  activeFake.emit(new Uint8Array([0x1b, 0x5b, 0x41, 0x80]));
  assert.deepEqual(
    Array.from(pty.getBufferBytes(id)),
    [0x1b, 0x5b, 0x41, 0x80],
  );
});

test("getBufferBytes: returns null for an unknown session", () => {
  assert.equal(pty.getBufferBytes("not-a-real-id"), null);
});

test("getBufferRecording: chunk payloads concatenate to the merged decode", async () => {
  const { id } = await pty.openSession({ sandboxName: "x", cols: 90, rows: 25 });
  // Split "é" (0xC3 0xA9) across two chunks. A per-chunk decode would emit
  // U+FFFD twice — i.e. fabricate the corruption the dump exists to diagnose.
  activeFake.emit(new Uint8Array([0xc3]));
  activeFake.emit(new Uint8Array([0xa9]));
  activeFake.emit("!");
  const rec = pty.getBufferRecording(id);
  assert.equal(rec.cols, 90);
  assert.equal(rec.rows, 25);
  assert.equal(rec.sandboxName, "x");
  assert.equal(
    rec.chunks.map((c) => c.data).join(""),
    "é!",
    "streaming decode across chunks reproduces the merged decode",
  );
  assert.ok(
    rec.chunks.every((c) => Number.isFinite(c.t) && c.t >= 0),
    "every chunk carries a finite, non-negative timestamp",
  );
});

test("getBufferRecording: timestamps stay parallel to the buffer after eviction", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  activeFake.emit("START" + "a".repeat(400_000));
  activeFake.emit("b".repeat(400_000)); // pushes total over the cap
  activeFake.emit("ENDMARKER");
  const rec = pty.getBufferRecording(id);
  // The eviction must shift buffer and bufferTimes in lockstep, or every
  // surviving chunk would be stamped with an older chunk's arrival time.
  assert.equal(
    rec.chunks.length,
    2,
    "one chunk evicted, two retained",
  );
  assert.equal(rec.chunks.map((c) => c.data).join(""), pty.getBuffer(id));
});

test("getBufferRecording: returns null for an unknown session", () => {
  assert.equal(pty.getBufferRecording("not-a-real-id"), null);
});

// ── flow control (renderer backpressure) ───────────────────────────────

test("pauseSession/resumeSession: throttle the transport, idempotently", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.pauseSession(id), true);
  assert.equal(pty.pauseSession(id), false, "second pause is a no-op");
  assert.equal(pty.listSessions()[0].paused, true);
  assert.equal(pty.resumeSession(id), true);
  assert.equal(pty.resumeSession(id), false, "second resume is a no-op");
  assert.equal(pty.listSessions()[0].paused, false);
  assert.deepEqual(activeFake.events.flow, ["pause", "resume"]);
});

test("pauseSession: no-op on an exited session and on an unknown id", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  activeFake.exit(0);
  assert.equal(pty.pauseSession(id), false);
  assert.equal(pty.pauseSession("not-a-real-id"), false);
  assert.deepEqual(activeFake.events.flow, []);
});

test("detachSession: resumes a paused session so the agent is never left blocked", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.pauseSession(id);
  pty.detachSession(id);
  // The renderer that applied the backpressure is gone, so nothing would ever
  // call resumeSession() — detach must release it or the agent stays blocked
  // on write for the whole time the user is away.
  assert.equal(pty.listSessions()[0].paused, false);
  assert.deepEqual(activeFake.events.flow, ["pause", "resume"]);
});

test("attachHandlers: resumes flow so a fresh renderer starts unthrottled", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.pauseSession(id);
  pty.attachHandlers(id, { onData: () => {} });
  assert.equal(pty.listSessions()[0].paused, false);
});

test("pause/resume: tolerates a transport without pause() (legacy stubs)", async () => {
  // IPtyLike.pause/resume are optional, so a spawn impl that predates flow
  // control must still bookkeep correctly rather than throw.
  pty.__testing.installSpawnImpl(async () => ({
    pid: 1,
    write() {},
    resize() {},
    kill() {},
    onData() {
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
  }));
  const { id } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.pauseSession(id), true);
  assert.equal(pty.resumeSession(id), true);
});

// ── findSessionBySandbox ────────────────────────────────────────────────

test("findSessionBySandbox: returns the session matching the sandbox name", async () => {
  const { id } = await pty.openSession({ sandboxName: "alpha" });
  await pty.openSession({ sandboxName: "bravo" });
  const found = pty.findSessionBySandbox("alpha");
  assert.ok(found);
  assert.equal(found.id, id);
  assert.equal(found.sandboxName, "alpha");
});

test("findSessionBySandbox: returns null for an unknown sandbox", async () => {
  await pty.openSession({ sandboxName: "alpha" });
  assert.equal(pty.findSessionBySandbox("nope"), null);
});

// ── detachSession ───────────────────────────────────────────────────────

test("detachSession: keeps the PTY alive, stops routing to the old handler, keeps buffering", async () => {
  const initial = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => initial.push(d),
  });
  activeFake.emit("before");
  const ok = pty.detachSession(id);
  assert.equal(ok, true);
  activeFake.emit("after");
  // Old handler no longer receives data...
  assert.deepEqual(initial, ["before"]);
  // ...but the wsl child is NOT killed and the buffer keeps growing.
  assert.equal(activeFake.events.kills.length, 0);
  assert.equal(pty.listSessions().length, 1);
  assert.equal(pty.getBuffer(id), "beforeafter");
});

test("detachSession: returns false for an unknown session", () => {
  assert.equal(pty.detachSession("not-a-real-id"), false);
});

test("detach then re-attach replays history and routes new output to the new handler", async () => {
  const first = [];
  const second = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => first.push(d),
  });
  activeFake.emit("history");
  pty.detachSession(id);
  pty.attachHandlers(id, { onData: (d) => second.push(d) });
  activeFake.emit("live");
  assert.deepEqual(first, ["history"]);
  assert.deepEqual(second, ["live"]);
  assert.equal(pty.getBuffer(id), "historylive");
});

// ── openSession adoption / idempotency ──────────────────────────────────

test("openSession: reuses a live session for the same sandbox instead of spawning twice", async () => {
  const { id: id1, reused: reused1 } = await pty.openSession({
    sandboxName: "x",
  });
  assert.equal(reused1, false);
  const { id: id2, reused: reused2 } = await pty.openSession({
    sandboxName: "x",
  });
  assert.equal(reused2, true);
  assert.equal(id2, id1);
  assert.equal(pty.__testing.getSessionCount(), 1);
});

test("openSession: discards a dead (exited) session and spawns a fresh one", async () => {
  const { id: id1 } = await pty.openSession({ sandboxName: "x" });
  activeFake.exit(0); // session retained but dead
  const { id: id2, reused } = await pty.openSession({ sandboxName: "x" });
  assert.equal(reused, false); // not adopted — a fresh PTY was spawned
  assert.notEqual(id2, id1);
  assert.equal(pty.__testing.getSessionCount(), 1);
});

test("openSession: adopts a live PTY only for the SAME agent session", async () => {
  const { id: id1, reused: r1 } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  assert.equal(r1, false);
  const { id: id2, reused: r2 } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  assert.equal(r2, true, "same session must re-attach losslessly");
  assert.equal(id2, id1);
  assert.equal(pty.__testing.getSessionCount(), 1);
});

test("openSession: agent sessions are CONCURRENT — a different session gets its own PTY and never disturbs the first", async () => {
  const { id: id1 } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  const fakeA = activeFake;
  const { id: id2, reused } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_b",
  });
  assert.equal(reused, false, "different session must NOT be adopted");
  assert.notEqual(id2, id1);
  // The first session's agent keeps working — no kill, both PTYs live.
  assert.equal(fakeA.events.kills.length, 0, "ses_a must keep running");
  assert.equal(pty.__testing.getSessionCount(), 2);
  const byAgent = Object.fromEntries(
    pty.listSessions().map((s) => [s.agentSessionId, s.id]),
  );
  assert.equal(byAgent.ses_a, id1);
  assert.equal(byAgent.ses_b, id2);
  // ses_a's PTY still streams to its own handler after ses_b opened.
  const late = [];
  pty.attachHandlers(id1, { onData: (d) => late.push(d) });
  fakeA.emit("still-alive");
  assert.deepEqual(late, ["still-alive"]);
});

test("findSessionBySandboxAndAgent: scopes lookups to the (sandbox, session) pair", async () => {
  const { id: idA } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  const { id: idB } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_b",
  });
  const { id: idNull } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.findSessionBySandboxAndAgent("x", "ses_a")?.id, idA);
  assert.equal(pty.findSessionBySandboxAndAgent("x", "ses_b")?.id, idB);
  assert.equal(pty.findSessionBySandboxAndAgent("x", null)?.id, idNull);
  assert.equal(pty.findSessionBySandboxAndAgent("x", "ses_missing"), null);
  assert.equal(pty.findSessionBySandboxAndAgent("other", "ses_a"), null);
});

test("openSession: reconnecting a session whose PTY died replaces only that PTY", async () => {
  const { id: idA } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  const fakeA = activeFake;
  await pty.openSession({ sandboxName: "x", agentSessionId: "ses_b" });
  const fakeB = activeFake;
  fakeA.exit(0); // ses_a dies; ses_b keeps working
  const { id: idA2, reused } = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
  });
  assert.equal(reused, false);
  assert.notEqual(idA2, idA);
  assert.equal(fakeB.events.kills.length, 0, "ses_b must keep running");
  assert.equal(pty.__testing.getSessionCount(), 2);
});

test("closeSessionsForSandbox: kills every PTY of one sandbox, leaves others", async () => {
  const lifecycle = [];
  await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_a",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeA = activeFake;
  await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_b",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeB = activeFake;
  await pty.openSession({ sandboxName: "y", agentSessionId: "ses_c" });
  const fakeC = activeFake;
  const closed = pty.closeSessionsForSandbox("x");
  assert.equal(closed, 2);
  assert.deepEqual(fakeA.events.kills, ["SIGTERM"]);
  assert.deepEqual(fakeB.events.kills, ["SIGTERM"]);
  assert.equal(fakeC.events.kills.length, 0);
  assert.equal(pty.listSessions().length, 1);
  assert.equal(pty.listSessions()[0].sandboxName, "y");

  fakeA.exit(null, "SIGTERM");
  fakeB.exit(null, "SIGTERM");
  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every((event) => event.terminationCause === "sandbox-delete"));
  assert.ok(lifecycle.every((event) => typeof event.closeRequestedAt === "number"));
});

test("closeSessionsForSandbox records Haloop token rotation as the termination cause", async () => {
  const lifecycle = [];
  await pty.openSession({
    sandboxName: "rotate-me",
    agentSessionId: "ses_rotate",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fake = activeFake;

  assert.equal(
    pty.closeSessionsForSandbox("rotate-me", "haloop-token-rotation"),
    1,
  );
  fake.exit(null, "SIGTERM");

  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].terminationCause, "haloop-token-rotation");
});

test("closeAllSessions records an OpenShell reset for every tracked agent", async () => {
  const lifecycle = [];
  await pty.openSession({
    sandboxName: "reset-a",
    agentSessionId: "ses_reset_a",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeA = activeFake;
  await pty.openSession({
    sandboxName: "reset-b",
    agentSessionId: "ses_reset_b",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeB = activeFake;

  assert.equal(pty.closeAllSessions("openshell-reset"), 2);
  fakeA.exit(null, "SIGTERM");
  fakeB.exit(null, "SIGTERM");

  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every((event) => event.terminationCause === "openshell-reset"));
});

test("openSession: preserves and enforces the host-issued Haloop conversation context", async () => {
  const first = await pty.openSession({
    sandboxName: "x",
    agentSessionId: "ses_context",
    haloopContextId: "12".repeat(16),
  });
  assert.equal(
    pty.findSessionBySandboxAndAgent("x", "ses_context")?.haloopContextId,
    "12".repeat(16),
  );
  await assert.rejects(
    () =>
      pty.openSession({
        sandboxName: "x",
        agentSessionId: "ses_context",
        haloopContextId: "34".repeat(16),
      }),
    /Haloop conversation context mismatch/,
  );
  assert.equal(pty.__testing.getSession(first.id)?.haloopContextId, "12".repeat(16));
});

test("listSessions: reports agentSessionId (null when unspecified)", async () => {
  await pty.openSession({ sandboxName: "x", agentSessionId: "ses_z" });
  await pty.openSession({ sandboxName: "y" });
  const byName = Object.fromEntries(
    pty.listSessions().map((s) => [s.sandboxName, s.agentSessionId]),
  );
  assert.equal(byName.x, "ses_z");
  assert.equal(byName.y, null);
});

// ── terminal bell is NOT an attention signal ──────────────────────────

test("BEL is passed through as ordinary bytes and sets no status flag", async () => {
  // A bell used to mark the sandbox "waiting for you", but Claude Code rings
  // during a healthy startup, so every new session immediately claimed it was
  // blocked. The bell must now be inert: forwarded to xterm and nothing else.
  const received = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => received.push(d),
  });
  activeFake.emit("welcome back \u0007");
  assert.deepEqual(received, ["welcome back \u0007"]);
  assert.equal(pty.getBuffer(id), "welcome back \u0007");
  const [session] = pty.listSessions();
  assert.equal(session.attention, undefined);
  assert.equal(session.attentionAt, undefined);
});

// ── attachHandlers ─────────────────────────────────────────────

test("attachHandlers: replaces the onData handler for a live session", async () => {
  const initial = [];
  const replacement = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => initial.push(d),
  });
  activeFake.emit("first");
  pty.attachHandlers(id, { onData: (d) => replacement.push(d) });
  activeFake.emit("second");
  assert.deepEqual(initial, ["first"]);
  assert.deepEqual(replacement, ["second"]);
});

test("attachHandlers: leaves the existing handler in place when not specified", async () => {
  const received = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => received.push(d),
  });
  pty.attachHandlers(id, {}); // no replacement
  activeFake.emit("still-routed");
  assert.deepEqual(received, ["still-routed"]);
});

test("attachHandlers: returns false for unknown session", () => {
  assert.equal(
    pty.attachHandlers("not-a-real-id", { onData: () => {} }),
    false,
  );
});

// ── closeAllSessions ───────────────────────────────────────────────────

test("closeAllSessions: kills every live PTY", async () => {
  const lifecycle = [];
  await pty.openSession({
    sandboxName: "a",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeA = activeFake;
  await pty.openSession({
    sandboxName: "b",
    onLifecycleExit: (event) => lifecycle.push(event),
  });
  const fakeB = activeFake;
  assert.equal(pty.listSessions().length, 2);
  pty.closeAllSessions();
  assert.deepEqual(fakeA.events.kills, ["SIGTERM"]);
  assert.deepEqual(fakeB.events.kills, ["SIGTERM"]);
  fakeA.exit(null, "SIGTERM");
  fakeB.exit(null, "SIGTERM");
  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every((event) => event.terminationCause === "app-shutdown"));
});

// ── multiple sessions don't cross-talk ────────────────────────────────

test("multiple sessions track distinct IPty instances", async () => {
  const aData = [];
  const bData = [];
  const { id: idA } = await pty.openSession({
    sandboxName: "alpha",
    onData: (d) => aData.push(d),
  });
  const fakeA = activeFake;
  const { id: idB } = await pty.openSession({
    sandboxName: "bravo",
    onData: (d) => bData.push(d),
  });
  const fakeB = activeFake;
  assert.notEqual(idA, idB);
  fakeA.emit("only-a");
  fakeB.emit("only-b");
  assert.deepEqual(aData, ["only-a"]);
  assert.deepEqual(bData, ["only-b"]);
});
