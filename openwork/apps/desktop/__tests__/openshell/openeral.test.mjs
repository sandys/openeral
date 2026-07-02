// Unit tests for apps/desktop/electron/openshell/openeral.mjs.
//
// Uses the same mock-wsl.sh as wsl.test.mjs / doctor.test.mjs to record
// argv and emit canned stdout. Credentials are stubbed via the
// OPENWORK_TEST_CREDENTIALS_DIR env seam baked into
// openeral-credentials.mjs (plain-file storage; no Electron required).
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
  workDir = mkdtempSync(join(tmpdir(), "openeral-test-"));
  logPath = join(workDir, "wsl-args.log");
  credsDir = join(workDir, "creds");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  process.env.OPENWORK_TEST_CREDENTIALS_DIR = credsDir;
  process.env.OPENWORK_CREDENTIALS_FILE = join(workDir, "creds-prod-fallback.json");
  for (const key of [
    "MOCK_WSL_STDOUT",
    "MOCK_WSL_STDOUT_FILE",
    "MOCK_WSL_STDERR",
    "MOCK_WSL_EXIT",
    "MOCK_WSL_DELAY_MS",
    "MOCK_WSL_DELAY_BEFORE_MS",
  ]) {
    delete process.env[key];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_WSL_EXE;
  delete process.env.MOCK_WSL_LOG;
  delete process.env.OPENWORK_TEST_CREDENTIALS_DIR;
  delete process.env.OPENWORK_CREDENTIALS_FILE;
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

const openeral = await import("../../electron/openshell/openeral.mjs");
const credentials = await import("../../electron/openshell/openeral-credentials.mjs");

// ── Pure helpers ───────────────────────────────────────────────────────

test("imageForProfile: maps claude profile to sandys image", () => {
  assert.equal(
    openeral.imageForProfile("openeral-claude"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: maps openclaw profile to sandys image (same as claude)", () => {
  // openeral README: same image, only --provider differs.
  assert.equal(
    openeral.imageForProfile("openeral-openclaw"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: throws on unknown profile", () => {
  assert.throws(() => openeral.imageForProfile("openeral-unknown"), /Unknown OpenEral profile/);
});

// ── buildWslEnvForwarding ──────────────────────────────────────────────

test("buildWslEnvForwarding: extends WSLENV with forwarded names", () => {
  const env = openeral.__testing.buildWslEnvForwarding({
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENERAL_AGENT: "openclaw",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(env.OPENERAL_AGENT, "openclaw");
  const names = env.WSLENV.split(":").filter(Boolean);
  assert.ok(names.includes("ANTHROPIC_API_KEY"));
  assert.ok(names.includes("OPENERAL_AGENT"));
});

test("buildWslEnvForwarding: preserves existing WSLENV entries", () => {
  const prev = process.env.WSLENV;
  process.env.WSLENV = "EXISTING_VAR";
  try {
    const env = openeral.__testing.buildWslEnvForwarding({ FOO: "bar" });
    const names = env.WSLENV.split(":").filter(Boolean);
    assert.ok(names.includes("EXISTING_VAR"), `expected EXISTING_VAR in ${env.WSLENV}`);
    assert.ok(names.includes("FOO"), `expected FOO in ${env.WSLENV}`);
  } finally {
    if (prev === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prev;
  }
});

// ── createStringcostPresign ────────────────────────────────────────────

test("createStringcostPresign: posts the canonical body and returns the url", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { url: "https://proxy.stringcost.com/stringcost-proxy/t/abc123/v1/messages" };
      },
      async text() {
        return "";
      },
    };
  };
  try {
    const url = await openeral.__testing.createStringcostPresign({
      anthropicApiKey: "test-anthropic-api-key",
      stringcostApiKey: "test-stringcost-api-key",
      agentLabel: "claude-code",
    });
    assert.equal(url, "https://proxy.stringcost.com/stringcost-proxy/t/abc123/v1/messages");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/presign$/);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-stringcost-api-key");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.provider, "anthropic");
    assert.equal(body.client_api_key, "test-anthropic-api-key");
    assert.deepEqual(body.path, ["/v1/messages"]);
    // metadata.labels is what StringCost's vendor-portfolio classifier reads.
    assert.deepEqual(body.metadata.labels, ["openeral", "claude-code"]);
    assert.equal(body.metadata.client, "claude-code");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createStringcostPresign: labels openclaw spend distinctly", async () => {
  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, async json() { return { url: "https://x/stringcost-proxy/t/z" }; }, async text() { return ""; } };
  };
  try {
    await openeral.__testing.createStringcostPresign({
      anthropicApiKey: "sk-ant-test",
      stringcostApiKey: "sk-st-test",
      agentLabel: "openclaw",
    });
    assert.deepEqual(captured.metadata.labels, ["openeral", "openclaw"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createStringcostPresign: returns null on a non-2xx response", async () => {
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
    const url = await openeral.__testing.createStringcostPresign({
      anthropicApiKey: "sk-ant-test",
      stringcostApiKey: "bad-key",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createStringcostPresign: returns null when the response carries no url", async () => {
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
    const url = await openeral.__testing.createStringcostPresign({
      anthropicApiKey: "sk-ant-test",
      stringcostApiKey: "sk-st-test",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createStringcostPresign: returns null (does not throw) when fetch rejects", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const url = await openeral.__testing.createStringcostPresign({
      anthropicApiKey: "sk-ant-test",
      stringcostApiKey: "sk-st-test",
      agentLabel: "claude-code",
    });
    assert.equal(url, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── stringcostBaseUrlForAgent ──────────────────────────────────────────

test("stringcostBaseUrlForAgent: strips the /v1/messages the agent re-appends", () => {
  // The control plane mints a single-path presign URL ending in /v1/messages.
  // Claude Code / OpenClaw append /v1/messages themselves, so the base URL we
  // hand them must NOT include it (else the proxy sees /v1/messages/v1/messages
  // and returns "Path not authorized").
  assert.equal(
    openeral.__testing.stringcostBaseUrlForAgent(
      "https://proxy.stringcost.com/stringcost-proxy/t/TOK123/v1/messages",
    ),
    "https://proxy.stringcost.com/stringcost-proxy/t/TOK123",
  );
});

test("stringcostBaseUrlForAgent: drops a trailing slash (adapter-token shape)", () => {
  assert.equal(
    openeral.__testing.stringcostBaseUrlForAgent(
      "https://proxy.stringcost.com/stringcost-proxy/t/TOK123/",
    ),
    "https://proxy.stringcost.com/stringcost-proxy/t/TOK123",
  );
});

test("stringcostBaseUrlForAgent: leaves an already-bare base URL untouched", () => {
  assert.equal(
    openeral.__testing.stringcostBaseUrlForAgent(
      "https://proxy.stringcost.com/stringcost-proxy/t/TOK123",
    ),
    "https://proxy.stringcost.com/stringcost-proxy/t/TOK123",
  );
});

test("stringcostBaseUrlForAgent: accepts a self-hosted host:port shape", () => {
  assert.equal(
    openeral.__testing.stringcostBaseUrlForAgent(
      "http://10.0.0.5:8787/stringcost-proxy/t/TOK/v1/messages",
    ),
    "http://10.0.0.5:8787/stringcost-proxy/t/TOK",
  );
});

test("stringcostBaseUrlForAgent: returns null for non-StringCost / empty input", () => {
  assert.equal(
    openeral.__testing.stringcostBaseUrlForAgent("https://api.anthropic.com/v1/messages"),
    null,
  );
  assert.equal(openeral.__testing.stringcostBaseUrlForAgent(""), null);
  assert.equal(openeral.__testing.stringcostBaseUrlForAgent(null), null);
});

// ── sandboxRunScriptCmd ────────────────────────────────────────────────

test("sandboxRunScriptCmd: base64-encodes the script so it round-trips in the sandbox", () => {
  const script = "echo hi\nexport FOO=\"a b\"\nunset BAR";
  const cmd = openeral.__testing.sandboxRunScriptCmd("openeral-ws1", script);
  // Targets the named sandbox via exec.
  assert.match(cmd, /openshell sandbox exec --name 'openeral-ws1' --/);
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
    { name: "openeral-foo" },
    { name: "openeral-bar" },
  ]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when not present", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "something-else" }]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: accepts plain-string list entries", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify(["openeral-foo"]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when list command fails", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: returns false on empty input", async () => {
  assert.equal(await openeral.sandboxExists(""), false);
});

// ── createOpenEralSandbox ──────────────────────────────────────────────

test("createOpenEralSandbox: throws when DATABASE_URL is unconfigured", async () => {
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-claude",
        skipImagePull: true,
      }),
    /DATABASE_URL is not configured/,
  );
});

test("createOpenEralSandbox: throws when ANTHROPIC_API_KEY missing (any profile)", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-claude",
        skipImagePull: true,
      }),
    /ANTHROPIC_API_KEY is not configured/,
  );
});

test("createOpenEralSandbox: short-circuits when sandbox already exists", async () => {
  // listSandboxes returns our target name → existed=true, no create call.
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "openeral-resume" }]);
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-resume",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, true);
  // Only one wsl call: the list probe.
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox list --json/);
});

