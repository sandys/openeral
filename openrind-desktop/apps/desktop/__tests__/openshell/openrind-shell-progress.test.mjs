// Loading-screen progress labels for the sandbox bootstrap.
//
// Why this test exists: the loading screen used to show ONE static message for
// the whole 40-70s prewarm ("Preparing OpenClaw runtime…") and then
// "Sandbox <name> ready." while the agent was still booting. Users read that as
// a hang. The fix streams setup.sh / openclaw-launch.sh output through
// labelForSetupLine() into the overlay.
//
// That coupling is invisible at compile time: rewording an echo in setup.sh
// silently drops its step from the loading screen. These cases are copied
// VERBATIM from lines the sandbox scripts actually print, so a reword fails here
// instead of quietly regressing the UX.

import test from "node:test";
import assert from "node:assert/strict";

const openrindShell = await import(
  "../../electron/openshell/openrind-shell.mjs"
);
const {
  labelForSetupLine,
  rawSetupLine,
  formatElapsed,
  buildPrewarmScript,
  PREWARM_EXIT_IMAGE_TOO_OLD,
  SETUP_HANDOVER_RE,
} = openrindShell.__testing;

// [ line as printed, substring the label must contain ]
const CASES = [
  // ── prewarm wrapper (openrind-shell.mjs) ────────────────────────────────
  ["prewarm: sandbox reachable", "Sandbox reachable"],
  ["prewarm: gateway already healthy", "already running"],
  // ── setup.sh (both agents) ──────────────────────────────────────────
  ["setup.sh: loaded DATABASE_URL from uploaded /sandbox/db-url", "database credentials"],
  [
    "setup.sh: database connection failed: http-connect-socket: tunnel to db:5432 denied",
    "tunnel to db:5432 denied",
  ],
  ["setup.sh: running migrations, seeding, and restoring workspace...", "migrations"],
  [
    "setup.sh: using external PostgreSQL at aws-1-ap-southeast-2.pooler.supabase.com:5432",
    "aws-1-ap-southeast-2.pooler.supabase.com:5432",
  ],
  ["setup.sh: migrations complete", "seeding workspace"],
  ["setup.sh: workspace seeded", "restoring files"],
  ["setup.sh: restored 744 workspace entries", "744"],
  ["setup.sh: flushing /home/agent to workspace...", "Saving workspace"],
  ["setup.sh: flushed 743 workspace entries", "743"],
  ["setup.sh: starting openrind-shell-bash daemon...", "file-sync daemon"],
  ["setup.sh: daemon ready (pid 303)", "daemon ready"],
  ["setup.sh: writing OpenrindGateway proxy to ~/.claude/settings.json...", "Openrind Gateway proxy"],
  ["setup.sh: creating a permanent OpenrindGateway presign for openclaw...", "Openrind Gateway token"],
  ["setup.sh: presign stored at /home/agent/.openrind-shell/presign.json", "token ready"],
  // ── Claude Code ──────────────────────────────────────────────────────────
  ["setup.sh: launching Claude Code...", "Claude Code"],
  ["setup.sh: Claude CLI not found, installing...", "Installing the Claude CLI"],
  // ── openclaw-launch.sh ───────────────────────────────────────────────────
  ["openclaw-launch: seeded V8 compile cache from image", "bytecode cache"],
  ["openclaw-launch: seeded plugin runtime deps from image", "plugin dependencies"],
  ["openclaw-launch: config valid at tier=full", "full"],
  ["openclaw-launch: starting gateway on 127.0.0.1:18789", "Starting the OpenClaw gateway"],
  ["openclaw: waiting for the gateway to become ready (30s/180s)", "30s"],
  ["openclaw-launch: gateway ready after 12s", "12s"],
  ["openclaw-launch: reusing already-ready gateway on :18789", "Reusing"],
  ["openclaw: verifying the OpenClaw connection (usually ~30s)", "Verifying"],
  ["openclaw: verifying the OpenClaw connection (attempt 2 of 3)", "attempt 2 of 3"],
  ["openclaw: OpenClaw connection verified", "verified"],
  ["openclaw: repairing OpenClaw configuration", "Repairing"],
  ["openclaw: gateway did not come up — running one repair pass", "repair pass"],
];

test("every real bootstrap line maps to a loading-screen label", () => {
  for (const [line, expected] of CASES) {
    const label = labelForSetupLine(line);
    assert.ok(
      label,
      `no label rule matches a line the sandbox actually prints:\n  ${line}\n` +
        `Add a rule to SETUP_PROGRESS_LABELS, or the loading screen goes silent for this step.`,
    );
    assert.ok(
      label.toLowerCase().includes(expected.toLowerCase()),
      `label for "${line}" should mention "${expected}" but was "${label}"`,
    );
  }
});

test("labels interpolate the captured detail rather than dropping it", () => {
  assert.match(labelForSetupLine("setup.sh: restored 12345 workspace entries"), /12345/);
  assert.match(labelForSetupLine("openclaw-launch: gateway ready after 7s"), /7s/);
  assert.match(labelForSetupLine("openclaw-launch: config valid at tier=minimal"), /minimal/);
});

