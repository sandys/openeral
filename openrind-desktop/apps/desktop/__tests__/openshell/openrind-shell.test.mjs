// Unit tests for apps/desktop/electron/openshell/openrind-shell.mjs.
//
// Uses the same mock-wsl.sh as wsl.test.mjs / doctor.test.mjs to record
// argv and emit canned stdout. Credentials are stubbed via the
// OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR env seam baked into
// openrind-shell-credentials.mjs (plain-file storage; no Electron required).
//
// The actual docker pull + openshell sandbox create round-trip lives in
// the Phase 10 E2E spec — these unit tests verify only the argv shape,
// the validation logic, and the orchestration between sub-steps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let logPath;
let credsDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openrind-shell-test-"));
  logPath = join(workDir, "wsl-args.log");
  credsDir = join(workDir, "creds");
  process.env.OPENRIND_DESKTOP_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR = credsDir;
  process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE = join(
    workDir,
    "creds-prod-fallback.json",
  );
  for (const key of [
    "MOCK_WSL_STDOUT",
    "MOCK_WSL_STDOUT_FILE",
    "MOCK_WSL_STDERR",
    "MOCK_WSL_EXIT",
    "MOCK_WSL_DELAY_MS",
    "MOCK_WSL_DELAY_BEFORE_MS",
    "OPENRIND_DESKTOP_SANDBOX_IMAGE",
    "OPENRIND_DESKTOP_SANDBOX_SKIP_PULL",
  ]) {
    delete process.env[key];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENRIND_DESKTOP_WSL_EXE;
  delete process.env.MOCK_WSL_LOG;
  delete process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR;
  delete process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE;
});

function readArgsLog() {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const openrindShell = await import("../../electron/openshell/openrind-shell.mjs");
const credentials =
  await import("../../electron/openshell/openrind-shell-credentials.mjs");

// ── Pure helpers ───────────────────────────────────────────────────────

test("imageForProfile: maps claude profile to openrind image", () => {
  assert.equal(
    openrindShell.imageForProfile("openrind-shell-claude"),
    "ghcr.io/openrind/openrind-shell/sandbox:just-bash",
  );
});

test("imageForProfile: maps openclaw profile to openrind image (same as claude)", () => {
  // openrind-shell README: same image, only --provider differs.
  assert.equal(
    openrindShell.imageForProfile("openrind-shell-openclaw"),
    "ghcr.io/openrind/openrind-shell/sandbox:just-bash",
  );
});

test("imageForProfile: OPENRIND_DESKTOP_SANDBOX_IMAGE overrides both profiles", () => {
  process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE = "openrind-shell-local/sandbox:openclaw-test";
  try {
    assert.equal(
      openrindShell.imageForProfile("openrind-shell-claude"),
      "openrind-shell-local/sandbox:openclaw-test",
    );
    assert.equal(
      openrindShell.imageForProfile("openrind-shell-openclaw"),
      "openrind-shell-local/sandbox:openclaw-test",
    );
  } finally {
    delete process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE;
  }
});

test("imageForProfile: throws on unknown profile", () => {
  assert.throws(
    () => openrindShell.imageForProfile("openrind-shell-unknown"),
    /Unknown Openrind Shell profile/,
  );
});

// ── imageExistsLocally ─────────────────────────────────────────────────
// Guards the create-path optimization that skips `docker pull` when the image
// is already cached in the distro (a `docker image inspect`, no registry
// round-trip). See createOpenrindShellSandbox.

test("imageExistsLocally: true when `docker image inspect` exits 0", async () => {
  process.env.MOCK_WSL_EXIT = "0";
  const present = await openrindShell.imageExistsLocally(
    "ghcr.io/openrind/openrind-shell/sandbox:just-bash",
  );
  assert.equal(present, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1, "exactly one wsl call (a local inspect)");
  // Local metadata lookup only — must not shell out to `docker pull`.
  assert.match(lines[0], /docker --config .* image inspect/);
  assert.doesNotMatch(lines[0], /docker .*pull/);
  assert.match(
    lines[0],
    /ghcr\.io\/openrind\/openrind-shell\/sandbox:just-bash/,
  );
});

test("imageExistsLocally: false when `docker image inspect` exits non-zero", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  const present = await openrindShell.imageExistsLocally("nope/missing:tag");
  assert.equal(present, false);
});

// ── buildWslEnvForwarding ──────────────────────────────────────────────

