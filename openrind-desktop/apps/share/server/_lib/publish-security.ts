import { isIP } from "node:net";

import { checkBotId } from "botid/server";

type FixedWindowEntry = {
  count: number;
  resetAt: number;
};

export type FixedWindowRateLimitState = {
  entries: Map<string, FixedWindowEntry>;
  maxEntries: number;
  nextSweepAt: number;
  sweepIntervalMs: number;
};

const RATE_LIMIT_MAX_ENTRIES = 10_000;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;

const defaultAllowedOrigins = [
  "https://app.openrind-desktoplabs.com",
  "https://openrind-desktoplabs.com",
  "https://app.openrind-desktop.software",
  "https://openrind-desktop.software",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3006",
  "http://127.0.0.1:3006",
];

function now() {
  return Date.now();
}

function readClientIp(request: Request) {
  if (process.env.VERCEL !== "1") {
    return "unknown";
  }

  const forwarded = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  return isIP(forwarded) !== 0 ? forwarded.toLowerCase() : "unknown";
}

export function createFixedWindowRateLimitState(options: {
  maxEntries?: number;
  sweepIntervalMs?: number;
} = {}): FixedWindowRateLimitState {
  return {
    entries: new Map<string, FixedWindowEntry>(),
    maxEntries: Math.max(1, options.maxEntries ?? RATE_LIMIT_MAX_ENTRIES),
    nextSweepAt: 0,
    sweepIntervalMs: Math.max(1, options.sweepIntervalMs ?? RATE_LIMIT_SWEEP_INTERVAL_MS),
  };
}

const store = globalThis as typeof globalThis & {
  __openrindDesktopShareRateLimitState?: FixedWindowRateLimitState;
};

const rateLimitState = store.__openrindDesktopShareRateLimitState ?? createFixedWindowRateLimitState();
store.__openrindDesktopShareRateLimitState = rateLimitState;

function getRequestOrigin(request: Request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

export function getAllowedOrigins(request: Request) {
  const configured = String(process.env.OPENRIND_DESKTOP_PUBLISHER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([getRequestOrigin(request), ...defaultAllowedOrigins, ...configured].filter(Boolean));
}

export function buildCorsHeaders(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-OpenrindDesktop-Bundle-Type,X-OpenrindDesktop-Schema-Version,X-OpenrindDesktop-Name",
  };
  if (origin && getAllowedOrigins(request).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function validateTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin) {
    return { ok: false as const, status: 403, message: "A trusted browser origin is required." };
  }
  if (!getAllowedOrigins(request).has(origin)) {
    return { ok: false as const, status: 403, message: "Origin is not allowed to publish bundles." };
  }
  return { ok: true as const, origin };
}

export function applyFixedWindowRateLimit(
  input: {
    key: string;
    windowMs: number;
    max: number;
  },
  state = rateLimitState,
  currentTime = now(),
) {
  if (currentTime >= state.nextSweepAt) {
    for (const [key, entry] of state.entries) {
      if (entry.resetAt <= currentTime) {
        state.entries.delete(key);
      }
    }
    state.nextSweepAt = currentTime + state.sweepIntervalMs;
  }

  const current = state.entries.get(input.key);
  if (!current || current.resetAt <= currentTime) {
    if (current) {
      state.entries.delete(input.key);
    }
    if (state.entries.size >= state.maxEntries) {
      let earliestResetAt = Number.POSITIVE_INFINITY;
      for (const entry of state.entries.values()) {
        earliestResetAt = Math.min(earliestResetAt, entry.resetAt);
      }
      return {
        ok: false as const,
        retryAfterSeconds: Math.max(1, Math.ceil((earliestResetAt - currentTime) / 1000)),
      };
    }

    state.entries.set(input.key, { count: 1, resetAt: currentTime + input.windowMs });
    return { ok: true as const, retryAfterSeconds: 0 };
  }

  if (current.count >= input.max) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - currentTime) / 1000)),
    };
  }

  current.count += 1;
  state.entries.set(input.key, current);
  return { ok: true as const, retryAfterSeconds: 0 };
}

export function rateLimitPublishRequest(
  request: Request,
  state = rateLimitState,
  currentTime = now(),
) {
  return applyFixedWindowRateLimit(
    {
      key: `publish:${readClientIp(request)}`,
      windowMs: 60_000,
      max: 20,
    },
    state,
    currentTime,
  );
}

type BotIdChecker = () => Promise<{ isBot: boolean }>;

export async function verifyShareBotProtection(
  runBotIdCheck: BotIdChecker = checkBotId,
) {
  const result = await runBotIdCheck();
  if (result.isBot) {
    return { ok: false as const, status: 403, message: "Bot traffic is not allowed for bundle publishing." };
  }

  return { ok: true as const };
}