test("internal bookkeeping lines are deliberately hidden", () => {
  // Hidden, not unlabelled: showing this to a user says nothing useful.
  assert.equal(
    labelForSetupLine("openclaw-launch: setup-only mode — gateway ready on :18789"),
    null,
  );
});

test("unrecognised lines yield no label instead of leaking raw output", () => {
  assert.equal(labelForSetupLine("+ set -euo pipefail"), null);
  assert.equal(labelForSetupLine(""), null);
});

test("handover markers stop the log follower for both agents", () => {
  assert.ok(SETUP_HANDOVER_RE.test("setup.sh: launching Claude Code..."));
  assert.ok(
    SETUP_HANDOVER_RE.test("openclaw-launch: authenticated gateway round trip ok"),
  );
  assert.ok(!SETUP_HANDOVER_RE.test("setup.sh: migrations complete"));
});

// An unlabelled line used to leave the overlay on ONE fixed string for the whole
// prewarm, with only a seconds counter moving — indistinguishable from a hang.
// rawSetupLine is the fallback that keeps the status honest, so it has to be
// readable, prefix-free, bounded, and escape-free.
test("unlabelled lines still produce a readable status", () => {
  assert.equal(
    rawSetupLine("setup: using /opt/openrind-shell directly"),
    "using /opt/openrind-shell directly",
  );
  assert.equal(
    rawSetupLine("openclaw-launch: pruning stale plugin stage dir"),
    "pruning stale plugin stage dir",
  );
  // The overlay is not a terminal: no escape sequence may reach it.
  assert.equal(rawSetupLine("\u001b[32msetup.sh: all good\u001b[0m"), "all good");
  assert.doesNotMatch(rawSetupLine("\u001b[1;33mworking\u001b[0m") ?? "", /\u001b/);
});

test("noise never becomes the on-screen status", () => {
  for (const line of [
    "",
    "   ",
    "+ set -euo pipefail",
    "npm WARN deprecated foo@1.0.0",
    "(node:412) ExperimentalWarning: something",
    "setup.sh:",
  ]) {
    assert.equal(rawSetupLine(line), null, `should be treated as noise: ${line}`);
  }
});

test("a long line is truncated so the overlay cannot be blown out", () => {
  const status = rawSetupLine(`setup.sh: ${"x".repeat(400)}`);
  assert.ok(status.length <= 88, `too long: ${status.length}`);
  assert.match(status, /…$/);
});

// A bare "(469s)" is what the stuck-looking screen showed. Minutes read as
// progress; a four-hundred-something second count reads as a stall.
test("elapsed time is formatted for humans past a minute", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(37), "37s");
  assert.equal(formatElapsed(59), "59s");
  assert.equal(formatElapsed(60), "1m00s");
  assert.equal(formatElapsed(469), "7m49s");
});

// sandboxRunScriptCmd pipes the prewarm script into `sh` (dash on this image).
// `${PIPESTATUS[0]}` there printed "Bad substitution" and exited 2, so EVERY
// successful OpenClaw prewarm reported failure and the loading screen accused a
// working DATABASE_URL of being unreachable. The failure is silent by nature —
// the error lands in a log nobody reads — so it has to be caught here.
test("the prewarm script is POSIX sh, not bash", () => {
  for (const isClaude of [true, false]) {
    const script = buildPrewarmScript({ isClaude });
    const label = isClaude ? "claude" : "openclaw";
    assert.doesNotMatch(script, /PIPESTATUS/, `${label}: PIPESTATUS is bash-only`);
    assert.doesNotMatch(script, /\[\[/, `${label}: [[ is bash-only`);
    assert.doesNotMatch(script, /\blocal\s/, `${label}: 'local' is not POSIX`);
    assert.doesNotMatch(script, /=\(/, `${label}: arrays are bash-only`);
    assert.doesNotMatch(script, /\bfunction\s+\w+\s*\(/, `${label}: bash function syntax`);
    // Every path must terminate with an explicit exit code: prewarmAgentRuntime
    // decides what to show from it.
    assert.match(script, /^exit /m, `${label}: must exit explicitly`);
  }
});

test("the OpenClaw prewarm preflights the image before doing any work", () => {
  const script = buildPrewarmScript({ isClaude: false });
  const lines = script.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  // The reachability ping must be the very first thing that runs, so "no output
  // yet" can be attributed to the sandbox rather than to setup.sh.
  assert.match(lines[0], /echo 'prewarm: sandbox reachable'/);
  // The image check must come before setup.sh is ever invoked.
  const guardAt = script.indexOf("openclaw-launch.sh");
  const runAt = script.indexOf("openrind-shell 2>&1");
  assert.ok(guardAt > -1 && runAt > -1 && guardAt < runAt, "preflight must precede setup.sh");
  assert.match(script, new RegExp(`exit ${PREWARM_EXIT_IMAGE_TOO_OLD}\\b`));
  // The launcher's own budgets must be tightened for the prewarm, or its 420s
  // ceiling outlives the 300s the overlay allows and gets cut off mid-step.
  assert.match(script, /OPENCLAW_GATEWAY_READY_TIMEOUT/);
  assert.match(script, /OPENCLAW_LAUNCH_BUDGET/);
});