test("buildWslEnvForwarding: extends WSLENV with forwarded names", () => {
  const env = openrindShell.__testing.buildWslEnvForwarding({
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENRIND_SHELL_AGENT: "openclaw",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(env.OPENRIND_SHELL_AGENT, "openclaw");
  const names = env.WSLENV.split(":").filter(Boolean);
  assert.ok(names.includes("ANTHROPIC_API_KEY"));
  assert.ok(names.includes("OPENRIND_SHELL_AGENT"));
});

test("buildWslEnvForwarding: preserves existing WSLENV entries", () => {
  const prev = process.env.WSLENV;
  process.env.WSLENV = "EXISTING_VAR";
  try {
    const env = openrindShell.__testing.buildWslEnvForwarding({ FOO: "bar" });
    const names = env.WSLENV.split(":").filter(Boolean);
    assert.ok(
      names.includes("EXISTING_VAR"),
      `expected EXISTING_VAR in ${env.WSLENV}`,
    );
    assert.ok(names.includes("FOO"), `expected FOO in ${env.WSLENV}`);
  } finally {
    if (prev === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prev;
  }
});

// ── createOpenrindGatewayPresign ────────────────────────────────────────────

test("createOpenrindGatewayPresign: posts the canonical body and returns the url", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          url: "https://proxy.openrind.com/openrind-gateway-proxy/t/abc123/v1/messages",
        };
      },
      async text() {
        return "";
      },
    };
  };
  try {
    const url = await openrindShell.__testing.createOpenrindGatewayPresign({
      anthropicApiKey: "test-anthropic-api-key",
      openrindGatewayApiKey: "test-openrind-gateway-api-key",
      agentLabel: "claude-code",
    });
    assert.equal(
      url,
      "https://proxy.openrind.com/openrind-gateway-proxy/t/abc123/v1/messages",
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/presign$/);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      calls[0].init.headers.Authorization,
      "Bearer test-openrind-gateway-api-key",
    );
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.provider, "anthropic");
    assert.equal(body.client_api_key, "test-anthropic-api-key");
    assert.deepEqual(body.path, ["/v1/messages"]);
    // metadata.labels is what OpenrindGateway's vendor-portfolio classifier reads.
    assert.deepEqual(body.metadata.labels, ["openrind-shell", "claude-code"]);
    assert.equal(body.metadata.client, "claude-code");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createOpenrindGatewayPresign: labels openclaw spend distinctly", async () => {
  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { url: "https://x/openrind-gateway-proxy/t/z" };
      },
      async text() {
        return "";
      },
    };
  };
  try {
    await openrindShell.__testing.createOpenrindGatewayPresign({
      anthropicApiKey: "sk-ant-test",
      openrindGatewayApiKey: "sk-st-test",
      agentLabel: "openclaw",
    });
    assert.deepEqual(captured.metadata.labels, ["openrind-shell", "openclaw"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createOpenrindGatewayPresign: returns null on a non-2xx response", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return "unauthorized";
    },
    async json() {
      return {};
    },
  });
  try {
    const url = await openrindShell.__testing.createOpenrindGatewayPresign({
      anthropicApiKey: "sk-ant-test",
      openrindGatewayApiKey: "bad-key",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createOpenrindGatewayPresign: returns null when the response carries no url", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { not_a_url: true };
    },
    async text() {
      return "";
    },
  });
  try {
    const url = await openrindShell.__testing.createOpenrindGatewayPresign({
      anthropicApiKey: "sk-ant-test",
      openrindGatewayApiKey: "sk-st-test",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createOpenrindGatewayPresign: returns null (does not throw) when fetch rejects", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const url = await openrindShell.__testing.createOpenrindGatewayPresign({
      anthropicApiKey: "sk-ant-test",
      openrindGatewayApiKey: "sk-st-test",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── openrindGatewayBaseUrlForAgent ──────────────────────────────────────────

test("openrindGatewayBaseUrlForAgent: strips the /v1/messages the agent re-appends", () => {
  // The control plane mints a single-path presign URL ending in /v1/messages.
  // Claude Code / OpenClaw append /v1/messages themselves, so the base URL we
  // hand them must NOT include it (else the proxy sees /v1/messages/v1/messages
  // and returns "Path not authorized").
  assert.equal(
    openrindShell.__testing.openrindGatewayBaseUrlForAgent(
      "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123/v1/messages",
    ),
    "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123",
  );
});

test("openrindGatewayBaseUrlForAgent: drops a trailing slash (adapter-token shape)", () => {
  assert.equal(
    openrindShell.__testing.openrindGatewayBaseUrlForAgent(
      "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123/",
    ),
    "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123",
  );
});

test("openrindGatewayBaseUrlForAgent: leaves an already-bare base URL untouched", () => {
  assert.equal(
    openrindShell.__testing.openrindGatewayBaseUrlForAgent(
      "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123",
    ),
    "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK123",
  );
});

test("openrindGatewayBaseUrlForAgent: accepts a self-hosted host:port shape", () => {
  assert.equal(
    openrindShell.__testing.openrindGatewayBaseUrlForAgent(
      "http://10.0.0.5:8787/openrind-gateway-proxy/t/TOK/v1/messages",
    ),
    "http://10.0.0.5:8787/openrind-gateway-proxy/t/TOK",
  );
});

test("openrindGatewayBaseUrlForAgent: returns null for non-OpenrindGateway / empty input", () => {
  assert.equal(
    openrindShell.__testing.openrindGatewayBaseUrlForAgent(
      "https://api.anthropic.com/v1/messages",
    ),
    null,
  );
  assert.equal(openrindShell.__testing.openrindGatewayBaseUrlForAgent(""), null);
  assert.equal(openrindShell.__testing.openrindGatewayBaseUrlForAgent(null), null);
});

// ── sandboxRunScriptCmd ────────────────────────────────────────────────

test("sandboxRunScriptCmd: base64-encodes the script so it round-trips in the sandbox", () => {
  const script = 'echo hi\nexport FOO="a b"\nunset BAR';
  const cmd = openrindShell.__testing.sandboxRunScriptCmd("openrind-shell-ws1", script);
  // Targets the named sandbox via exec.
  assert.match(cmd, /openshell sandbox exec --name 'openrind-shell-ws1' --/);
  // Decodes through base64 -d | sh — no raw script chars on the command line.
  assert.match(cmd, /base64 -d \| sh/);
  // The embedded blob decodes back to exactly the input script. shellQuote is
  // applied twice (once for the blob, once for the `sh -c` arg) so the base64
  // rides inside `'\''…'\''` — just grab the longest base64 run and decode it.
  const runs = cmd.match(new RegExp("[A-Za-z0-9+/=]{12,}", "g")) || [];
  const b64 = runs.sort((a, b) => b.length - a.length)[0];
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), script);
});

// ── sandboxExists ──────────────────────────────────────────────────────

test("sandboxExists: returns true when the sandbox is in the list", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([
    { name: "openrind-shell-foo" },
    { name: "openrind-shell-bar" },
  ]);
  assert.equal(await openrindShell.sandboxExists("openrind-shell-foo"), true);
});

