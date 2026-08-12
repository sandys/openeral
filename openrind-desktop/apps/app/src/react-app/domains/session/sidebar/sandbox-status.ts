/**
 * Status vocabulary for Openrind Shell sandboxes.
 *
 * `openshell sandbox list` reports a coarse `phase`, which on its own is not
 * enough to tell the user what they need to know. Two distinctions matter and
 * both were learned the hard way:
 *
 *   - **"provisioned" is not "ready".** OpenShell reports phase `Ready` about a
 *     second after create — it means the container is registered, and nothing
 *     more. The workspace restore, the gateway and the agent all come later, so
 *     a sandbox at phase `Ready` may still take 40s of boot when you click it.
 *     Labelling that "Ready" is a lie the UI cannot back up, so this module
 *     never claims readiness from the phase alone.
 *
 *   - **`active` means "this app has a live PTY session", nothing more.** It is
 *     labelled "Connected" rather than "Agent running" on purpose: the session
 *     is created before setup.sh finishes, so the agent may still be booting.
 *     Without a session, all we honestly know is that a container exists:
 *     `idle`, labelled "Not connected".
 *
 *     Making the label any stronger than that needs the terminal's own paint
 *     signal plumbed up here — which is also what would make `unhealthy`
 *     reachable. See the note on `unhealthy` in SandboxStatusInput.
 *
 *   - **Warnings are reserved for failure.** Only `failed` and `unhealthy` are
 *     warnings. A sandbox that is merely booting or idle is not a problem and
 *     must not be dressed as one.
 *
 * This module is deliberately pure so the ranking and the phase mapping can be
 * tested without a renderer or a live gateway.
 */

export type SandboxStatus =
  | "unhealthy"
  | "failed"
  | "active"
  | "starting"
  | "idle"
  | "stopped"
  | "deleting"
  | "unknown";

export type SandboxStatusInput = {
  /** Raw `phase` from `openshell sandbox list`. */
  phase?: string | undefined;
  /** A PTY session for this sandbox exists in this app — the only proof the
   *  agent is actually running. */
  hasLiveSession?: boolean | undefined;
  /**
   * Container is up but the agent never rendered.
   *
   * NOT CURRENTLY SUPPLIED by any caller: only the terminal knows this (it is
   * the same condition behind its "no agent output after 75s" hint), and that
   * signal is not yet plumbed to the sidebar. Kept because the status model is
   * meaningless without it — but it means `unhealthy` is presently unreachable,
   * so do not read a green/gray dot as proof the agent is healthy.
   */
  unhealthy?: boolean | undefined;
};

/**
 * Rank for list ordering. Lower sorts first.
 *
 * Ordered by "how much does this want a human": things that are blocked or
 * broken, then things that are working, then things that are idle. Everything
 * inside a rank keeps its incoming order, so rows only move when their status
 * genuinely changes.
 */
const STATUS_RANK: Record<SandboxStatus, number> = {
  failed: 0,
  unhealthy: 1,
  active: 2,
  starting: 3,
  idle: 4,
  stopped: 5,
  deleting: 6,
  unknown: 7,
};

/**
 * Statuses that are genuine problems and therefore warrant a warning.
 *
 * Deliberately NOT including `starting`, `idle` or `unknown`: a sandbox that is
 * booting or simply not connected is normal, and warning about it trains the
 * user to ignore the warning that matters.
 */
const ATTENTION_STATUSES = new Set<SandboxStatus>(["unhealthy", "failed"]);

export function needsUserAttention(status: SandboxStatus): boolean {
  return ATTENTION_STATUSES.has(status);
}

/**
 * Map a raw phase string to a status, ignoring the richer signals.
 *
 * Matching is case-insensitive and tolerant: an unrecognised phase becomes
 * `unknown` rather than being silently treated as healthy. A newer OpenShell
 * that invents a phase must not make a broken sandbox look Ready.
 */
export function statusFromPhase(phase: string | undefined): SandboxStatus {
  const value = (phase ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value.includes("provision") || value.includes("pending") || value.includes("creat")) {
    return "starting";
  }
  if (value.includes("start")) return "starting";
  if (value.includes("delet") || value.includes("terminat")) return "deleting";
  if (value.includes("error") || value.includes("fail")) return "failed";
  if (value.includes("stop") || value.includes("exit")) return "stopped";
  // NOTE: phase `Ready` deliberately maps to `idle`, not a "ready" state. It
  // only tells us the container is registered — see the header comment.
  if (value.includes("ready") || value.includes("running")) return "idle";
  return "unknown";
}

/**
 * Resolve the status shown in the UI.
 *
 * A live PTY session is the only thing that upgrades a container to `active`;
 * `unhealthy` is only meaningful once provisioning finished, so a still-starting
 * sandbox is never reported as unhealthy.
 */
export function resolveSandboxStatus(input: SandboxStatusInput): SandboxStatus {
  const base = statusFromPhase(input.phase);
  if (base === "starting" || base === "deleting" || base === "failed" || base === "stopped") return base;
  if (input.unhealthy) return "unhealthy";
  if (base === "idle") return input.hasLiveSession ? "active" : "idle";
  return base;
}

/** Sort key so callers can order a list without importing the rank table. */
export function sandboxStatusRank(status: SandboxStatus): number {
  return STATUS_RANK[status] ?? STATUS_RANK.unknown;
}

/**
 * Stable sort that pins failures to the top.
 *
 * Stability is the point: within one rank rows keep the order the gateway
 * returned them in, so the list does not reshuffle on every 60s refresh. Rows
 * move only when their status actually changes.
 */
export function sortByStatus<T>(
  items: readonly T[],
  statusOf: (item: T) => SandboxStatus,
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: sandboxStatusRank(statusOf(item)) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.item);
}

/**
 * Compact relative age, e.g. `3m`, `4h`, `2d`.
 *
 * Sidebar rows have very little horizontal room, so this stays under four
 * characters rather than spelling out "3 minutes ago". Returns null for a
 * missing or unparseable timestamp so the caller can omit the element entirely
 * instead of rendering a dash.
 */
export function formatSandboxAge(
  created: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!created) return null;
  const trimmed = created.trim();

  // The desktop CLI list parser might supply relative age text like "2 minutes ago".
  const match = trimmed.toLowerCase().match(/^(?:about )?(?:a |an |(\d+)\s+)?(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (match) {
    const value = match[1] ? parseInt(match[1], 10) : 1;
    const unit = match[2];
    if (unit === "second") return `${value}s`;
    if (unit === "minute") return `${value}m`;
    if (unit === "hour") return `${value}h`;
    if (unit === "day") return `${value}d`;
    if (unit === "week") return `${value}w`;
    if (unit === "month") return `${value}mo`;
    if (unit === "year") return `${value}y`;
  }

  // `openshell sandbox list` prints local time without a zone ("2026-07-27
  // 09:01:33"), which Date.parse reads as local on every engine we target.
  const normalized = trimmed.replace(" ", "T");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
