#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { getDatabaseConnection } from '../db/embedded.js';
import type { FuseSeedEntry } from '../db/fuse-init.js';
import {
  buildFuseRuntimeIdentity,
  fuseRuntimeIdentityMatches,
  prepareFuseVolume,
  readFuseRuntimeIdentity,
  runtimePath,
  writeJsonAtomic,
} from '../db/fuse-init.js';
import { runMigrations } from '../db/migrations.js';

const runtimeDir = process.env.OPENRIND_SHELL_RUNTIME_DIR
  || process.env.OPENERAL_RUNTIME_DIR
  || '/var/lib/openrind-shell/runtime';
// Same precedence as setup-fuse.sh, init-marker.ts, and the Rust daemon: the
// legacy alias wins over the driver-injected OPENSHELL_SANDBOX_ID.
const workspaceId = process.env.OPENRIND_SHELL_WORKSPACE_ID
  || process.env.OPENERAL_WORKSPACE_ID
  || process.env.WORKSPACE_ID
  || process.env.OPENSHELL_SANDBOX_ID
  || 'default';
const databaseUrl = process.env.DATABASE_URL || '';

function initialWorkspaceEntries(): FuseSeedEntry[] {
  // Claude owns its settings, onboarding, trust state, and installed skills in
  // /sandbox/claude-home. Do not seed those choices into the project FUSE tree.
  return [{ path: '/.openrind-shell', kind: 'directory', mode: 0o700 }];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!databaseUrl) throw new Error('DATABASE_URL is required by the FUSE runtime');

  if (command === 'prepare') {
    const readyPath = runtimePath(runtimeDir, 'database.ready');
    const prior = readFuseRuntimeIdentity(readyPath);
    if (prior && !fuseRuntimeIdentityMatches(readyPath, workspaceId, databaseUrl)) {
      throw new Error(
        'the datasource or workspace changed in a live FUSE sandbox; recreate the sandbox to rebuild the mount safely',
      );
    }
    if (prior) {
      process.stdout.write(`${JSON.stringify({ ...prior, importedItems: 0, reused: true })}\n`);
      return;
    }
    const { pool } = await getDatabaseConnection();
    try {
      await runMigrations(pool);
      const prepared = await prepareFuseVolume(
        pool,
        workspaceId,
        process.getuid?.() ?? 1000,
        process.getgid?.() ?? 1000,
        initialWorkspaceEntries(),
      );
      const identity = buildFuseRuntimeIdentity(workspaceId, databaseUrl);
      writeJsonAtomic(readyPath, identity);
      process.stdout.write(`${JSON.stringify({ ...identity, ...prepared })}\n`);
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === 'verify-lease') {
    const owner = process.env.OPENRIND_SHELL_LEASE_OWNER
      || process.env.OPENERAL_LEASE_OWNER
      || '';
    const epoch = process.env.OPENRIND_SHELL_LEASE_EPOCH
      || process.env.OPENERAL_LEASE_EPOCH
      || '';
    if (!owner || !/^\d+$/.test(epoch)) throw new Error('lease owner and epoch are required');
    const { pool } = await getDatabaseConnection();
    try {
      const result = await pool.query(
        `SELECT 1 FROM _openeral.fs_mount_epochs
          WHERE volume_id = $1 AND owner_id = $2::uuid AND epoch = $3::bigint
            AND lease_expires_at > NOW()`,
        [`workspace:${workspaceId}`, owner, epoch],
      );
      if (result.rows.length !== 1) throw new Error('daemon lease does not match PostgreSQL');
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === 'mark-done') {
    const readyPath = runtimePath(runtimeDir, 'database.ready');
    if (!fuseRuntimeIdentityMatches(readyPath, workspaceId, databaseUrl)) {
      throw new Error('database.ready does not match the requested runtime identity');
    }
    const identity = readFuseRuntimeIdentity(readyPath);
    if (!identity) throw new Error('database.ready is invalid');
    writeJsonAtomic(runtimePath(runtimeDir, 'init.done'), {
      ...identity,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  if (command === 'check-ready') {
    const databaseUrlPath = runtimePath(runtimeDir, 'database-url');
    const storedUrl = existsSync(databaseUrlPath)
      ? readFileSync(databaseUrlPath, 'utf8').trim()
      : '';
    const matches = storedUrl === databaseUrl
      && fuseRuntimeIdentityMatches(runtimePath(runtimeDir, 'database.ready'), workspaceId, databaseUrl)
      && fuseRuntimeIdentityMatches(runtimePath(runtimeDir, 'init.done'), workspaceId, databaseUrl);
    process.exit(matches ? 0 : 1);
  }

  throw new Error('usage: openrind-shell-fuse-init <prepare|verify-lease|mark-done|check-ready>');
}

main().catch((error) => {
  process.stderr.write(`openrind-shell-fuse-init: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