test("sandboxExists: returns false when not present", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "something-else" }]);
  assert.equal(await openrindShell.sandboxExists("openrind-shell-foo"), false);
});

test("sandboxExists: accepts plain-string list entries", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify(["openrind-shell-foo"]);
  assert.equal(await openrindShell.sandboxExists("openrind-shell-foo"), true);
});

test("sandboxExists: returns false when list command fails", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  assert.equal(await openrindShell.sandboxExists("openrind-shell-foo"), false);
});

test("sandboxExists: returns false on empty input", async () => {
  assert.equal(await openrindShell.sandboxExists(""), false);
});

// ── createOpenrindShellSandbox ──────────────────────────────────────────────

test("createOpenrindShellSandbox: throws when DATABASE_URL is unconfigured", async () => {
  await assert.rejects(
    () =>
      openrindShell.createOpenrindShellSandbox({
        name: "openrind-shell-test",
        profile: "openrind-shell-claude",
        skipImagePull: true,
      }),
    /DATABASE_URL is not configured/,
  );
});

test("createOpenrindShellSandbox: throws when ANTHROPIC_API_KEY missing (any profile)", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await assert.rejects(
    () =>
      openrindShell.createOpenrindShellSandbox({
        name: "openrind-shell-test",
        profile: "openrind-shell-claude",
        skipImagePull: true,
      }),
    /ANTHROPIC_API_KEY is not configured/,
  );
});

test("createOpenrindShellSandbox: short-circuits when sandbox already exists", async () => {
  // listSandboxes returns our target name → existed=true, no create call.
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "openrind-shell-resume" }]);
  const result = await openrindShell.createOpenrindShellSandbox({
    name: "openrind-shell-resume",
    profile: "openrind-shell-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, true);
  // Only one wsl call: the list probe.
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox list --json/);
});

