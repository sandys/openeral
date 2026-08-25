import test from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalRequest } from "./request-like.ts";
import {
  applyFixedWindowRateLimit,
  buildCorsHeaders,
  createFixedWindowRateLimitState,
  rateLimitPublishRequest,
  validateTrustedOrigin,
  verifyShareBotProtection,
} from "./publish-security.ts";

test("buildCanonicalRequest pins legacy publish routes to the fixed share origin", () => {
  const request = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      origin: "https://openrind-desktoplabs.com",
    },
  });

  assert.equal(new URL(request.url).origin, "https://share.openrind-desktoplabs.com");
});

test("buildCorsHeaders reflects only trusted publisher origins", () => {
  const trustedRequest = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: { origin: "https://openrind-desktoplabs.com" },
  });
  const trustedHeaders = buildCorsHeaders(trustedRequest);

  assert.equal(trustedHeaders["Access-Control-Allow-Origin"], "https://openrind-desktoplabs.com");
  assert.equal(trustedHeaders.Vary, "Origin");

  const untrustedRequest = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  const untrustedHeaders = buildCorsHeaders(untrustedRequest);

  assert.equal(untrustedHeaders["Access-Control-Allow-Origin"], undefined);
  assert.equal(validateTrustedOrigin(untrustedRequest).ok, false);
});

test("verifyShareBotProtection always runs BotID and rejects detected bots", async () => {
  let checks = 0;
  const result = await verifyShareBotProtection(async () => {
    checks += 1;
    return { isBot: true };
  });

  assert.equal(checks, 1);
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    message: "Bot traffic is not allowed for bundle publishing.",
  });
});

test("verifyShareBotProtection allows requests only after BotID classifies them as human", async () => {
  let checks = 0;
  const result = await verifyShareBotProtection(async () => {
    checks += 1;
    return { isBot: false };
  });

  assert.equal(checks, 1);
  assert.deepEqual(result, { ok: true });
});

test("rateLimitPublishRequest ignores client-supplied forwarding headers outside Vercel", () => {
  const previousVercel = process.env.VERCEL;
  delete process.env.VERCEL;

  try {
    const state = createFixedWindowRateLimitState();
    for (let index = 0; index < 20; index += 1) {
      const request = new Request("https://share.openrind-desktoplabs.com/api/v1/bundles", {
        headers: {
          "x-forwarded-for": `198.51.100.${index}`,
          "x-real-ip": `203.0.113.${index}`,
        },
      });
      assert.equal(rateLimitPublishRequest(request, state, 1_000).ok, true);
    }

    const spoofedRequest = new Request("https://share.openrind-desktoplabs.com/api/v1/bundles", {
      headers: {
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.2",
      },
    });
    assert.equal(rateLimitPublishRequest(spoofedRequest, state, 1_000).ok, false);
    assert.equal(state.entries.size, 1);
  } finally {
    if (previousVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = previousVercel;
    }
  }
});

test("rateLimitPublishRequest uses Vercel's normalized client IP header", () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = "1";

  try {
    const state = createFixedWindowRateLimitState();
    for (let index = 0; index < 20; index += 1) {
      const request = new Request("https://share.openrind-desktoplabs.com/api/v1/bundles", {
        headers: {
          "x-vercel-forwarded-for": "198.51.100.10",
          "x-forwarded-for": `192.0.2.${index}`,
        },
      });
      assert.equal(rateLimitPublishRequest(request, state, 1_000).ok, true);
    }

    const otherClient = new Request("https://share.openrind-desktoplabs.com/api/v1/bundles", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.20",
        "x-forwarded-for": "198.51.100.10",
      },
    });
    assert.equal(rateLimitPublishRequest(otherClient, state, 1_000).ok, true);
    assert.equal(state.entries.size, 2);
  } finally {
    if (previousVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = previousVercel;
    }
  }
});

test("applyFixedWindowRateLimit removes expired entries during scheduled sweeps", () => {
  const state = createFixedWindowRateLimitState({ maxEntries: 2, sweepIntervalMs: 10 });
  assert.equal(applyFixedWindowRateLimit({ key: "first", windowMs: 5, max: 1 }, state, 0).ok, true);
  assert.equal(applyFixedWindowRateLimit({ key: "second", windowMs: 5, max: 1 }, state, 0).ok, true);
  assert.equal(state.entries.size, 2);

  assert.equal(applyFixedWindowRateLimit({ key: "third", windowMs: 5, max: 1 }, state, 11).ok, true);
  assert.deepEqual([...state.entries.keys()], ["third"]);
});

test("applyFixedWindowRateLimit fails closed when the active-key cap is reached", () => {
  const state = createFixedWindowRateLimitState({ maxEntries: 2, sweepIntervalMs: 60_000 });
  assert.equal(applyFixedWindowRateLimit({ key: "first", windowMs: 60_000, max: 1 }, state, 0).ok, true);
  assert.equal(applyFixedWindowRateLimit({ key: "second", windowMs: 60_000, max: 1 }, state, 0).ok, true);

  const overflow = applyFixedWindowRateLimit({ key: "third", windowMs: 60_000, max: 1 }, state, 0);
  assert.equal(overflow.ok, false);
  assert.equal(state.entries.size, 2);
});
