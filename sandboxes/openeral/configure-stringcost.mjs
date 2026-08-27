#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const projectHome = process.env.OPENRIND_SHELL_HOME || process.env.OPENERAL_HOME || '/sandbox/work';
const claudeHome = process.env.OPENRIND_SHELL_CLAUDE_HOME || projectHome;
const runtimeDir = process.env.OPENRIND_SHELL_RUNTIME_DIR
  || process.env.OPENERAL_RUNTIME_DIR
  || '/var/lib/openrind-shell/runtime';
const presignPath = join(projectHome, '.openrind-shell', 'presign.json');
const legacyPresignPath = join(projectHome, '.openeral', 'presign.json');
const settingsPath = join(claudeHome, '.claude', 'settings.json');
const baseUrlPath = join(runtimeDir, 'anthropic-base-url');

function normalize(raw) {
  const match = String(raw || '').trim().match(
    /https:\/\/(?:proxy\.openrind\.com\/openrind-gateway-proxy|proxy\.stringcost\.com\/stringcost-proxy)\/t\/[^\s"'<>]+/,
  );
  if (!match) return '';
  const url = new URL(match[0]);
  url.pathname = url.pathname.replace(/\/v1\/.*$/, '');
  url.search = '';
  url.hash = '';
  const value = url.toString().replace(/\/$/, '');
  return /^https:\/\/(?:proxy\.openrind\.com\/openrind-gateway-proxy|proxy\.stringcost\.com\/stringcost-proxy)\/t\/[^/]+$/.test(value)
    ? value
    : '';
}

function uploadedPresign() {
  const candidates = [
    '/sandbox/openrind-gateway-presign',
    '/sandbox/openrind-gateway-url',
    '/sandbox/openrind-shell-input/presign.json',
    '/sandbox/openrind-shell-input/openrind-gateway-url',
    '/sandbox/stringcost-presign',
    '/sandbox/stringcost-url',
    '/sandbox/openeral-input/presign.json',
    '/sandbox/openeral-input/stringcost-url',
  ];
  const cleanupPaths = [];
  let found = '';
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    cleanupPaths.push(root);
    for (const path of filesUnder(root)) {
      try {
        const raw = readFileSync(path, 'utf8').trim();
        let value = raw;
        try { value = JSON.parse(raw)?.url || ''; } catch {}
        found ||= normalize(value);
      } catch {}
    }
  }
  return { cleanupPaths, url: found };
}

function filesUnder(path, depth = 0) {
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) return [path];
    if (!stat.isDirectory() || depth >= 3) return [];
    return readdirSync(path).flatMap((name) => filesUnder(join(path, name), depth + 1));
  } catch {
    return [];
  }
}

function storedPresign() {
  for (const path of [presignPath, legacyPresignPath]) {
    try {
      const value = normalize(JSON.parse(readFileSync(path, 'utf8'))?.url || '');
      if (value) return value;
    } catch {
      // Continue to the legacy location.
    }
  }
  return '';
}

async function createPresign() {
  const openrindKey = process.env.OPENRIND_GATEWAY_API_KEY;
  const legacyKey = process.env.STRINGCOST_API_KEY;
  const gatewayKey = openrindKey || legacyKey;
  if (!gatewayKey || !process.env.ANTHROPIC_API_KEY) return '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(
      openrindKey ? 'https://app.openrind.com/v1/presign' : 'https://app.stringcost.com/v1/presign',
      {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: process.env.ANTHROPIC_API_KEY,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10_000_000,
        metadata: {
          source: 'openrind-shell-fuse-sandbox',
          client: 'claude-code',
          labels: ['openrind-shell', 'claude-code'],
        },
      }),
      signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`presign failed (${response.status}): ${await response.text()}`);
    }
    return normalize((await response.json())?.url || '');
  } finally {
    clearTimeout(timeout);
  }
}

function persist(baseUrl) {
  mkdirSync(dirname(presignPath), { recursive: true });
  writeFileSync(
    presignPath,
    `${JSON.stringify({ url: baseUrl, updated_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(presignPath, 0o600);

  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  settings.env.ANTHROPIC_BASE_URL = baseUrl;
  delete settings.env.ANTHROPIC_API_KEY;
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  delete settings.env.CLAUDE_CODE_SUBAGENT_MODEL;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  writeFileSync(baseUrlPath, `${baseUrl}\n`, { mode: 0o600 });
  chmodSync(baseUrlPath, 0o600);
}

async function main() {
  mkdirSync(runtimeDir, { recursive: true });
  const uploaded = uploadedPresign();
  let baseUrl = normalize(process.env.OPENRIND_GATEWAY_PROXY_URL)
    || normalize(process.env.STRINGCOST_PROXY_URL)
    || uploaded.url
    || storedPresign();
  if (!baseUrl) {
    try {
      baseUrl = await createPresign();
    } catch (error) {
      process.stderr.write(`setup-fuse.sh: Openrind Gateway presign failed: ${error.message}\n`);
    }
  }

  if (baseUrl) {
    persist(baseUrl);
    process.stdout.write('setup-fuse.sh: Openrind Gateway proxy configured\n');
  } else {
    rmSync(baseUrlPath, { force: true });
  }
  for (const path of uploaded.cleanupPaths) rmSync(path, { force: true, recursive: true });
}

main().catch((error) => {
  process.stderr.write(`setup-fuse.sh: Openrind Gateway configuration failed: ${error.message}\n`);
  process.exit(1);
});