test("createOpenrindShellSandbox: claude profile builds canonical openrind-shell argv", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-test");
  // Mock always emits "[]" so sandbox list parses to empty.
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openrindShell.createOpenrindShellSandbox({
    name: "openrind-shell-new",
    profile: "openrind-shell-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, false);
  assert.equal(result.imageRef, "ghcr.io/openrind/openrind-shell/sandbox:just-bash");

  const lines = readArgsLog();

  // No `provider create` calls — the canonical flow uses --auto-providers
  // to pick up ANTHROPIC_API_KEY from the env at sandbox-create time.
  assert.equal(
    lines.filter((l) => /openshell provider create/.test(l)).length,
    0,
    "canonical openrind-shell flow does not call `provider create` ahead of time",
  );

  // The whole flow runs inside ONE bash -c invocation. The bash script
  // is multi-line, so the mock log splits it into separate lines —
  // assert on each line of the script independently.
  assert.ok(
    lines.some((l) => /cat > \/tmp\/openrind-shell-db-url-[\w-]+/.test(l)),
    "expected DATABASE_URL staging via `cat > /tmp/openrind-shell-db-url-<uuid>`",
  );
  assert.ok(
    lines.some((l) => /chmod 600 \/tmp\/openrind-shell-db-url-[\w-]+/.test(l)),
    "expected chmod 600 on the staging file",
  );
  assert.ok(
    lines.some((l) =>
      /trap 'rm -f \/tmp\/openrind-shell-db-url-[\w-]+' EXIT/.test(l),
    ),
    "expected EXIT trap to clean up staging file",
  );
  // Should not regress to the mktemp+command-substitution shape.
  assert.ok(
    !lines.some((l) => /mktemp .*\$\(/.test(l)),
    "should not use mktemp command-substitution (empty-variable trap)",
  );

  // Sandbox create matches the openrind-shell README exactly. The args we
  // splice via shellQuote (name, imageRef) appear single-quoted.
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine, `no create line. lines=${JSON.stringify(lines)}`);
  // --no-tty + `-- /bin/true`: create only provisions; the agent is launched
  // later via `sandbox connect` + the /sandbox/.bashrc block (no TTY here, so
  // running `-- openrind-shell` would deadlock on the agent's interactive prompt).
  assert.match(createLine, /sandbox create --no-tty/);
  assert.match(createLine, /--name 'openrind-shell-new'/);
  assert.match(
    createLine,
    /--from 'ghcr\.io\/openrind\/openrind-shell\/sandbox:just-bash'/,
  );
  assert.match(
    createLine,
    /--upload \/tmp\/openrind-shell-db-url-[\w-]+:\/sandbox\/db-url/,
  );
  assert.match(createLine, /--provider claude --auto-providers/);
  assert.match(createLine, /-- \/bin\/true$/);
  // Things that should NOT be there.
  assert.doesNotMatch(
    createLine,
    /--gateway/,
    "no --gateway flag in canonical flow",
  );
  assert.doesNotMatch(createLine, /--provider db/, "no explicit db provider");
});

test("createOpenrindShellSandbox: openclaw profile sets OPENRIND_SHELL_AGENT env via WSLENV", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-xxx");
  process.env.MOCK_WSL_STDOUT = "[]";
  await openrindShell.createOpenrindShellSandbox({
    name: "openrind-shell-claws",
    profile: "openrind-shell-openclaw",
    skipImagePull: true,
  });
  // We can't directly observe WSLENV from the mock log (it sets env
  // for wsl.exe, not in argv). buildWslEnvForwarding is exercised in
  // its own test above. Here just confirm the openclaw create line is
  // structurally identical to the claude path.
  const lines = readArgsLog();
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine);
  assert.match(createLine, /--name 'openrind-shell-claws'/);
  assert.match(createLine, /--provider claude --auto-providers/);
  assert.match(createLine, /-- \/bin\/true$/);
});

test("createOpenrindShellSandbox: requires name and profile", async () => {
  await assert.rejects(
    () => openrindShell.createOpenrindShellSandbox({ profile: "openrind-shell-claude" }),
    /name is required/,
  );
  await assert.rejects(
    () => openrindShell.createOpenrindShellSandbox({ name: "x" }),
    /profile is required/,
  );
});

// ── isGatewayWarmingError ──────────────────────────────────────────────
// Pure function — decides whether a failed `sandbox list` should be retried
// (gateway still warming up at cold start) vs. surfaced immediately.

test("isGatewayWarmingError: matches the cold-start transport error", () => {
  const warming = openrindShell.__testing.isGatewayWarmingError;
  // The exact multi-line shape the openshell CLI prints when the gateway
  // socket isn't listening yet (the error the sidebar/manager hit on restart).
  assert.equal(
    warming(
      "Error: × transport error ├─▶ tcp connect error ├─▶ tcp connect error ╰─▶ Connection refused (os error 111)",
    ),
    true,
  );
  assert.equal(warming("connection refused"), true);
  assert.equal(warming("os error 111"), true);
});

test("isGatewayWarmingError: does NOT match real CLI/usage errors", () => {
  const warming = openrindShell.__testing.isGatewayWarmingError;
  // A genuine failure must fail fast, not spin in the warmup retry loop.
  assert.equal(warming("error: unexpected argument '--json' found"), false);
  assert.equal(warming("sandbox not found"), false);
  assert.equal(warming(""), false);
  assert.equal(warming(undefined), false);
});

// ── buildLaunchBlock ───────────────────────────────────────────────────
// Pure function — no wslRun, no mock needed.

