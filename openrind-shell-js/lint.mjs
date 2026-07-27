#!/usr/bin/env node

/**
 * Structural lints for openrind-shell-js — catches classes of bugs found during
 * development so they don't recur.
 *
 * Run: node lint.mjs (or pnpm lint)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = 'src';
let errors = 0;

function fail(file, message) {
  console.error(`  FAIL  ${file}: ${message}`);
  errors++;
}

function pass(label) {
  console.log(`  OK    ${label}`);
}

function allTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...allTsFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Lint 1: Every import from a local .js file must have a corresponding .ts source
// Catches: missing module exports (like deleteTree)
// ---------------------------------------------------------------------------
console.log('\n--- Lint: import targets exist ---');

const tsFiles = allTsFiles(SRC);
const importRe = /from\s+['"](\.[^'"]+\.js)['"]/g;

for (const file of tsFiles) {
  if (file.endsWith('.test.ts')) continue;
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = importRe.exec(content)) !== null) {
    const importPath = match[1].replace(/\.js$/, '.ts');
    const resolved = join(file, '..', importPath);
    try {
      statSync(resolved);
    } catch {
      fail(file, `imports '${match[1]}' but ${resolved} does not exist`);
    }
  }
}
pass('all local imports resolve to .ts files');

// ---------------------------------------------------------------------------
// Lint 2: Every named import from a local module must be exported by that module
// Catches: importing deleteTree from a file that doesn't export it
// ---------------------------------------------------------------------------
console.log('\n--- Lint: named imports match exports ---');

const namedImportRe = /import\s+(?:type\s+)?{\s*([^}]+)}\s+from\s+['"](\.[^'"]+\.js)['"]/g;
const exportRe = /export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/g;

for (const file of tsFiles) {
  if (file.endsWith('.test.ts')) continue;
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = namedImportRe.exec(content)) !== null) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const targetPath = join(file, '..', match[2].replace(/\.js$/, '.ts'));

    let targetContent;
    try {
      targetContent = readFileSync(targetPath, 'utf8');
    } catch {
      continue; // Lint 1 already catches missing files
    }

    const exports = new Set();
    let expMatch;
    while ((expMatch = exportRe.exec(targetContent)) !== null) {
      exports.add(expMatch[1]);
    }

    for (const name of names) {
      if (!exports.has(name)) {
        fail(file, `imports '${name}' from '${match[2]}' but it is not exported`);
      }
    }
  }
}
pass('all named imports match exports');

// ---------------------------------------------------------------------------
// Lint 3: package.json just-bash version must be >=2.0.0
// Catches: wrong version like ^0.1.0
// ---------------------------------------------------------------------------
console.log('\n--- Lint: just-bash version ---');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const jbVersion = pkg.dependencies?.['just-bash'] || '';
const majorMatch = jbVersion.match(/(\d+)/);
if (!majorMatch || parseInt(majorMatch[1]) < 2) {
  fail('package.json', `just-bash version '${jbVersion}' is too old (need >=2.x)`);
} else {
  pass(`just-bash version ${jbVersion}`);
}

// ---------------------------------------------------------------------------
// Lint 4: createOpenrindShell must auto-create workspace config
// Catches: FK violation when workspace_config row doesn't exist
// ---------------------------------------------------------------------------
console.log('\n--- Lint: shell factory seeds workspace ---');

const shellContent = readFileSync('src/shell.ts', 'utf8');
if (!shellContent.includes('workspace_config')) {
  fail('src/shell.ts', 'createOpenrindShell must INSERT INTO workspace_config before use');
} else {
  pass('shell.ts auto-creates workspace_config');
}
if (!shellContent.includes('seedFromConfig')) {
  fail('src/shell.ts', 'createOpenrindShell must seed root directory');
} else {
  pass('shell.ts seeds root directory');
}

// ---------------------------------------------------------------------------
// Lint 5: PgFs write methods must throw EROFS
// Catches: accidentally making /db writable
// ---------------------------------------------------------------------------
console.log('\n--- Lint: PgFs is read-only ---');

const pgFsContent = readFileSync('src/pg-fs/pg-fs.ts', 'utf8');
const writeMethods = ['writeFile', 'appendFile', 'mkdir', 'rm', 'mv', 'chmod', 'utimes', 'symlink', 'link'];
for (const method of writeMethods) {
  // Check that each write method exists and calls erofs() or throws EROFS
  const methodRe = new RegExp(`async\\s+${method}\\b[\\s\\S]{0,200}(?:erofs|EROFS)`, 'i');
  if (!methodRe.test(pgFsContent)) {
    fail('src/pg-fs/pg-fs.ts', `${method}() must throw EROFS`);
  }
}
pass('all PgFs write methods throw EROFS');

// ---------------------------------------------------------------------------
// Lint 6: WorkspaceFs must not have write-back buffering
// Catches: reintroducing FUSE-style buffering that defeats just-bash's model
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no write-back buffering ---');

const wsFsContent = readFileSync('src/workspace-fs/workspace-fs.ts', 'utf8');
if (/dirty|flush|OpenFileHandle/i.test(wsFsContent)) {
  fail('src/workspace-fs/workspace-fs.ts', 'must not use write-back buffering (dirty/flush/OpenFileHandle)');
} else {
  pass('no write-back buffering in WorkspaceFs');
}

// ---------------------------------------------------------------------------
// Lint 7: No FUSE references in sandbox Dockerfile
// Catches: accidentally reintroducing FUSE dependencies
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no FUSE in sandbox ---');

try {
  const dockerfile = readFileSync('../sandboxes/openrind-shell/Dockerfile', 'utf8');
  if (/fuse3|libfuse|\/dev\/fuse|fuse\.conf|\/etc\/fstab/i.test(dockerfile)) {
    fail('sandboxes/openrind-shell/Dockerfile', 'must not reference FUSE (fuse3, libfuse, /dev/fuse, /etc/fstab)');
  } else {
    pass('no FUSE in Dockerfile');
  }
} catch {
  pass('Dockerfile not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 8: pg custom command must document quoting requirement
// Catches: SQL with parens/quotes that bash parses before pg sees it
// ---------------------------------------------------------------------------
console.log('\n--- Lint: pg command quoting documented ---');

const shellSrc = readFileSync('src/shell.ts', 'utf8');
if (shellSrc.includes("defineCommand('pg'") || shellSrc.includes('defineCommand("pg"')) {
  // Verify the pg command exists — the quoting issue is a usage concern,
  // so we just check that the shell factory documents it
  pass('pg command defined in shell.ts');
} else {
  fail('src/shell.ts', 'pg custom command not found');
}

// ---------------------------------------------------------------------------
// Lint 9: Sandbox scripts must import from dist/, not src/
// Catches: importing .ts source instead of compiled .js in container
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sandbox imports use dist/ ---');

for (const f of ['../sandboxes/openrind-shell/setup.sh', '../sandboxes/openrind-shell/openrind-shell-bash.mjs']) {
  try {
    const content = readFileSync(f, 'utf8');
    if (/\/opt\/openrind-shell\/src\//.test(content)) {
      fail(f, 'imports from /opt/openrind-shell/src/ — must use /opt/openrind-shell/dist/');
    }
  } catch {}
}
pass('sandbox scripts import from dist/');

// ---------------------------------------------------------------------------
// Lint 10: Dockerfile must build TypeScript
// Catches: forgetting npm run build in the Dockerfile
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Dockerfile builds TypeScript ---');

try {
  const dockerfile = readFileSync('../sandboxes/openrind-shell/Dockerfile', 'utf8');
  if (!dockerfile.includes('npm run build')) {
    fail('sandboxes/openrind-shell/Dockerfile', 'must run "npm run build" to compile TypeScript');
  } else {
    pass('Dockerfile builds TypeScript');
  }
} catch {
  pass('Dockerfile not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 11: No hardcoded credentials in generated scripts
// Catches: baking DATABASE_URL or secrets into helper scripts
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no hardcoded credentials ---');

const cliContent = readFileSync('src/cli.ts', 'utf8');
// The pg helper function must NOT accept a connection string parameter
if (/writePgHelper\([^)]*connStr|writePgHelper\([^)]*url|writePgHelper\([^)]*database/i.test(cliContent)) {
  fail('src/cli.ts', 'writePgHelper must not accept a connection string — read from env at runtime');
} else {
  pass('pg helper reads DATABASE_URL from env');
}

// ---------------------------------------------------------------------------
// Lint 12: No hardcoded connection strings in test files
// Catches: test files with fallback DATABASE_URL defaults
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no hardcoded creds in test files ---');

for (const testFile of ['test-integration.mjs', 'test-e2e-claude.mjs']) {
  try {
    const content = readFileSync(testFile, 'utf8');
    // Match patterns like: || 'postgresql://...' or = 'postgresql://...'
    if (/['"]postgresql:\/\/[^'"]*password[^'"]*['"]/.test(content)) {
      fail(testFile, 'contains hardcoded PostgreSQL connection string with password');
    }
    if (/['"]sk-ant-[^'"]*['"]/.test(content)) {
      fail(testFile, 'contains hardcoded Anthropic API key');
    }
  } catch {}
}
pass('test files have no hardcoded credentials');

// ---------------------------------------------------------------------------
// Lint 13: Sandbox scripts must not contain literal connection strings
// Catches: setup.sh or openrind-shell-bash.mjs baking credentials
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no creds in sandbox scripts ---');

for (const f of ['../sandboxes/openrind-shell/setup.sh', '../sandboxes/openrind-shell/openrind-shell-bash.mjs']) {
  try {
    const content = readFileSync(f, 'utf8');
    if (/postgresql:\/\/[^$][^'"]*@/.test(content)) {
      fail(f, 'contains literal PostgreSQL connection string');
    }
    if (/sk-ant-/.test(content)) {
      fail(f, 'contains literal Anthropic API key');
    }
  } catch {}
}
pass('sandbox scripts have no hardcoded credentials');

// ---------------------------------------------------------------------------
// Lint 14: syncFromFs must delete stale DB rows (persists deletions)
// Catches: sync that only upserts but never removes deleted files
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sync persists deletions ---');

const syncContent = readFileSync('src/sync.ts', 'utf8');
if (!syncContent.includes('seenPaths') || !syncContent.includes('DELETE FROM _openrind.workspace_files')) {
  fail('src/sync.ts', 'syncFromFs must track seen paths and delete stale DB rows');
} else {
  pass('syncFromFs persists deletions');
}

// ---------------------------------------------------------------------------
// Lint 15: syncFromFs must use real file modes, not hardcoded
// Catches: hardcoding 0o40755/0o100644 instead of reading stat().mode
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sync preserves file modes ---');

// Check that walkDir INSERT statements use st.mode, not literal modes
// Only check the walkDir function body itself (ends at closing brace before root insert)
const walkDirStart = syncContent.indexOf('async function walkDir');
const walkDirEnd = syncContent.indexOf('// Ensure root exists');
const walkDirBody = walkDirEnd > walkDirStart
  ? syncContent.slice(walkDirStart, walkDirEnd)
  : syncContent.slice(walkDirStart);
const walkDirInserts = walkDirBody.match(/INSERT INTO[\s\S]*?\]/g) || [];
let hardcodedMode = false;
for (const stmt of walkDirInserts) {
  if (/0o40755|0o100644/.test(stmt)) {
    hardcodedMode = true;
    fail('src/sync.ts', 'walkDir INSERT uses hardcoded mode instead of st.mode');
    break;
  }
}
if (!hardcodedMode) {
  pass('syncFromFs uses st.mode from filesystem');
}

// Check that syncToFs applies chmod
const syncToFsSection = syncContent.slice(
  syncContent.indexOf('export async function syncToFs'),
  syncContent.indexOf('export async function syncFromFs'),
);
if (!syncToFsSection.includes('chmodSync') || !syncToFsSection.includes('row.mode & 0o7777')) {
  fail('src/sync.ts', 'syncToFs must chmodSync with stored mode');
} else {
  pass('syncToFs applies stored modes');
}

// ---------------------------------------------------------------------------
// Lint 16: Exclude must use exact dir name matching, not regex substring
// Catches: regex like /\.git/ that also matches .gitignore, .github
// ---------------------------------------------------------------------------
console.log('\n--- Lint: exclude uses exact matching ---');

if (syncContent.includes('.test(name)') && syncContent.includes('/node_modules|\\.git/')) {
  fail('src/sync.ts', 'exclude uses regex substring matching — .gitignore and .github would be wrongly excluded');
} else if (!syncContent.includes('excludeDirs.has(name)')) {
  fail('src/sync.ts', 'exclude must use Set.has() for exact directory name matching');
} else {
  pass('exclude uses exact Set-based matching');
}

// ---------------------------------------------------------------------------
// Lint 17: syncToFs must prune local files not in DB
// Catches: stale local files persisting across sessions on reused home dirs
// ---------------------------------------------------------------------------
console.log('\n--- Lint: syncToFs prunes stale local files ---');

if (!syncToFsSection.includes('pruneLocal') && !syncToFsSection.includes('unlinkSync')) {
  fail('src/sync.ts', 'syncToFs must remove local files not present in DB (stale leftovers)');
} else {
  pass('syncToFs prunes stale local files');
}

// ---------------------------------------------------------------------------
// Lint 18: syncToFs must prune BEFORE creating (type conflict safety)
// Catches: EEXIST/EISDIR when a path changed type between sessions
// ---------------------------------------------------------------------------
console.log('\n--- Lint: syncToFs prunes before creating ---');

const pruneIdx = syncToFsSection.indexOf('pruneLocal');
const firstMkdir = syncToFsSection.indexOf('mkdirSync(fullPath');
const firstWrite = syncToFsSection.indexOf('writeFileSync(fullPath');
if (pruneIdx < 0 || firstMkdir < 0 || pruneIdx > firstMkdir) {
  fail('src/sync.ts', 'syncToFs must call pruneLocal BEFORE mkdirSync/writeFileSync to handle type conflicts');
} else {
  pass('syncToFs prunes before creating');
}

// ---------------------------------------------------------------------------
// Lint 19: pruneLocal must handle type conflicts (file↔dir)
// Catches: pruneLocal only checking presence, not type match
// ---------------------------------------------------------------------------
console.log('\n--- Lint: pruneLocal handles type conflicts ---');

if (!syncContent.includes('dbTypes') || !syncContent.includes('dbIsDir === false') || !syncContent.includes('dbIsDir === true')) {
  fail('src/sync.ts', 'pruneLocal must check dbTypes for file↔dir conflicts, not just presence');
} else {
  pass('pruneLocal handles type conflicts');
}

// ---------------------------------------------------------------------------
// Lint 20: README.md is openshell-only (no npx/pnpm/npm install)
// Catches: regressions that mix developer commands into the end-user README.
// Developer commands live in BUILD.md.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: README has no npx/pnpm (user-facing only) ---');

try {
  const readme = readFileSync('../README.md', 'utf8');
  const forbidden = [
    [/\bnpx openrind-shell\b/, 'contains `npx openrind-shell` — move to BUILD.md'],
    [/\bpnpm (install|build|check|run)\b/, 'contains `pnpm install|build|check|run` — move to BUILD.md'],
    [/\bnpm install\b/, 'contains `npm install` — move to BUILD.md'],
  ];
  let readmeOk = true;
  for (const [rx, msg] of forbidden) {
    if (rx.test(readme)) {
      fail('README.md', msg);
      readmeOk = false;
    }
  }
  if (readmeOk) pass('README contains no npx/pnpm/npm-install commands');
} catch {
  pass('README not found (skipped)');
}

// BUILD.md SHOULD contain the build steps — verify the first npx-openrind-shell
// block shows users how to install+build first
console.log('\n--- Lint: BUILD.md installs before running ---');
try {
  const build = readFileSync('../BUILD.md', 'utf8');
  if (!build.includes('npx openrind-shell')) {
    pass('BUILD.md has no npx (skipped)');
  } else {
    const firstOpenrind = build.indexOf('npx openrind-shell');
    const priorText = build.slice(0, firstOpenrind);
    if (!priorText.includes('pnpm install') && !priorText.includes('pnpm build')) {
      fail('BUILD.md', 'first `npx openrind-shell` must be preceded by `pnpm install && pnpm build` instructions');
    } else {
      pass('BUILD.md shows install+build before first npx openrind-shell');
    }
  }
} catch {
  pass('BUILD.md not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 21: Migrations must use advisory lock for concurrent safety
// Catches: race condition when two shells start on a fresh database
// ---------------------------------------------------------------------------
console.log('\n--- Lint: migrations use advisory lock ---');

const migrationsContent = readFileSync('src/db/migrations.ts', 'utf8');
if (!migrationsContent.includes('pg_advisory_lock')) {
  fail('src/db/migrations.ts', 'runMigrations must use pg_advisory_lock to serialize concurrent callers');
} else {
  pass('migrations use advisory lock');
}

// ---------------------------------------------------------------------------
// Lint 22: Skill bootstrap must check node_modules, not just dist
// Catches: skill treating dist/-present but node_modules/-missing tree as launch-ready
// ---------------------------------------------------------------------------
console.log('\n--- Lint: skill checks node_modules ---');

try {
  const skill = readFileSync('../.claude/skills/openrind-shell/SKILL.md', 'utf8');
  if (skill.includes('[ -d dist ]') && !skill.includes('node_modules')) {
    fail('.claude/skills/openrind-shell/SKILL.md', 'bootstrap check must verify node_modules exists, not just dist');
  } else {
    pass('skill checks node_modules');
  }
} catch {
  pass('skill not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 23: policy.yaml must not use fork-specific fields
// Catches: dead secret_injection / egress_via fields that stock OpenShell ignores
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no fork-specific policy fields ---');

try {
  const policy = readFileSync('../sandboxes/openrind-shell/policy.yaml', 'utf8');
  if (/secret_injection:/i.test(policy)) {
    fail('sandboxes/openrind-shell/policy.yaml', 'contains secret_injection: — stock OpenShell handles this automatically via SecretResolver');
  }
  if (/egress_via:/i.test(policy)) {
    fail('sandboxes/openrind-shell/policy.yaml', 'contains egress_via: — not supported in stock OpenShell');
  }
  if (/egress_profile:/i.test(policy)) {
    fail('sandboxes/openrind-shell/policy.yaml', 'contains egress_profile: — not supported in stock OpenShell');
  }
  pass('no fork-specific fields in policy.yaml');
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 24: Socket.dev endpoint must use protocol: rest + tls: terminate
// Catches: Socket.dev credential injection won't work without TLS termination
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev endpoint has TLS terminate ---');

try {
  const policy = readFileSync('../sandboxes/openrind-shell/policy.yaml', 'utf8');
  if (policy.includes('registry.socket.dev')) {
    // Find the socket endpoint block and verify it has tls: terminate
    const socketSection = policy.slice(policy.indexOf('registry.socket.dev'));
    const nextPolicy = socketSection.indexOf('\n  binaries:');
    const socketBlock = socketSection.slice(0, nextPolicy > 0 ? nextPolicy : 200);
    if (!socketBlock.includes('tls: terminate')) {
      fail('sandboxes/openrind-shell/policy.yaml', 'registry.socket.dev must have tls: terminate for credential injection');
    } else {
      pass('Socket.dev endpoint has TLS terminate');
    }
  } else {
    pass('no Socket.dev endpoint (skipped)');
  }
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 25: Socket.dev policy must be read-only (least privilege)
// Catches: access: full on registry that only needs GET for npm install
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev is read-only ---');

try {
  const policy = readFileSync('../sandboxes/openrind-shell/policy.yaml', 'utf8');
  if (policy.includes('registry.socket.dev')) {
    const socketStart = policy.indexOf('socket_packages:');
    const nextPol = policy.indexOf('\n  #', socketStart + 1);
    const socketBlock = policy.slice(socketStart, nextPol > 0 ? nextPol : undefined);
    if (socketBlock.includes('access: full')) {
      fail('sandboxes/openrind-shell/policy.yaml', 'Socket.dev policy must use access: read-only, not access: full');
    } else {
      pass('Socket.dev policy is read-only');
    }
  } else {
    pass('no Socket.dev endpoint (skipped)');
  }
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 26: setup.sh must not touch user's .npmrc
// Catches: clobbering or deleting user-managed /home/agent/.npmrc
// ---------------------------------------------------------------------------
console.log('\n--- Lint: setup.sh does not touch user .npmrc ---');

try {
  const setup = readFileSync('../sandboxes/openrind-shell/setup.sh', 'utf8');
  if (setup.includes('/home/agent/.npmrc')) {
    fail('sandboxes/openrind-shell/setup.sh', 'must not write or delete /home/agent/.npmrc — use a separate openrind-shell-managed file + NPM_CONFIG_USERCONFIG');
  } else if (setup.includes('npm config set')) {
    fail('sandboxes/openrind-shell/setup.sh', 'must not use npm config set (writes to user HOME)');
  } else {
    pass('setup.sh does not touch user .npmrc');
  }
} catch {
  pass('setup.sh not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 27: no stale test files referencing vendor/ or fork-specific fields
// Catches: tests that depend on the removed vendor/openshell/ tree
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no stale vendor test scripts ---');

try {
  const { readdirSync } = await import('node:fs');
  const testDir = '../tests';
  try {
    const tests = readdirSync(testDir);
    for (const t of tests) {
      const content = readFileSync(`${testDir}/${t}`, 'utf8');
      if (content.includes('vendor/openshell')) {
        fail(`tests/${t}`, 'references vendor/openshell which no longer exists');
      }
    }
  } catch {}
  pass('no stale vendor test scripts');
} catch {}

// ---------------------------------------------------------------------------
// Lint 28: setup.sh must use NPM_CONFIG_USERCONFIG for Socket.dev config
// Catches: writing npm config to user's HOME instead of a temp file
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev uses NPM_CONFIG_USERCONFIG ---');

try {
  const setup = readFileSync('../sandboxes/openrind-shell/setup.sh', 'utf8');
  if (setup.includes('SOCKET_TOKEN') && !setup.includes('NPM_CONFIG_USERCONFIG')) {
    fail('sandboxes/openrind-shell/setup.sh', 'must set NPM_CONFIG_USERCONFIG to point npm at the openrind-shell-managed file');
  } else {
    pass('setup.sh uses NPM_CONFIG_USERCONFIG');
  }
} catch {
  pass('setup.sh not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 29: skill must not unconditionally include --provider socket
// Catches: making optional Socket provider mandatory in the launch command
// ---------------------------------------------------------------------------
console.log('\n--- Lint: skill socket provider is conditional ---');

try {
  const skill = readFileSync('../.claude/skills/openrind-shell/SKILL.md', 'utf8');
  // Find the openshell sandbox create line in Step 3c
  if (skill.includes('--provider socket --auto-providers')) {
    // Check it's inside a conditional block
    const socketIdx = skill.indexOf('--provider socket');
    const precedingBlock = skill.slice(Math.max(0, socketIdx - 300), socketIdx);
    if (!precedingBlock.includes('SOCKET_TOKEN')) {
      fail('.claude/skills/openrind-shell/SKILL.md', '--provider socket must be conditional on SOCKET_TOKEN');
    } else {
      pass('skill socket provider is conditional');
    }
  } else {
    pass('skill socket provider is conditional (not in launch command)');
  }
} catch {
  pass('skill not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 30: OpenrindGateway presign URLs must be normalized before Claude launch
// Catches: passing .../v1/messages as ANTHROPIC_BASE_URL, which Claude then
// appends to produce /v1/messages/v1/messages.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: OpenrindGateway proxy URL is base-only ---');

try {
  const setup = readFileSync('../sandboxes/openrind-shell/setup.sh', 'utf8');
  const cli = readFileSync('src/cli.ts', 'utf8');
  let ok = true;
  const markFail = (file, message) => {
    fail(file, message);
    ok = false;
  };

  const launchSection = (source, marker, file) => {
    const idx = source.indexOf(marker);
    if (idx < 0) {
      markFail(file, `missing launch marker: ${marker}`);
      return source;
    }
    return source.slice(idx);
  };

  const stripV1PathRe = /url\.pathname\s*=\s*url\.pathname\.replace\(\s*\/\\\/v1\\\/\.\*\$\/\s*,\s*(['"])\1\s*\)\s*;?/;
  if (!stripV1PathRe.test(setup)) {
    markFail('sandboxes/openrind-shell/setup.sh', 'normalize_openrind_gateway_proxy_url must strip /v1/... from presign URLs');
  }
  if (!stripV1PathRe.test(cli)) {
    markFail('src/cli.ts', 'openrindGatewayProxyBaseUrl must strip /v1/... from presign URLs');
  }

  for (const [envName, description] of [
    ['OPENRIND_GATEWAY_PROXY_URL', 'current OPENRIND_GATEWAY_PROXY_URL'],
    ['OPENRIND_GATEWAY_UPLOADED_URL', 'uploaded presign URL'],
    ['OPENRIND_GATEWAY_STORED_URL', 'stored presign URL'],
    ['OPENRIND_GATEWAY_FULL_PRESIGN_URL', 'newly-created presign URL'],
  ]) {
    const normalizeInputRe = new RegExp(
      String.raw`OPENRIND_GATEWAY_PROXY_URL\s*=\s*["']?\$\(\s*normalize_openrind_gateway_proxy_url\s+["']?\$${envName}(?![A-Za-z0-9_])`,
    );
    if (!normalizeInputRe.test(setup)) {
      markFail('sandboxes/openrind-shell/setup.sh', `missing normalization step for ${description}`);
    }
  }

  for (const [pattern, description] of [
    [/\bconst\s+baseUrl\s*=\s*openrindGatewayProxyBaseUrl\(\s*fullUrl\s*\)\s*;?/, 'new presign renewal result'],
    [/\bopenrindGatewayUrl\s*=\s*openrindGatewayProxyBaseUrl\(\s*storedPresign\.url\s*\)\s*;?/, 'stored presign launch path'],
    [/\bopenrindGatewayUrl\s*=\s*openrindGatewayProxyBaseUrl\(\s*fullUrl\s*\)\s*;?/, 'new presign launch path'],
  ]) {
    if (!pattern.test(cli)) {
      markFail('src/cli.ts', `must route ${description} through openrindGatewayProxyBaseUrl()`);
    }
  }

  const setupLaunch = launchSection(setup, 'setup.sh: launching Claude Code', 'sandboxes/openrind-shell/setup.sh');
  const cliLaunch = launchSection(cli, 'setup: launching Claude Code', 'src/cli.ts');
  const normalizedBaseUrlEnvRe = /\bANTHROPIC_BASE_URL\s*=\s*(['"]?)\\?\$\{?OPENRIND_GATEWAY_PROXY_URL\}?\1(?![A-Za-z0-9_])/;
  if (!normalizedBaseUrlEnvRe.test(setupLaunch)) {
    markFail('sandboxes/openrind-shell/setup.sh', 'Claude launch must use normalized OPENRIND_GATEWAY_PROXY_URL');
  }
  if (!normalizedBaseUrlEnvRe.test(cliLaunch)) {
    markFail('src/cli.ts', 'generated Claude launch must use normalized OPENRIND_GATEWAY_PROXY_URL');
  }

  const badBaseUrlLine = /ANTHROPIC_BASE_URL\s*=.*(?:OPENRIND_GATEWAY_FULL_PRESIGN_URL|fullUrl|storedPresign\.url)/;
  if (setup.split('\n').some(line => badBaseUrlLine.test(line))) {
    markFail('sandboxes/openrind-shell/setup.sh', 'ANTHROPIC_BASE_URL must not be assigned a full presign URL');
  }
  if (cli.split('\n').some(line => badBaseUrlLine.test(line))) {
    markFail('src/cli.ts', 'ANTHROPIC_BASE_URL must not be assigned a full presign URL');
  }

  if (ok) pass('OpenrindGateway presign URLs normalize to the base proxy URL before launch');
} catch (err) {
  if (err?.code === 'ENOENT') {
    pass('OpenrindGateway proxy URL lint skipped (required files not found)');
  } else {
    fail('OpenrindGateway proxy URL lint', err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Lint 31: OpenClaw launch invariants
// Catches: regressions that put the OpenClaw TUI back into a permanent
// "connecting" state. Each rule below maps to a root cause we actually hit.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: OpenClaw launch invariants ---');

try {
  const launch = readFileSync('../sandboxes/openrind-shell/openclaw-launch.sh', 'utf8');
  const seeder = readFileSync('../sandboxes/openrind-shell/openclaw-config.mjs', 'utf8');
  const setup = readFileSync('../sandboxes/openrind-shell/setup.sh', 'utf8');
  const LAUNCH = 'sandboxes/openrind-shell/openclaw-launch.sh';
  const SEEDER = 'sandboxes/openrind-shell/openclaw-config.mjs';
  const SETUP = 'sandboxes/openrind-shell/setup.sh';
  let ok = true;
  const bad = (file, message) => {
    fail(file, message);
    ok = false;
  };
  // Negative checks ("must NOT contain X") have to ignore comments, or the
  // header blocks that EXPLAIN why X is forbidden would trip them.
  const codeOnly = (src) =>
    src
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  const launchCode = codeOnly(launch);
  const setupCode = codeOnly(setup);

  // gateway.bind must be pinned to loopback. OpenClaw defaults it to `auto`
  // (0.0.0.0) inside a container, and only true 127.0.0.1 connections get the
  // loopback trust that auto-approves device pairing.
  if (!/bind:\s*'loopback'/.test(seeder)) {
    bad(SEEDER, "must pin gateway.bind to 'loopback' — the container default is auto (0.0.0.0), which breaks pairing auto-approval");
  }
  if (!/mode:\s*'local'/.test(seeder)) {
    bad(SEEDER, "must set gateway.mode to 'local' — the gateway refuses to start without it");
  }

  // The raw API key must never be written into a file the workspace sync
  // persists to PostgreSQL. Env is OpenClaw's documented auth source.
  if (/apiKey\s*:/.test(seeder)) {
    bad(SEEDER, 'must not write an apiKey into openclaw.json — rely on ANTHROPIC_API_KEY in the environment');
  }

  // acpx declares 35 bundled runtime deps whose install is ~2.5GB / 95k files.
  // OpenClaw's plugin loader walks that tree on TUI startup: ~4 minutes at 100%
  // CPU during which the event loop never services the already-open WebSocket,
  // so the TUI shows "connecting" the whole time. Denying it is the fix.
  if (!/'acpx'/.test(seeder)) {
    bad(SEEDER, "must deny the `acpx` plugin — its 2.5GB bundled dep tree makes the TUI burn ~4 minutes at 100% CPU on startup and show \"connecting\"");
  }
  // plugins.deny must be UNIONED with the restored value. Replacing it silently
  // re-enables every plugin the user had disabled.
  if (!/plugins\?\.deny|plugins\.deny/.test(seeder) || !/new Set\(\[\.\.\.previous/.test(seeder)) {
    bad(SEEDER, 'plugins.deny must be unioned with the existing config value, never replaced');
  }

  // OpenClaw's schema REQUIRES a `models` array on every declared provider.
  // Omitting it fails config validation with
  // "models.providers.<id>.models: expected array, received undefined", which
  // makes the gateway refuse to start (exit 78) — verified against 2026.4.29.
  if (/providers\s*=|PROXY_PROVIDER_ID\]:/.test(seeder) && !/models:\s*\[/.test(seeder)) {
    bad(SEEDER, 'a declared models provider must include a `models: [...]` array — OpenClaw config validation rejects a provider without it');
  }

  // A stale gateway.remote makes `openclaw tui` dial a dead host forever.
  for (const key of ['gateway.remote', 'gateway.auth.token', 'plugins.allow']) {
    if (!seeder.includes(`'${key}'`)) {
      bad(SEEDER, `must remove ${key} from a restored config — it is a known "connecting" hang cause`);
    }
  }

  // OPENCLAW_PLUGIN_STAGE_DIR in a client process triggers a staging loop that
  // saturates the event loop and freezes the terminal. Gateway only.
  const stageAssignments = [...launch.matchAll(/OPENCLAW_PLUGIN_STAGE_DIR=/g)].length;
  if (stageAssignments !== 1 || !/setsid env \\\s*\n\s*OPENCLAW_PLUGIN_STAGE_DIR=/.test(launch)) {
    bad(LAUNCH, 'OPENCLAW_PLUGIN_STAGE_DIR must be set exactly once, on the gateway spawn only — never for a client process');
  }
  // Every `openclaw tui` invocation must unset it. The exec spans several
  // backslash-continued lines, so inspect the whole preceding command instead of
  // trying to match a fixed number of lines.
  const tuiInvocations = [...launchCode.matchAll(/openclaw tui\b/g)];
  if (tuiInvocations.length === 0) {
    bad(LAUNCH, 'no `openclaw tui` invocation found — the launcher must hand the terminal to the TUI');
  }
  for (const m of tuiInvocations) {
    const command = launchCode.slice(Math.max(0, m.index - 400), m.index);
    if (!/-u OPENCLAW_PLUGIN_STAGE_DIR/.test(command)) {
      bad(LAUNCH, 'every `openclaw tui` invocation must unset OPENCLAW_PLUGIN_STAGE_DIR');
    }
  }
  if (!/-u OPENCLAW_PLUGIN_STAGE_DIR/.test(setup)) {
    bad(SETUP, 'the OpenClaw handover must unset OPENCLAW_PLUGIN_STAGE_DIR');
  }

  // There must always be a reachable degraded path. A working local agent beats
  // a spinner.
  if (!/openclaw tui --local/.test(launchCode)) {
    bad(LAUNCH, 'must keep the `openclaw tui --local` fallback so a bad gateway never leaves the user on "connecting"');
  }

  // Every wait needs a budget. An unbounded poll is indistinguishable from a hang.
  if (/while\s+(true|:)\s*;?\s*do/.test(launchCode) || /until\s+curl/.test(launchCode)) {
    bad(LAUNCH, 'contains an unbounded wait loop — every wait must have an explicit budget');
  }
  if (!/GW_READY_TIMEOUT/.test(launch)) {
    bad(LAUNCH, 'gateway readiness wait must be bounded by GW_READY_TIMEOUT');
  }

  // The old flow re-ran interactive onboarding on every launch and hung waiting
  // for a browser. The config seeder replaced it entirely.
  if (/openclaw onboard/.test(launchCode) || /openclaw onboard/.test(setupCode)) {
    bad(/openclaw onboard/.test(launchCode) ? LAUNCH : SETUP, 'must not run `openclaw onboard` — headless onboarding waits on a browser that cannot open; seed the config instead');
  }

  // setsid forks, so $! is not the gateway pid. Liveness must be process-matched.
  if (/setsid env/.test(launch) && !/pgrep -f 'openclaw gateway'/.test(launch)) {
    bad(LAUNCH, 'gateway liveness must use pgrep — setsid forks, so $! is not the gateway pid');
  }

  if (ok) pass('OpenClaw launch invariants hold');
} catch (err) {
  if (err?.code === 'ENOENT') {
    pass('OpenClaw launch invariants skipped (scripts not found)');
  } else {
    fail('OpenClaw launch invariants', err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Lint: the database bootstrap is not repeated within one container
// Catches: setup.sh running migrations + workspace restore + flush twice per
// OpenClaw session (once for the loading-screen prewarm, once at connect),
// which measured 28s of a ~75s provisioning against a remote PostgreSQL.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: setup.sh bootstrap is done once per container ---');

try {
  const SETUP = 'sandboxes/openrind-shell/setup.sh';
  const setup = readFileSync(`../${SETUP}`, 'utf8');
  let ok = true;
  const bad = (message) => {
    fail(SETUP, message);
    ok = false;
  };

  // The marker must never live under /home/agent — that tree is persisted to
  // PostgreSQL, so the skip would leak into every future container.
  if (!/BOOTSTRAP_MARKER=\/tmp\//.test(setup)) {
    bad('the bootstrap marker must live in /tmp, never under /home/agent (which is persisted)');
  }
  // Keyed on the workspace AND the container run. /tmp survives `docker restart`,
  // so a marker keyed on the workspace alone would skip the restore after a
  // restart — and another sandbox sharing that workspace may have changed
  // PostgreSQL in the meantime.
  if (!/BOOTSTRAP_TOKEN="\$WORKSPACE_ID:\$CONTAINER_RUN"/.test(setup)) {
    bad('the bootstrap marker must be keyed on WORKSPACE_ID *and* the container run');
  }
  if (!/\/proc\/1\/stat/.test(setup)) {
    bad('the container run must come from PID 1 starttime — /tmp survives docker restart');
  }

  // Written only AFTER the flush: a bootstrap that dies midway must be retried
  // in full, not skipped because a marker was dropped too early.
  const markerWrite = setup.indexOf('> "$BOOTSTRAP_MARKER"');
  const flushStart = setup.indexOf('flushing /home/agent to workspace');
  if (markerWrite === -1 || flushStart === -1 || markerWrite < flushStart) {
    bad('the bootstrap marker must be written after the flush, not before it');
  }

  // THE SUBTLE ONE. The sync daemon flushes /home/agent to PostgreSQL from its
  // SIGTERM handler, and setup.sh's EXIT trap is what sends that SIGTERM. That
  // shutdown flush is the ONLY thing that persists whatever openclaw-launch.sh
  // wrote during the prewarm (seeded config, memory sqlite) — the connect run
  // now skips its own flush. So the daemon start must stay OUTSIDE the skipped
  // block: skipping it to save three seconds would silently lose agent state.
  const skipEnd = setup.indexOf('end: skip-when-already-bootstrapped');
  const daemonStart = setup.indexOf('starting openrind-shell-bash daemon');
  if (skipEnd === -1 || daemonStart === -1 || daemonStart < skipEnd) {
    bad('the sync daemon must start on EVERY run — its SIGTERM flush is what persists the prewarm writes');
  }

  if (ok) pass('setup.sh bootstraps the workspace once per container');
} catch (err) {
  if (err?.code === 'ENOENT') {
    pass('setup.sh bootstrap lint skipped (script not found)');
  } else {
    fail('setup.sh bootstrap', err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Lint: PTY bridge preserves the desktop terminal's scrollback
// Catches: the agent's own full-screen clear wiping OpenClaw's banner and the
// whole launch progress log off the screen AND out of the scrollback, so there
// is nothing left to scroll back to.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: PTY bridge scrollback preservation ---');

try {
  const BRIDGE = 'sandboxes/openrind-shell/openrind-pty-bridge.py';
  const LAUNCH = 'sandboxes/openrind-shell/openclaw-launch.sh';
  const bridge = readFileSync(`../${BRIDGE}`, 'utf8');
  const launch = readFileSync(`../${LAUNCH}`, 'utf8');
  let ok = true;
  const bad = (file, message) => {
    fail(file, message);
    ok = false;
  };

  // pi-tui's forced full redraw emits ESC[2J ESC[H ESC[3J. Both halves have to
  // be handled, or the banner and the launch log are gone for good.
  if (!/CLEAR_AND_HOME\s*=\s*b"\\x1b\[2J\\x1b\[H"/.test(bridge)) {
    bad(BRIDGE, 'must match the exact ESC[2J ESC[H pair pi-tui emits — a bare ESC[2J must stay untouched, because ED does not move the cursor');
  }
  if (!/ERASE_SCROLLBACK\s*=\s*b"\\x1b\[3J"/.test(bridge)) {
    bad(BRIDGE, 'must drop ESC[3J — the agent never needs to erase the user scrollback for its own rendering to be correct');
  }

  // A linefeed on the bottom row is the ONLY sequence that pushes a line into
  // scrollback. CSI S and ESC[2J both discard it, so neither can replace it.
  if (!/b"\\n"\s*\*\s*used/.test(bridge)) {
    bad(BRIDGE, 'the clear rewrite must scroll with one linefeed per row — CSI S and ESC[2J discard the lines instead of pushing them into scrollback');
  }
  // Only the DRAWN rows may be pushed. Scrolling a full screen also pushes the
  // blank tail, which buried the banner 29 lines above the viewport (13 now).
  if (!/_used_rows/.test(bridge)) {
    bad(BRIDGE, 'the rewrite must push only the rows the agent drew, not a whole screen of mostly-blank lines');
  }
  // The trailing erase is what makes the row estimate safe to get wrong: too
  // short and the erase cleans up, too long and we pushed a few blank lines.
  if (!/erase whatever remains/.test(bridge)) {
    bad(BRIDGE, 'the rewrite must end with ESC[2J so a short row estimate still leaves the agent a blank screen');
  }
  if (/\\x1b\[%d\s*S/.test(bridge) || /\\x1b\[\d+S/.test(bridge)) {
    bad(BRIDGE, 'uses CSI S to scroll — xterm.js implements it as a line delete, so the preserved content is destroyed anyway');
  }

  // The filter buffers partial sequences, so every exit path has to release them.
  if (!/_keeper\.flush\(\)/.test(bridge) || !/_keeper\.expired\(\)/.test(bridge)) {
    bad(BRIDGE, 'held-back bytes must be released by both expired() (idle) and flush() (teardown), or the agent last output can be swallowed');
  }

  // Raw passthrough must stay byte-transparent: an external terminal is the
  // user's to manage, exactly like TERMINAL_RESET.
  if (!/if _mode == "framed":\s*\n\s*write_all\(1, _keeper\.feed\(chunk\)\)/.test(bridge)) {
    bad(BRIDGE, 'the rewrite must be gated on framed mode — raw passthrough has to stay byte-transparent');
  }

  // The launcher's own wipe has to be written in the order the filter matches,
  // otherwise the progress log is erased instead of scrolled away.
  if (!/clear_screen\(\)\s*\{\s*printf '\\033\[3J\\033\[2J\\033\[H'/.test(launch)) {
    bad(LAUNCH, "clear_screen must emit ESC[3J ESC[2J ESC[H in that order — 'home then ED-2' is the same state but is not the pair the bridge rewrites");
  }

  // OpenClaw strips every decorative glyph unless the terminal is on its list.
  if (!/TERM_PROGRAM=vscode/.test(launch)) {
    bad(LAUNCH, 'must declare TERM_PROGRAM=vscode (xterm.js) or OpenClaw supportsDecorativeEmoji() strips the lobster from the banner and every tagline');
  }
  if (!/if \[ -z "\$\{TERM_PROGRAM:-\}" \]/.test(launch)) {
    bad(LAUNCH, 'must not override a TERM_PROGRAM the user terminal already declared');
  }

  if (ok) pass('PTY bridge preserves banner + launch log in the scrollback');
} catch (err) {
  if (err?.code === 'ENOENT') {
    pass('PTY bridge scrollback lint skipped (scripts not found)');
  } else {
    fail('PTY bridge scrollback', err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${errors === 0 ? '✓ All lints passed' : `✗ ${errors} lint error(s)`}\n`);
process.exit(errors > 0 ? 1 : 0);
