// Openrind Shell credential storage. Four secrets live here:
//   - databaseUrl       PostgreSQL connection string for the `_openrind` schema
//   - anthropicApiKey   Required by the gateway-managed Claude provider
//   - openrindGatewayApiKey  Optional cost-tracking API key
//   - elevenLabsApiKey  Optional cloud transcription key
//
// All values are encrypted at rest via Electron's safeStorage API (Keychain
// on macOS, DPAPI on Windows, libsecret/kwallet on Linux). The renderer
// never sees the plaintext — only "set"/"unset" status flags. The
// fuse-sandbox.mjs reads decrypted values in the main process. DATABASE_URL is
// staged as the one-time README upload; ANTHROPIC_API_KEY is passed only to the
// local OpenShell CLI so the gateway can store it as a provider credential.
//
// Electron is loaded LAZILY (inside each function) so this module can be
// imported under node --test on a dev box that doesn't ship electron.
// When OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR is set, the module reads/writes
// plain files inside that directory instead — a test seam for the
// FUSE sandbox suite.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), ".openrind-desktop", "openrind-shell-credentials.json");

function credentialsFile() {
  return process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
}

function testCredentialsDir() {
  return process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR || null;
}

async function getSafeStorage() {
  const { safeStorage } = await import("electron");
  return safeStorage;
}

/** @typedef {"databaseUrl" | "anthropicApiKey" | "openrindGatewayApiKey" | "elevenLabsApiKey"} CredentialKey */

const CREDENTIAL_KEYS = /** @type {const} */ ([
  "databaseUrl",
  "anthropicApiKey",
  "openrindGatewayApiKey",
  // ElevenLabs Scribe API key used by desktop voice dictation.
  "elevenLabsApiKey",
]);

function maskValue(value) {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function isKnownKey(key) {
  return CREDENTIAL_KEYS.includes(key);
}

async function loadBlob() {
  try {
    const text = await readFile(credentialsFile(), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveBlob(blob) {
  await mkdir(path.dirname(credentialsFile()), { recursive: true });
  // Mode 0o600 caps the impact of safeStorage's fallback "basic" backend on
  // Linux systems without a keyring — even if the encryption is weak, only
  // this user can read the file.
  await writeFile(credentialsFile(), JSON.stringify(blob, null, 2), { mode: 0o600 });
}

/**
 * Encrypt and persist a credential. Throws if safeStorage's backend isn't
 * available (some headless Linux environments). UI surfaces the error so
 * the user knows secrets won't be stored.
 */
export async function setCredential(key, value) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  // Trim whitespace before storing. Users routinely paste from
  // dashboards / 1Password with a trailing newline or space, and a
  // postgres URL with " " on the end produces a confusing
  // "password authentication failed for user 'postgres'" downstream
  // because pg's URL parser treats trailing whitespace as part of the
  // password.
  const plaintext = String(value ?? "").trim();
  if (!plaintext) {
    throw new Error("Credential value is empty.");
  }
  // Test seam: when OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR is set, write a plain
  // file in that dir. The credential test suite uses this to stub
  // credentials without needing the Electron runtime.
  const testDir = testCredentialsDir();
  if (testDir) {
    await mkdir(testDir, { recursive: true });
    await writeFile(path.join(testDir, key), plaintext, { mode: 0o600 });
    return;
  }
  const safeStorage = await getSafeStorage();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Encryption is not available on this system (no keyring detected). " +
        "Cannot store Openrind Shell credentials securely. " +
        "Install gnome-keyring or kwallet on Linux, or run from a logged-in desktop session.",
    );
  }
  const encrypted = safeStorage.encryptString(plaintext);
  const blob = await loadBlob();
  blob[key] = encrypted.toString("base64");
  if (!blob.updatedAt || typeof blob.updatedAt !== "object" || Array.isArray(blob.updatedAt)) {
    blob.updatedAt = {};
  }
  blob.updatedAt[key] = Date.now();
  await saveBlob(blob);
}

export async function clearCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  const testDir = testCredentialsDir();
  if (testDir) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(testDir, key), { force: true });
    } catch {
      // Best-effort.
    }
    return;
  }
  const blob = await loadBlob();
  if (key in blob) {
    delete blob[key];
    if (blob.updatedAt && typeof blob.updatedAt === "object" && !Array.isArray(blob.updatedAt) && key in blob.updatedAt) {
      delete blob.updatedAt[key];
    }
    await saveBlob(blob);
  }
}

/**
 * Internal helper for the FUSE sandbox module. NEVER exposed
 * via IPC — the renderer reaches credentials only by name, never by
 * value. Returns null on missing or decrypt failure.
 */
export async function getCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  const testDir = testCredentialsDir();
  if (testDir) {
    try {
      return await readFile(path.join(testDir, key), "utf8");
    } catch {
      return null;
    }
  }
  const blob = await loadBlob();
  if (!blob[key]) return null;
  try {
    const safeStorage = await getSafeStorage();
    return safeStorage.decryptString(Buffer.from(blob[key], "base64"));
  } catch {
    // safeStorage backend keys change when the user switches keyrings or
    // when /run/keyring is rotated. A decrypt failure is recoverable —
    // the user re-enters the credential.
    return null;
  }
}

/**
 * Renderer-safe view of the credential state. Returns the literal string
 * "set" or "unset" per key — never the value. The renderer renders
 * status pills + Configure/Clear buttons from this shape alone.
 */
export async function getCredentialStatus() {
  const testDir = testCredentialsDir();
  const status = {};
  if (testDir) {
    for (const key of CREDENTIAL_KEYS) {
      try {
        const filePath = path.join(testDir, key);
        const val = await readFile(filePath, "utf8");
        status[key] = "set";
        status[`${key}_masked`] = maskValue(val);
        const { stat } = await import("node:fs/promises");
        const s = await stat(filePath).catch(() => null);
        status[`${key}_updatedAt`] = s ? s.mtimeMs : Date.now();
      } catch {
        status[key] = "unset";
      }
    }
    status.encryptionAvailable = true;
    return status;
  }
  const blob = await loadBlob();
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(credentialsFile()).catch(() => null);
  const fileMtime = fileStat ? fileStat.mtimeMs : Date.now();

  for (const key of CREDENTIAL_KEYS) {
    const isSet = !!blob[key];
    status[key] = isSet ? "set" : "unset";
    if (isSet) {
      const plaintext = await getCredential(key);
      if (plaintext) {
        status[`${key}_masked`] = maskValue(plaintext);
      }
      status[`${key}_updatedAt`] = (blob.updatedAt && blob.updatedAt[key]) || fileMtime;
    }
  }
  try {
    const safeStorage = await getSafeStorage();
    status.encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    status.encryptionAvailable = false;
  }
  return status;
}
