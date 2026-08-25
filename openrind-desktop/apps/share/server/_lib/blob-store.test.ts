import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  fetchBundleJsonById,
  isValidBundleId,
  storeBundleJson,
} from "./blob-store.ts";

test("bundle IDs must use the canonical generated ULID format", () => {
  assert.equal(isValidBundleId("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true);
  assert.equal(isValidBundleId("81ARZ3NDEKTSV4RRFFQ69G5FAV"), false);
  assert.equal(isValidBundleId("01arz3ndektsv4rrffq69g5fav"), false);
  assert.equal(isValidBundleId("../../secret"), false);
  assert.equal(isValidBundleId("01ARZ3NDEKTSV4RRFFQ69G5FA"), false);
});

test("local blob reads reject traversal before accessing the filesystem", async (t) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "openrind-share-blob-test-"));
  const localBlobDir = path.join(testRoot, "blobs");
  const previousLocalBlobDir = process.env.LOCAL_BLOB_DIR;

  process.env.LOCAL_BLOB_DIR = localBlobDir;
  await mkdir(localBlobDir, { recursive: true });
  await writeFile(path.join(testRoot, "secret.json"), "outside storage", "utf8");

  t.after(async () => {
    if (previousLocalBlobDir === undefined) {
      delete process.env.LOCAL_BLOB_DIR;
    } else {
      process.env.LOCAL_BLOB_DIR = previousLocalBlobDir;
    }
    await rm(testRoot, { recursive: true, force: true });
  });

  await assert.rejects(fetchBundleJsonById("../../secret"), /Invalid bundle ID/);
});

test("locally stored bundles remain readable by their generated ID", async (t) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "openrind-share-blob-test-"));
  const previousLocalBlobDir = process.env.LOCAL_BLOB_DIR;
  process.env.LOCAL_BLOB_DIR = testRoot;

  t.after(async () => {
    if (previousLocalBlobDir === undefined) {
      delete process.env.LOCAL_BLOB_DIR;
    } else {
      process.env.LOCAL_BLOB_DIR = previousLocalBlobDir;
    }
    await rm(testRoot, { recursive: true, force: true });
  });

  const stored = await storeBundleJson('{"safe":true}');
  assert.equal(isValidBundleId(stored.id), true);

  const fetched = await fetchBundleJsonById(stored.id);
  assert.equal(fetched.rawJson, '{"safe":true}');
});
