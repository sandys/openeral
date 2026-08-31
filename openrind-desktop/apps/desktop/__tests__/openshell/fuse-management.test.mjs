import assert from "node:assert/strict";
import test from "node:test";

import { normalizePrimaryFuseSandboxes } from "../../electron/openshell/fuse-management.mjs";

test("normalizes structured OpenShell sandbox metadata for the sidebar", () => {
  const rows = normalizePrimaryFuseSandboxes(JSON.stringify([
    {
      name: "or-cdcdc-1531c135",
      created_at: "2026-08-31 07:30:15",
      phase: "Ready",
    },
  ]));

  assert.deepEqual(rows, [
    {
      name: "or-cdcdc-1531c135",
      created: "2026-08-31 07:30:15",
      phase: "Ready",
    },
  ]);
});

test("accepts wrapped rows and common timestamp/status aliases", () => {
  const rows = normalizePrimaryFuseSandboxes(JSON.stringify({
    sandboxes: [
      {
        name: "or-demo-12345678",
        createdAt: "2026-08-31T07:30:15Z",
        status: "Provisioning",
      },
    ],
  }));

  assert.equal(rows[0]?.created, "2026-08-31T07:30:15Z");
  assert.equal(rows[0]?.phase, "Provisioning");
});

test("rejects malformed sandbox-list output", () => {
  assert.throws(
    () => normalizePrimaryFuseSandboxes("not json"),
    /returned invalid JSON/,
  );
});
