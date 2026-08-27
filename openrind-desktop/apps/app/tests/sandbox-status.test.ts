import { describe, expect, test } from "bun:test";

import {
  formatSandboxAge,
  needsUserAttention,
  resolveSandboxStatus,
  sandboxStatusRank,
  sortByStatus,
  statusFromPhase,
  type SandboxStatus,
} from "../src/react-app/domains/session/sidebar/sandbox-status";

describe("statusFromPhase", () => {
  test("phase Ready means 'container exists', NOT 'ready to use'", () => {
    // OpenShell reports Ready ~1s after create, long before the workspace
    // restore, gateway and agent are up. Claiming readiness here is what made
    // the sidebar say "Ready" for a sandbox that then took 40s to connect.
    expect(statusFromPhase("Ready")).toBe("idle");
    expect(statusFromPhase("Provisioning")).toBe("starting");
  });

  test("is case- and whitespace-insensitive", () => {
    expect(statusFromPhase("  ready ")).toBe("idle");
    expect(statusFromPhase("PROVISIONING")).toBe("starting");
  });

  test("recognises the other lifecycle words a gateway may use", () => {
    expect(statusFromPhase("Creating")).toBe("starting");
    expect(statusFromPhase("Pending")).toBe("starting");
    expect(statusFromPhase("Starting")).toBe("starting");
    expect(statusFromPhase("Deleting")).toBe("deleting");
    expect(statusFromPhase("Terminating")).toBe("deleting");
    expect(statusFromPhase("Error")).toBe("failed");
    expect(statusFromPhase("Failed")).toBe("failed");
    expect(statusFromPhase("Stopped")).toBe("stopped");
    expect(statusFromPhase("Exited")).toBe("stopped");
    expect(statusFromPhase("Running")).toBe("idle");
  });

  test("an unknown or missing phase never reads as healthy", () => {
    // A newer OpenShell inventing a phase must not make a broken sandbox look
    // Ready — that is exactly how a dead agent looked fine before.
    expect(statusFromPhase("Hibernating")).toBe("unknown");
    expect(statusFromPhase(undefined)).toBe("unknown");
    expect(statusFromPhase("")).toBe("unknown");
    expect(statusFromPhase("   ")).toBe("unknown");
  });
});

describe("resolveSandboxStatus", () => {
  test("only a live PTY session upgrades a container to 'active'", () => {
    // Without a session all we honestly know is that a container exists.
    expect(resolveSandboxStatus({ phase: "Ready" })).toBe("idle");
    expect(resolveSandboxStatus({ phase: "Ready", hasLiveSession: true })).toBe("active");
  });

  test("unhealthy means provisioned-but-agent-never-came-up", () => {
    expect(resolveSandboxStatus({ phase: "Ready", unhealthy: true })).toBe("unhealthy");
    // Still starting is not yet unhealthy — the agent has not had its chance.
    expect(resolveSandboxStatus({ phase: "Provisioning", unhealthy: true })).toBe("starting");
    // Stopped is not unhealthy — it's just stopped.
    expect(resolveSandboxStatus({ phase: "Stopped", unhealthy: true })).toBe("stopped");
  });

  test("a failed sandbox stays failed even with a live session claim", () => {
    expect(resolveSandboxStatus({ phase: "Error", hasLiveSession: true })).toBe("failed");
  });

  test("deleting is never masked by other signals", () => {
    expect(resolveSandboxStatus({ phase: "Deleting", hasLiveSession: true, unhealthy: true })).toBe(
      "deleting",
    );
  });
});

describe("needsUserAttention", () => {
  test("warns ONLY on genuine failure", () => {
    expect(needsUserAttention("failed")).toBe(true);
    expect(needsUserAttention("unhealthy")).toBe(true);
  });

  test("never warns about a sandbox that is merely booting or idle", () => {
    // Warning on a healthy state trains the user to ignore the warning that
    // matters. Starting and idle are normal, not problems.
    expect(needsUserAttention("starting")).toBe(false);
    expect(needsUserAttention("idle")).toBe(false);
    expect(needsUserAttention("active")).toBe(false);
    expect(needsUserAttention("stopped")).toBe(false);
    expect(needsUserAttention("deleting")).toBe(false);
    expect(needsUserAttention("unknown")).toBe(false);
  });
});

describe("sortByStatus", () => {
  const rows = (...statuses: SandboxStatus[]) =>
    statuses.map((status, index) => ({ status, id: `s${index}` }));

  test("pins failures to the top", () => {
    const input = rows("idle", "active", "unhealthy", "stopped", "failed");
    expect(sortByStatus(input, (r) => r.status).map((r) => r.status)).toEqual([
      "failed",
      "unhealthy",
      "active",
      "idle",
      "stopped",
    ]);
  });

  test("is stable, so a 60s refresh does not reshuffle the list", () => {
    // Four rows of the same status must keep their incoming order. Without
    // stability the sidebar would visibly churn on every poll.
    const input = rows("idle", "idle", "idle", "idle");
    expect(sortByStatus(input, (r) => r.status).map((r) => r.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
  });

  test("leaves an already-ordered list untouched", () => {
    const input = rows("failed", "active", "idle");
    expect(sortByStatus(input, (r) => r.status).map((r) => r.id)).toEqual(["s0", "s1", "s2"]);
  });

  test("every status has a distinct rank", () => {
    const all: SandboxStatus[] = [
      "unhealthy",
      "failed",
      "active",
      "starting",
      "idle",
      "stopped",
      "deleting",
      "unknown",
    ];
    const ranks = all.map(sandboxStatusRank);
    expect(new Set(ranks).size).toBe(all.length);
  });
});

describe("formatSandboxAge", () => {
  const base = Date.parse("2026-07-27T12:00:00Z");

  test("parses the space-separated UTC timestamp openshell prints", () => {
    expect(formatSandboxAge("2026-07-27 11:58:00", base)).toBe("2m");
  });

  test("preserves an explicit timezone offset", () => {
    expect(formatSandboxAge("2026-07-27T17:28:00+05:30", base)).toBe("2m");
  });

  test("steps through the units and stays compact", () => {
    expect(formatSandboxAge("2026-07-27 11:59:30", base)).toBe("30s");
    expect(formatSandboxAge("2026-07-27 11:00:00", base)).toBe("1h");
    expect(formatSandboxAge("2026-07-25 12:00:00", base)).toBe("2d");
    expect(formatSandboxAge("2026-07-06 12:00:00", base)).toBe("3w");
  });

  test("never renders a negative age from a clock skew", () => {
    expect(formatSandboxAge("2026-07-27 12:00:30", base)).toBe("0s");
  });

  test("parses relative age strings from CLI output", () => {
    expect(formatSandboxAge("2 minutes ago", base)).toBe("2m");
    expect(formatSandboxAge("about an hour ago", base)).toBe("1h");
    expect(formatSandboxAge("3 days ago", base)).toBe("3d");
    expect(formatSandboxAge("a minute ago", base)).toBe("1m");
  });

  test("returns null when there is nothing to show", () => {
    // The caller omits the element entirely rather than rendering a dash.
    expect(formatSandboxAge(undefined, base)).toBeNull();
    expect(formatSandboxAge("not a date", base)).toBeNull();
  });
});
