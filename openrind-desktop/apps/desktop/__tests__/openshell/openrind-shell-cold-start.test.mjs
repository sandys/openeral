// Cold-start resilience for the first connect after the app launches.
//
// Why this test exists: on a fresh Electron start the WSL VM boots and the
// openshell gateway binds its socket a few seconds LATER. Every `openshell`
// call in that window exits 1 with a gRPC transport error. sandboxExists()
// treated that as `false` — i.e. "no such sandbox" — so opening an EXISTING
// sandbox fell through to create, which then failed. Clicking Retry worked
// because by then the gateway was listening. That is exactly the reported
// "throws an error on first connect, connects on retry".
//
// The strings below are copied verbatim from the openshell CLI as observed in
// the distro, so a reworded upstream error fails here instead of silently
// reintroducing the bug.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const openrindShell = await import(
  "../../electron/openshell/openrind-shell.mjs"
);
const { isGatewayWarmingError } = openrindShell.__testing;

// Verbatim from `openshell sandbox list` while the gateway was restarting.
const REAL_TRANSPORT_ERROR = [
  "Error:   × transport error",
  "  ├─▶ tcp connect error",
  "  ├─▶ tcp connect error",
  "  ╰─▶ Connection refused (os error 111)",
].join("\n");

test("the real gateway-warming error is recognised as transient", () => {
  assert.ok(isGatewayWarmingError(REAL_TRANSPORT_ERROR));
  for (const line of REAL_TRANSPORT_ERROR.split("\n").slice(1)) {
    assert.ok(isGatewayWarmingError(line), `should match on its own: ${line}`);
  }
});

test("genuine CLI errors are NOT treated as warm-up", () => {
  for (const text of [
    "error: unrecognized subcommand 'status'",
    'unexpected argument \'--json\' found',
    "Error: sandbox not found",
    "sandbox already exists",
    "",
    undefined,
  ]) {
    assert.equal(
      isGatewayWarmingError(text),
      false,
      `must not be swallowed as warm-up: ${text}`,
    );
  }
});

// sandboxExists() is driven through wsl.exe, which cannot be spawned in this
// harness on Windows (the whole mock-based suite fails with spawn EFTYPE there).
// These structural checks pin the properties that matter, so the fix cannot be
// reverted silently by a future edit.
const SOURCE = readFileSync(
  new URL("../../electron/openshell/openrind-shell.mjs", import.meta.url),
  "utf8",
);

function bodyOf(fnName) {
  const start = SOURCE.indexOf(`export async function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} not found`);
  const next = SOURCE.indexOf("\nexport ", start + 10);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

test("sandboxExists retries the warm-up window instead of answering false", () => {
  const body = bodyOf("sandboxExists");
  assert.match(
    body,
    /LIST_GATEWAY_WARMUP_MS/,
    "must share the same warm-up budget as listSandboxes",
  );
  assert.match(body, /isGatewayWarmingError/, "must classify the transport error");
  // The killer line: a transport error must never fall through to `return false`.
  assert.match(
    body,
    /if \(!isGatewayWarmingError\(errText\)\) break;/,
    "only NON-warming failures may leave the retry loop and return false",
  );
  assert.match(
    body,
    /throw new Error\(\s*"OpenShell gateway is not accepting connections yet/,
    "an exhausted budget must throw, not report the sandbox as missing",
  );
});

test("a real (non-transient) failure still answers false rather than throwing", () => {
  // Preserves the original contract for e.g. an unknown CLI flag.
  assert.match(bodyOf("sandboxExists"), /if \(r\.exitCode !== 0\) return false;/);
});

test("create surfaces a transport failure as a retryable gateway message", () => {
  const body = bodyOf("createOpenrindShellSandbox");
  assert.match(body, /isGatewayWarmingError\(output\)/);
  assert.match(body, /stopped responding while creating/);
});