test("buildLaunchBlock (claude + proxy): delegates to setup.sh with gateway + session wiring", () => {
  const block = openrindShell.__testing.buildLaunchBlock(
    "openrind-shell-claude",
    "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK",
  );
  // Claude now delegates to the image's setup.sh (like openclaw) so it gets DB
  // migrations, workspace restore from PostgreSQL, and the openrind-shell-bash
  // sync daemon — i.e. persistence. setup.sh owns the OpenrindGateway wiring, so
  // the proxy is handed to it via OPENRIND_GATEWAY_PROXY_URL (setup.sh writes
  // ANTHROPIC_BASE_URL into ~/.claude/settings.json itself).
  assert.match(
    block,
    /export OPENRIND_GATEWAY_PROXY_URL=.*TOK/,
    "must hand the proxy URL to setup.sh",
  );
  // The .bashrc block must not re-implement the gateway/auth wiring inline —
  // that is setup.sh's job now.
  assert.doesNotMatch(block, /ANTHROPIC_BASE_URL/, "claude must not set ANTHROPIC_BASE_URL inline");
  assert.doesNotMatch(block, /openclaw gateway/, "claude must not start openclaw gateway");
  assert.doesNotMatch(block, /OPENRIND_SHELL_AGENT=openclaw/, "claude must not set the openclaw agent gate");
  // ~/.local/bin on PATH so setup.sh's `exec claude` resolves the native binary.
  assert.match(
    block,
    /export PATH="\$HOME\/\.local\/bin:\$PATH"/,
    "claude must put ~/.local/bin on PATH",
  );
  // Per-session binding: read + consume the marker, then hand the id to setup.sh,
  // which does the create-or-resume transcript probe AFTER restoring ~/.claude.
  assert.match(
    block,
    /\/sandbox\/openrind-desktop-current-session/,
    "claude must read the per-connect session marker",
  );
  assert.match(
    block,
    /rm -f \/sandbox\/openrind-desktop-current-session/,
    "claude must consume the marker on read",
  );
  assert.match(
    block,
    /export OPENRIND_DESKTOP_CLAUDE_SESSION="\$_ow_sid"/,
    "claude must hand the session id to setup.sh",
  );
  // Delegates to setup.sh (full bootstrap) rather than launching Claude bare —
  // a bare `exec claude` skips all PostgreSQL persistence.
  assert.match(block, /exec openrind-shell/, "claude must delegate to setup.sh for persistence");
  assert.doesNotMatch(block, /exec claude/, "claude must not bypass setup.sh with a bare exec claude");
});

test("deriveClaudeSessionUuid: deterministic, valid v5 UUID for opencode ids", () => {
  const a = openrindShell.__testing.deriveClaudeSessionUuid("ses_abc123");
  const b = openrindShell.__testing.deriveClaudeSessionUuid("ses_abc123");
  const c = openrindShell.__testing.deriveClaudeSessionUuid("ses_different");
  assert.equal(a, b, "same input must map to the same UUID (stable resume)");
  assert.notEqual(a, c, "distinct sessions must map to distinct UUIDs");
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a valid RFC-4122 v5 UUID (Claude requires a valid UUID)",
  );
});

test("sanitizeOpenclawSessionKey: keeps a shell/glob-safe key, else null", () => {
  assert.equal(
    openrindShell.__testing.sanitizeOpenclawSessionKey("ses_Abc.1-2"),
    "ses_Abc.1-2",
  );
  assert.equal(
    openrindShell.__testing.sanitizeOpenclawSessionKey("a b/c*d"),
    "a-b-c-d",
  );
  assert.equal(openrindShell.__testing.sanitizeOpenclawSessionKey(""), null);
  assert.equal(openrindShell.__testing.sanitizeOpenclawSessionKey("***"), null);
});

test("resolveAgentSessionValue: UUID for claude, key for openclaw, null empty", () => {
  const claude = openrindShell.__testing.resolveAgentSessionValue(
    "openrind-shell-claude",
    "ses_abc",
  );
  assert.match(claude, /^[0-9a-f-]{36}$/);
  assert.equal(
    openrindShell.__testing.resolveAgentSessionValue("openrind-shell-openclaw", "ses_abc"),
    "ses_abc",
  );
  assert.equal(
    openrindShell.__testing.resolveAgentSessionValue("openrind-shell-claude", ""),
    null,
  );
  assert.equal(
    openrindShell.__testing.resolveAgentSessionValue("openrind-shell-claude", null),
    null,
  );
});

