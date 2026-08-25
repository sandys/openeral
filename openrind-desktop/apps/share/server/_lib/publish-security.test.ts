import test from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalRequest } from "./request-like.ts";
import {
  buildCorsHeaders,
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
