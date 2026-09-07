import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentSessionValue } from "../../electron/openshell/openrind-shell.mjs";

const assertion = `v1.${"12".repeat(16)}.1900000000000.1900000060000.${"ab".repeat(32)}`;

test("session markers require and carry a signed Haloop conversation context", () => {
  const marker = resolveAgentSessionValue(
    "openrind-shell-claude",
    "desktop-session-a",
    assertion,
  );
  assert.match(
    marker,
    /^openrind-shell-claude:[0-9a-f-]{36}:v1\.[0-9a-f.]+$/,
  );
  assert.equal(marker.endsWith(assertion), true);
  assert.equal(marker.includes("desktop-session-a"), false);
});

test("session markers fail closed without a valid signed context", () => {
  assert.throws(
    () => resolveAgentSessionValue("openrind-shell-claude", "session-a"),
    /signed Haloop conversation context is required/,
  );
  assert.throws(
    () =>
      resolveAgentSessionValue(
        "openrind-shell-openclaw",
        "session-a",
        "not-signed",
    ),
    /signed Haloop conversation context is required/,
  );
  assert.throws(
    () =>
      resolveAgentSessionValue(
        "openrind-shell-claude",
        "session-a",
        assertion.toUpperCase(),
      ),
    /signed Haloop conversation context is required/,
  );
});