test("buildLaunchBlock (openclaw + proxy): delegates to setup.sh with OpenrindGateway env", () => {
  const block = openrindShell.__testing.buildLaunchBlock(
    "openrind-shell-openclaw",
    "https://proxy.openrind.com/openrind-gateway-proxy/t/TOK2",
  );
  // Must NOT unset the key — setup.sh needs it for `openclaw onboard`.
  assert.doesNotMatch(
    block,
    /unset ANTHROPIC_API_KEY/,
    "openclaw must keep ANTHROPIC_API_KEY",
  );
  // The proxy is handed to setup.sh as OPENRIND_GATEWAY_PROXY_URL (its
  // highest-priority presign source) — NOT as ANTHROPIC_BASE_URL, which
  // setup.sh derives itself after normalizing/persisting the presign.
  assert.match(
    block,
    /^export OPENRIND_GATEWAY_PROXY_URL=.*TOK2/m,
    "must export OPENRIND_GATEWAY_PROXY_URL for setup.sh",
  );
  assert.doesNotMatch(
    block,
    /^export ANTHROPIC_BASE_URL=/m,
    "openclaw must not export ANTHROPIC_BASE_URL directly — setup.sh owns it",
  );
  assert.doesNotMatch(
    block,
    /^export ANTHROPIC_AUTH_TOKEN=/m,
    "openclaw must not export the claude-only placeholder auth token",
  );
  // Must load the key from the file deposited by finalizeSandboxLaunch.
  assert.match(
    block,
    /anthropic-api-key/,
    "must load key from /sandbox/anthropic-api-key",
  );
  // Must set the agent gate that setup.sh switches on.
  assert.match(
    block,
    /^export OPENRIND_SHELL_AGENT=openclaw$/m,
    "must export OPENRIND_SHELL_AGENT=openclaw for setup.sh",
  );
  // Cold start must delegate to the image's tested entry point instead of
  // re-implementing the bootstrap (auth profile, openclaw.json, gateway) here.
  // History: the hand-rolled block broke on openclaw 2026.4.29 — invalid auth
  // profile shape, meta-less config overwritten by the gateway, and a cold
  // gateway staging 35 bundled deps at startup that hung /readyz for 10 min.
  assert.match(
    block,
    /exec openrind-shell/,
    "cold start must exec openrind-shell (setup.sh)",
  );
  assert.doesNotMatch(
    block,
    /openclaw gateway --port/,
    "must NOT start the gateway — setup.sh owns the gateway lifecycle",
  );
  assert.doesNotMatch(
    block,
    /openclaw onboard/,
    "must NOT run onboard — setup.sh owns onboarding",
  );
  assert.doesNotMatch(
    block,
    /auth-profiles\.json/,
    "must NOT hand-write auth-profiles.json — openclaw rejects the shape",
  );
  assert.doesNotMatch(
    block,
    /models\.providers\.openrind-gateway/,
    "must NOT hand-write openclaw.json — setup.sh registers the provider",
  );
  assert.doesNotMatch(
    block,
    /status --deep|doctor --fix/,
    "plugin pre-stage belongs to setup.sh",
  );
  // No reconnect fast path anymore: OpenClaw is launched by the USER after they
  // onboard interactively (see setup.sh). The block must NOT probe a gateway,
  // exec a TUI, or bind a session — it only delegates to setup.sh.
  assert.doesNotMatch(
    block,
    /18789\/readyz/,
    "must NOT probe a pre-warmed gateway — the user starts OpenClaw themselves",
  );
  assert.doesNotMatch(
    block,
    /openclaw tui/,
    "must NOT auto-launch the TUI — the user runs openclaw after onboarding",
  );
  assert.doesNotMatch(
    block,
    /openrind-desktop-current-session/,
    "must NOT hardcode a session binding — the user manages OpenClaw sessions",
  );
});