test("createOpenEralSandbox: claude profile builds canonical openeral argv", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-test");
  // Mock always emits "[]" so sandbox list parses to empty.
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-new",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, false);
  assert.equal(result.imageRef, "ghcr.io/sandys/openeral/sandbox:just-bash");

  const lines = readArgsLog();

  // No `provider create` calls — the canonical flow uses --auto-providers
  // to pick up ANTHROPIC_API_KEY from the env at sandbox-create time.
  assert.equal(
    lines.filter((l) => /openshell provider create/.test(l)).length,
    0,
    "canonical openeral flow does not call `provider create` ahead of time",
  );

  // The whole flow runs inside ONE bash -c invocation. The bash script
  // is multi-line, so the mock log splits it into separate lines —
  // assert on each line of the script independently.
  assert.ok(
    lines.some((l) => /cat > \/tmp\/openeral-db-url-[\w-]+/.test(l)),
    "expected DATABASE_URL staging via `cat > /tmp/openeral-db-url-<uuid>`",
  );
  assert.ok(
    lines.some((l) => /chmod 600 \/tmp\/openeral-db-url-[\w-]+/.test(l)),
    "expected chmod 600 on the staging file",
  );
  assert.ok(
    lines.some((l) => /trap 'rm -f \/tmp\/openeral-db-url-[\w-]+' EXIT/.test(l)),
    "expected EXIT trap to clean up staging file",
  );
  // Should not regress to the mktemp+command-substitution shape.
  assert.ok(
    !lines.some((l) => /mktemp .*\$\(/.test(l)),
    "should not use mktemp command-substitution (empty-variable trap)",
  );

  // Sandbox create matches the openeral README exactly. The args we
  // splice via shellQuote (name, imageRef) appear single-quoted.
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine, `no create line. lines=${JSON.stringify(lines)}`);
  // --no-tty + `-- /bin/true`: create only provisions; the agent is launched
  // later via `sandbox connect` + the /sandbox/.bashrc block (no TTY here, so
  // running `-- openeral` would deadlock on the agent's interactive prompt).
  assert.match(createLine, /sandbox create --no-tty/);
  assert.match(createLine, /--name 'openeral-new'/);
  assert.match(createLine, /--from 'ghcr\.io\/sandys\/openeral\/sandbox:just-bash'/);
  assert.match(createLine, /--upload \/tmp\/openeral-db-url-[\w-]+:\/sandbox\/db-url/);
  assert.match(createLine, /--provider claude --auto-providers/);
  assert.match(createLine, /-- \/bin\/true$/);
  // Things that should NOT be there.
  assert.doesNotMatch(createLine, /--gateway/, "no --gateway flag in canonical flow");
  assert.doesNotMatch(createLine, /--provider db/, "no explicit db provider");
});

