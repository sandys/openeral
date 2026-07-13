import { strict as assert } from "node:assert";

import { describeBundleUrlTrust, isConfiguredBundlePublisherUrl } from "../src/app/bundles/url-policy";

const trusted = describeBundleUrlTrust(
  "https://share.openrind-desktoplabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "https://share.openrind-desktoplabs.com",
);

assert.deepEqual(trusted, {
  trusted: true,
  bundleId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  actualOrigin: "https://share.openrind-desktoplabs.com",
  configuredOrigin: "https://share.openrind-desktoplabs.com",
});

const untrusted = describeBundleUrlTrust(
  "https://evil.example/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "https://share.openrind-desktoplabs.com",
);

assert.deepEqual(untrusted, {
  trusted: false,
  bundleId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  actualOrigin: "https://evil.example",
  configuredOrigin: "https://share.openrind-desktoplabs.com",
});

assert.equal(
  isConfiguredBundlePublisherUrl(
    "https://share.openrind-desktoplabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "https://share.openrind-desktoplabs.com",
  ),
  true,
);

assert.equal(
  isConfiguredBundlePublisherUrl(
    "https://share.openrind-desktoplabs.com/not-a-bundle",
    "https://share.openrind-desktoplabs.com",
  ),
  false,
);

console.log("bundle-url-policy ok");