test("buildLaunchBlock (openclaw): delegates straight to setup.sh (no fast path)", () => {
  const block = openrindShell.__testing.buildLaunchBlock("openrind-shell-openclaw", null);

  // The openclaw path is now a plain handoff to the image bootstrap: setup.sh
  // brings up persistence and then hands the user an interactive shell to run
  // `openclaw onboard` / `openclaw`. No gateway probe, no TUI exec, no pkill.
  assert.match(block, /exec openrind-shell/, "must delegate to setup.sh");
  assert.doesNotMatch(block, /18789\/readyz/, "no gateway fast path");
  assert.doesNotMatch(block, /openclaw tui/, "must not auto-launch the TUI");
  assert.doesNotMatch(
    block,
    /pkill -f 'openclaw gateway'/,
    "no gateway lifecycle here",
  );

  // Both the env prep and the launch stay inside the managed markers.
  assert.match(block, /^# >>> openrind-desktop launch >>>/m);
  assert.match(block, /^# <<< openrind-desktop launch <<<$/m);
});

// ── prewarmAgentRuntime ──────────────────────────────────────────────

test("prewarmAgentRuntime (claude): runs setup.sh headlessly in setup-only mode", async () => {
  process.env.MOCK_WSL_STDOUT = "prewarm: ok";
  const progress = [];
  await openrindShell.__testing.prewarmAgentRuntime({
    name: "openrind-shell-x",
    profile: "openrind-shell-claude",
    env: process.env,
    onProgress: (evt) => progress.push(evt),
  });
  // Claude now prewarms too: it connects to DATABASE_URL on the loading screen
  // (like openclaw) so a bad connection string surfaces here instead of
  // silently at connect. Exactly one sandbox exec runs setup.sh setup-only.
  const lines = readArgsLog();
  assert.equal(lines.length, 1, "exactly one sandbox exec");
  assert.match(lines[0], /openshell sandbox exec --name 'openrind-shell-x'/);
  const m = lines[0].match(/([A-Za-z0-9+/=]{40,})\S*\s*\|\s*base64 -d/);
  assert.ok(m, "script must be base64-wrapped via sandboxRunScriptCmd");
  const script = Buffer.from(m[1], "base64").toString("utf8");
  assert.match(
    script,
    /OPENRIND_SHELL_SETUP_ONLY=1/,
    "must run setup.sh in setup-only mode",
  );
  assert.match(script, /openrind-shell > \/tmp\/openrind-shell-setup\.log/);
  // No gateway machinery — Claude has no long-lived gateway to reuse/clear.
  assert.doesNotMatch(script, /readyz/, "claude has no gateway to probe");
  assert.doesNotMatch(script, /pkill -f 'openclaw gateway'/);
  assert.doesNotMatch(
    script,
    /OPENRIND_SHELL_AGENT=openclaw/,
    "claude prewarm must not set the openclaw agent gate",
  );
  assert.ok(
    progress.some((p) => p.phase === "prewarm"),
    "must surface loading-screen progress",
  );
});

test("prewarmAgentRuntime (openclaw): runs setup.sh headlessly in setup-only mode", async () => {
  process.env.MOCK_WSL_STDOUT = "prewarm: ok";
  const progress = [];
  await openrindShell.__testing.prewarmAgentRuntime({
    name: "openrind-shell-x",
    profile: "openrind-shell-openclaw",
    env: process.env,
    onProgress: (evt) => progress.push(evt),
  });
  const lines = readArgsLog();
  assert.equal(lines.length, 1, "exactly one sandbox exec");
  assert.match(lines[0], /openshell sandbox exec --name 'openrind-shell-x'/);
  // The script travels base64-encoded through sandboxRunScriptCmd — decode
  // it and assert on the real content. The blob is wrapped in (possibly
  // nested) shell quoting, so extract just the base64 run before `base64 -d`.
  const m = lines[0].match(/([A-Za-z0-9+/=]{40,})\S*\s*\|\s*base64 -d/);
  assert.ok(m, "script must be base64-wrapped via sandboxRunScriptCmd");
  const script = Buffer.from(m[1], "base64").toString("utf8");
  assert.match(
    script,
    /readyz/,
    "must short-circuit when the gateway is already healthy (reopen path)",
  );
  assert.match(
    script,
    /OPENRIND_SHELL_AGENT=openclaw OPENRIND_SHELL_SETUP_ONLY=1/,
    "must run setup.sh in setup-only mode with the openclaw agent gate",
  );
  assert.match(
    script,
    /pkill -f 'openclaw gateway'/,
    "must clear zombie gateways before setup.sh binds the port",
  );
  assert.match(script, /openrind-shell > \/tmp\/openrind-shell-setup\.log/);
  assert.ok(
    progress.some((p) => p.phase === "prewarm"),
    "must surface loading-screen progress",
  );
});

test("prewarmAgentRuntime (openclaw): failure is non-fatal", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "setup exploded";
  // Must resolve (not reject) — the .bashrc block still falls back to
  // running setup interactively in the terminal.
  await openrindShell.__testing.prewarmAgentRuntime({
    name: "openrind-shell-x",
    profile: "openrind-shell-openclaw",
    env: process.env,
  });
});

// ── prewarmIfNeeded ────────────────────────────────────────────────────
// Only OpenClaw needs prewarming (embedded-gateway warmup so connect can exec
// the TUI directly). Claude must NOT prewarm on the loading screen: its
// connect-time setup.sh runs the full DB bootstrap (migrations + restore) once,
// so prewarming would pay the remote-PostgreSQL connect a second time per
// session — the "database connecting is slow" doubling this fixes.

test("prewarmIfNeeded (claude): skips prewarm entirely (no sandbox exec)", async () => {
  process.env.MOCK_WSL_STDOUT = "prewarm: ok";
  await openrindShell.__testing.prewarmIfNeeded({
    name: "openrind-shell-x",
    profile: "openrind-shell-claude",
    env: process.env,
  });
  assert.equal(
    readArgsLog().length,
    0,
    "claude must not run setup.sh / connect to the DB on the loading screen",
  );
});

test("prewarmIfNeeded (openclaw): runs the prewarm", async () => {
  process.env.MOCK_WSL_STDOUT = "prewarm: ok";
  await openrindShell.__testing.prewarmIfNeeded({
    name: "openrind-shell-x",
    profile: "openrind-shell-openclaw",
    env: process.env,
  });
  const lines = readArgsLog();
  assert.equal(lines.length, 1, "openclaw prewarm runs exactly one sandbox exec");
  assert.match(lines[0], /openshell sandbox exec --name 'openrind-shell-x'/);
});

test("buildLaunchBlock: proxyBase is shell-quoted (no command substitution)", () => {
  // proxyBase is sandbox-controlled (parsed from an uploaded presign.json)
  // or an HTTP response body. Inside double quotes bash still expands
  // $(...), so the exports must single-quote the value.
  const evil = "https://x.example/openrind-gateway-proxy/t/$(touch /tmp/pwned)";
  const claude = openrindShell.__testing.buildLaunchBlock("openrind-shell-claude", evil);
  assert.ok(
    claude.includes(`export OPENRIND_GATEWAY_PROXY_URL='${evil}'`),
    "claude proxy export must be single-quoted",
  );
  const claw = openrindShell.__testing.buildLaunchBlock("openrind-shell-openclaw", evil);
  assert.ok(
    claw.includes(`export OPENRIND_GATEWAY_PROXY_URL='${evil}'`),
    "openclaw proxy export must be single-quoted",
  );
});

test("buildLaunchBlock (openclaw + apiKey): embeds key directly in block", () => {
  // When apiKey is provided, it must be exported directly in the bash block
  // as a primary source, so the key is available even when the sandbox file
  // upload timed out (the most common cause of onboard being skipped).
  const block = openrindShell.__testing.buildLaunchBlock(
    "openrind-shell-openclaw",
    null,
    "test-embedded-api-key",
  );
  assert.match(
    block,
    /export ANTHROPIC_API_KEY='test-embedded-api-key'/,
    "must embed the API key directly in the block",
  );
  // The file-read override must also still be present for key rotation.
  assert.match(
    block,
    /anthropic-api-key/,
    "file-read fallback must also be present",
  );
});

test("buildLaunchBlock (openclaw + no proxy): no OpenrindGateway env, still delegates to setup.sh", () => {
  const block = openrindShell.__testing.buildLaunchBlock("openrind-shell-openclaw", null);
  assert.doesNotMatch(block, /unset ANTHROPIC_API_KEY/);
  assert.doesNotMatch(
    block,
    /^export OPENRIND_GATEWAY_PROXY_URL=/m,
    "no OPENRIND_GATEWAY_PROXY_URL export when proxyBase is null",
  );
  assert.doesNotMatch(
    block,
    /^export ANTHROPIC_BASE_URL=/m,
    "no ANTHROPIC_BASE_URL export when proxyBase is null",
  );
  assert.match(
    block,
    /^export OPENRIND_SHELL_AGENT=openclaw$/m,
    "must export OPENRIND_SHELL_AGENT=openclaw for setup.sh",
  );
  assert.match(
    block,
    /exec openrind-shell/,
    "cold start must exec openrind-shell (setup.sh)",
  );
  assert.doesNotMatch(
    block,
    /openclaw gateway --port/,
    "must NOT start the gateway — setup.sh owns the gateway lifecycle",
  );
  assert.doesNotMatch(
    block,
    /auth-profiles\.json/,
    "must NOT hand-write auth-profiles.json",
  );
  // No fast path: the block just delegates to setup.sh, which then hands the
  // user an interactive shell to onboard and launch OpenClaw themselves.
  assert.doesNotMatch(block, /18789\/readyz/, "no gateway fast path");
  assert.doesNotMatch(block, /openclaw tui/, "must not auto-launch the TUI");
});

test("buildLaunchBlock (claude + no proxy): no proxy vars, delegates to setup.sh", () => {
  const block = openrindShell.__testing.buildLaunchBlock("openrind-shell-claude", null);
  assert.doesNotMatch(block, /ANTHROPIC_BASE_URL/);
  assert.doesNotMatch(block, /^export OPENRIND_GATEWAY_PROXY_URL=/m);
  assert.doesNotMatch(block, /openclaw gateway/);
  assert.doesNotMatch(block, /OPENRIND_SHELL_AGENT=openclaw/);
  // Claude delegates to setup.sh (full bootstrap) for PostgreSQL persistence.
  assert.match(block, /exec openrind-shell/);
  assert.doesNotMatch(block, /exec claude/);
});

// ── deleteOpenrindShellSandbox ──────────────────────────────────────────────

test("deleteOpenrindShellSandbox: passes --force and name through", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  await openrindShell.deleteOpenrindShellSandbox("openrind-shell-foo");
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox delete openrind-shell-foo --force/);
});

test("deleteOpenrindShellSandbox: rejects empty name", async () => {
  await assert.rejects(
    () => openrindShell.deleteOpenrindShellSandbox(""),
    /name is required/,
  );
});

// ── probeDatabaseUrl ───────────────────────────────────────────────────

test("probeDatabaseUrl: throws when DATABASE_URL unset", async () => {
  await assert.rejects(() => openrindShell.probeDatabaseUrl(), /not configured/);
});

test("probeDatabaseUrl: runs psql in postgres:16-alpine and returns reachable", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = "1";
  const r = await openrindShell.probeDatabaseUrl();
  assert.equal(r.ok, true);
  assert.equal(r.reachable, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /docker run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql/,
  );
  assert.match(lines[0], /postgresql:\/\/test\/db/);
  assert.match(lines[0], /-tAc select 1/);
});

test("probeDatabaseUrl: surfaces psql error stderr", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://bad/host");
  process.env.MOCK_WSL_EXIT = "2";
  process.env.MOCK_WSL_STDERR = "psql: connection refused";
  await assert.rejects(
    () => openrindShell.probeDatabaseUrl(),
    /Could not reach PostgreSQL.*connection refused/s,
  );
});