test("createOpenEralSandbox: openclaw profile sets OPENERAL_AGENT env via WSLENV", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-xxx");
  process.env.MOCK_WSL_STDOUT = "[]";
  await openeral.createOpenEralSandbox({
    name: "openeral-claws",
    profile: "openeral-openclaw",
    skipImagePull: true,
  });
  // We can't directly observe WSLENV from the mock log (it sets env
  // for wsl.exe, not in argv). buildWslEnvForwarding is exercised in
  // its own test above. Here just confirm the openclaw create line is
  // structurally identical to the claude path.
  const lines = readArgsLog();
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine);
  assert.match(createLine, /--name 'openeral-claws'/);
  assert.match(createLine, /--provider claude --auto-providers/);
  assert.match(createLine, /-- \/bin\/true$/);
});

test("createOpenEralSandbox: requires name and profile", async () => {
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ profile: "openeral-claude" }),
    /name is required/,
  );
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ name: "x" }),
    /profile is required/,
  );
});

// ── buildLaunchBlock ───────────────────────────────────────────────────
// Pure function — no wslRun, no mock needed.

test("buildLaunchBlock (claude + proxy): exports proxy vars and unsets the real key", () => {
  const block = openeral.__testing.buildLaunchBlock(
    "openeral-claude",
    "https://proxy.stringcost.com/stringcost-proxy/t/TOK",
  );
  assert.match(block, /ANTHROPIC_BASE_URL=.*TOK/, "must export proxy base URL");
  assert.match(
    block,
    /^export ANTHROPIC_AUTH_TOKEN=/m,
    "claude must export a placeholder auth token for the proxy",
  );
  // Compliance: the placeholder must never be a hardcoded token literal —
  // it is env-sourced (OPENWORK_STRINGCOST_AUTH_TOKEN) or random per process.
  assert.doesNotMatch(
    block,
    /openwork-stringcost/,
    "placeholder token must not be the old hardcoded literal",
  );
  const tokenLine = block.match(/^export ANTHROPIC_AUTH_TOKEN='([^']+)'$/m);
  assert.ok(tokenLine, "token export must be single-quoted and non-empty");
  assert.ok(
    process.env.OPENWORK_STRINGCOST_AUTH_TOKEN ||
      /^openwork-[0-9a-f-]{36}$/.test(tokenLine[1]),
    "unset env must yield a random per-process placeholder (openwork-<uuid>)",
  );
  assert.match(block, /unset ANTHROPIC_API_KEY/, "claude must unset real key when proxy active");
  assert.doesNotMatch(block, /openclaw gateway/, "claude must not start openclaw gateway");
  assert.match(block, /exec claude/, "claude must exec claude");
});

test("buildLaunchBlock (openclaw + proxy): delegates to setup.sh with StringCost env", () => {
  const block = openeral.__testing.buildLaunchBlock(
    "openeral-openclaw",
    "https://proxy.stringcost.com/stringcost-proxy/t/TOK2",
  );
  // Must NOT unset the key — setup.sh needs it for `openclaw onboard`.
  assert.doesNotMatch(
    block,
    /unset ANTHROPIC_API_KEY/,
    "openclaw must keep ANTHROPIC_API_KEY",
  );
  // The proxy is handed to setup.sh as STRINGCOST_PROXY_URL (its
  // highest-priority presign source) — NOT as ANTHROPIC_BASE_URL, which
  // setup.sh derives itself after normalizing/persisting the presign.
  assert.match(
    block,
    /^export STRINGCOST_PROXY_URL=.*TOK2/m,
    "must export STRINGCOST_PROXY_URL for setup.sh",
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
    /^export OPENERAL_AGENT=openclaw$/m,
    "must export OPENERAL_AGENT=openclaw for setup.sh",
  );
  // Cold start must delegate to the image's tested entry point instead of
  // re-implementing the bootstrap (auth profile, openclaw.json, gateway) here.
  // History: the hand-rolled block broke on openclaw 2026.4.29 — invalid auth
  // profile shape, meta-less config overwritten by the gateway, and a cold
  // gateway staging 35 bundled deps at startup that hung /readyz for 10 min.
  assert.match(
    block,
    /exec openeral/,
    "cold start must exec openeral (setup.sh)",
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
    /models\.providers\.stringcost/,
    "must NOT hand-write openclaw.json — setup.sh registers the provider",
  );
  assert.doesNotMatch(
    block,
    /status --deep|doctor --fix/,
    "plugin pre-stage belongs to setup.sh",
  );
  // Reconnect fast path: when the gateway from a previous session is healthy,
  // exec the TUI directly (mirrors setup.sh's final exec).
  assert.match(
    block,
    /18789\/readyz/,
    "must probe gateway /readyz for the fast path",
  );
  assert.match(
    block,
    /\. \/home\/agent\/\.openeral\/env\.sh/,
    "fast path must source env.sh for the StringCost proxy env",
  );
  assert.match(
    block,
    /exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR -u ANTHROPIC_AUTH_TOKEN/,
    "fast-path exec must scrub setup-only env (mirrors setup.sh's exec)",
  );
  assert.match(block, /HOME=\/home\/agent/, "exec must set HOME=/home/agent");
  assert.match(
    block,
    /^\s+openclaw\s*$/m,
    "exec must end with openclaw on its own line",
  );
  // SHELL must be set so openclaw agent tool invocations use openeral's workspace
  // filesystem layer (PostgreSQL-backed) rather than raw /bin/bash.
  assert.match(
    block,
    /SHELL=\/usr\/local\/bin\/openeral-bash/,
    "exec must set SHELL to openeral-bash",
  );
  // OPENCLAW_HANDSHAKE_TIMEOUT_MS must be set for the TUI exec so the client
  // doesn't time out connecting to the gateway on a cold container.
  assert.match(
    block,
    /OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000/,
    "exec must set OPENCLAW_HANDSHAKE_TIMEOUT_MS for TUI client",
  );
});

test("buildLaunchBlock (openclaw): fast path precedes the setup.sh handoff", () => {
  const block = openeral.__testing.buildLaunchBlock("openeral-openclaw", null);

  // The readyz fast path must come first — reconnects with a live gateway
  // exec the TUI immediately instead of re-running setup.sh.
  const readyzIdx = block.indexOf("18789/readyz");
  const execOpeneralIdx = block.indexOf("exec openeral");
  assert.ok(readyzIdx > -1, "readyz fast-path probe must be present");
  assert.ok(execOpeneralIdx > -1, "exec openeral handoff must be present");
  assert.ok(
    readyzIdx < execOpeneralIdx,
    `readyz fast path (pos ${readyzIdx}) must appear BEFORE exec openeral (pos ${execOpeneralIdx})`,
  );

  // A zombie gateway process holding port 18789 would make setup.sh's own
  // gateway fail to bind (setup.sh assumes a fresh container and does not
  // pkill). The block must clear it before handing off.
  const pkillIdx = block.indexOf("pkill -f 'openclaw gateway'");
  assert.ok(pkillIdx > -1, "must pkill zombie gateways before exec openeral");
  assert.ok(
    pkillIdx < execOpeneralIdx,
    `pkill (pos ${pkillIdx}) must appear BEFORE exec openeral (pos ${execOpeneralIdx})`,
  );

  // Both the env prep and the launch must stay inside the managed markers.
  assert.match(block, /^# >>> openwork launch >>>/m);
  assert.match(block, /^# <<< openwork launch <<<$/m);
});

test("buildLaunchBlock: proxyBase is shell-quoted (no command substitution)", () => {
  // proxyBase is sandbox-controlled (parsed from an uploaded presign.json)
  // or an HTTP response body. Inside double quotes bash still expands
  // $(...), so the exports must single-quote the value.
  const evil = "https://x.example/stringcost-proxy/t/$(touch /tmp/pwned)";
  const claude = openeral.__testing.buildLaunchBlock("openeral-claude", evil);
  assert.ok(
    claude.includes(`export ANTHROPIC_BASE_URL='${evil}'`),
    "claude proxy export must be single-quoted",
  );
  const claw = openeral.__testing.buildLaunchBlock("openeral-openclaw", evil);
  assert.ok(
    claw.includes(`export STRINGCOST_PROXY_URL='${evil}'`),
    "openclaw proxy export must be single-quoted",
  );
});

test("buildLaunchBlock (openclaw): fast path preserves ANTHROPIC_API_KEY across env.sh", () => {
  // env.sh (written by setup.sh) contains `unset ANTHROPIC_API_KEY` for
  // Claude Code's benefit. The fast path must save the key it just loaded
  // and re-export it after sourcing, or the TUI is exec'd without the
  // literal key that setup.sh documents OpenClaw requires.
  const block = openeral.__testing.buildLaunchBlock("openeral-openclaw", null);
  const saveIdx = block.indexOf('_saved_key="${ANTHROPIC_API_KEY:-}"');
  const sourceIdx = block.indexOf(". /home/agent/.openeral/env.sh");
  const restoreIdx = block.indexOf(
    '[ -n "$_saved_key" ] && export ANTHROPIC_API_KEY="$_saved_key"',
  );
  assert.ok(saveIdx > -1, "must capture the key before sourcing env.sh");
  assert.ok(sourceIdx > -1, "must still source env.sh for ANTHROPIC_BASE_URL");
  assert.ok(restoreIdx > -1, "must re-export the key after sourcing env.sh");
  assert.ok(
    saveIdx < sourceIdx && sourceIdx < restoreIdx,
    `order must be save (${saveIdx}) -> source (${sourceIdx}) -> restore (${restoreIdx})`,
  );
});

test("buildLaunchBlock (openclaw + apiKey): embeds key directly in block", () => {
  // When apiKey is provided, it must be exported directly in the bash block
  // as a primary source, so the key is available even when the sandbox file
  // upload timed out (the most common cause of onboard being skipped).
  const block = openeral.__testing.buildLaunchBlock(
    "openeral-openclaw",
    null,
    "test-embedded-api-key",
  );
  assert.match(
    block,
    /export ANTHROPIC_API_KEY='test-embedded-api-key'/,
    "must embed the API key directly in the block",
  );
  // The file-read override must also still be present for key rotation.
  assert.match(block, /anthropic-api-key/, "file-read fallback must also be present");
});

test("buildLaunchBlock (openclaw + no proxy): no StringCost env, still delegates to setup.sh", () => {
  const block = openeral.__testing.buildLaunchBlock("openeral-openclaw", null);
  assert.doesNotMatch(block, /unset ANTHROPIC_API_KEY/);
  assert.doesNotMatch(
    block,
    /^export STRINGCOST_PROXY_URL=/m,
    "no STRINGCOST_PROXY_URL export when proxyBase is null",
  );
  assert.doesNotMatch(
    block,
    /^export ANTHROPIC_BASE_URL=/m,
    "no ANTHROPIC_BASE_URL export when proxyBase is null",
  );
  assert.match(
    block,
    /^export OPENERAL_AGENT=openclaw$/m,
    "must export OPENERAL_AGENT=openclaw for setup.sh",
  );
  assert.match(
    block,
    /exec openeral/,
    "cold start must exec openeral (setup.sh)",
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
  // Fast path still present without a proxy.
  assert.match(
    block,
    /exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR -u ANTHROPIC_AUTH_TOKEN/,
    "fast-path exec must scrub setup-only env",
  );
  assert.match(
    block,
    /SHELL=\/usr\/local\/bin\/openeral-bash/,
    "exec must set SHELL to openeral-bash",
  );
  assert.match(block, /HOME=\/home\/agent/, "exec must set HOME");
});

test("buildLaunchBlock (claude + no proxy): no proxy vars and no gateway", () => {
  const block = openeral.__testing.buildLaunchBlock("openeral-claude", null);
  assert.doesNotMatch(block, /ANTHROPIC_BASE_URL/);
  assert.doesNotMatch(block, /unset ANTHROPIC_API_KEY/);
  assert.doesNotMatch(block, /openclaw gateway/);
  assert.match(block, /exec claude/);
});

// ── deleteOpenEralSandbox ──────────────────────────────────────────────

test("deleteOpenEralSandbox: passes --force and name through", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  await openeral.deleteOpenEralSandbox("openeral-foo");
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox delete openeral-foo --force/);
});

test("deleteOpenEralSandbox: rejects empty name", async () => {
  await assert.rejects(() => openeral.deleteOpenEralSandbox(""), /name is required/);
});

// ── probeDatabaseUrl ───────────────────────────────────────────────────

test("probeDatabaseUrl: throws when DATABASE_URL unset", async () => {
  await assert.rejects(() => openeral.probeDatabaseUrl(), /not configured/);
});

test("probeDatabaseUrl: runs psql in postgres:16-alpine and returns reachable", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = "1";
  const r = await openeral.probeDatabaseUrl();
  assert.equal(r.ok, true);
  assert.equal(r.reachable, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /docker run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql/);
  assert.match(lines[0], /postgresql:\/\/test\/db/);
  assert.match(lines[0], /-tAc select 1/);
});

test("probeDatabaseUrl: surfaces psql error stderr", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://bad/host");
  process.env.MOCK_WSL_EXIT = "2";
  process.env.MOCK_WSL_STDERR = "psql: connection refused";
  await assert.rejects(
    () => openeral.probeDatabaseUrl(),
    /Could not reach PostgreSQL.*connection refused/s,
  );
});
