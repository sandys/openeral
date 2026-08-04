import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isExcludedFromSync, createHomeSyncOptions } from './sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const syncSrc = readFileSync(join(__dirname, 'sync.ts'), 'utf8');

// Paths captured from a live sandbox. OpenClaw namespaces session transcripts
// per agent; there is no top-level `.openclaw/sessions` directory, which is why
// the original literal exclusion never matched anything and every conversation
// was persisted to PostgreSQL and restored into the next sandbox.
describe('home sync excludes OpenClaw conversation transcripts', () => {
  const home = createHomeSyncOptions();
  const excluded = (p: string, isDir?: boolean) => isExcludedFromSync(p, home, isDir);

  it('excludes the transcripts OpenClaw actually writes', () => {
    const id = '21c54ca2-0126-4aa6-9cf1-90cb4b5c6236';
    expect(excluded(`/.openclaw/agents/main/sessions/${id}.jsonl`)).toBe(true);
    expect(excluded(`/.openclaw/agents/main/sessions/${id}.trajectory.jsonl`)).toBe(true);
    expect(excluded(`/.openclaw/agents/main/sessions/${id}.jsonl.reset.2026-07-25T18-43-52.917Z`)).toBe(true);
    expect(excluded('/.openclaw/agents/main/sessions', true)).toBe(true);
  });

  it('excludes transcripts for any agent name, not just "main"', () => {
    expect(excluded('/.openclaw/agents/researcher/sessions/a.jsonl')).toBe(true);
    expect(excluded('/.openclaw/agents/some-other-agent/sessions/b.jsonl')).toBe(true);
  });

  it('excludes legacy state-migration markers', () => {
    expect(excluded('/.openclaw/memory/main.sqlite')).toBe(true);
    expect(excluded('/.openclaw/memory/main.sqlite.migrated')).toBe(true);
  });

  it('still keeps current agent memory and config on the sync path', () => {
    // The point is to stop transcript REPLAY, not to make the agent amnesiac.
    expect(excluded('/.openclaw/memory/memory.sqlite')).toBe(false);
    expect(excluded('/.openclaw/openclaw.json')).toBe(false);
    expect(excluded('/.openclaw/agents/main/agent.json')).toBe(false);
    expect(excluded('/.openclaw/agents', true)).toBe(false);
  });

  it('does not over-match: the wildcard is one segment and segment-aligned', () => {
    // A user directory that merely happens to be called "sessions".
    expect(excluded('/sessions/notes.md')).toBe(false);
    expect(excluded('/projects/app/sessions/data.json')).toBe(false);
    // Prefix matching must not treat "sessionsomething" as "sessions".
    expect(excluded('/.openclaw/agents/main/sessionsomething.json')).toBe(false);
    // The wildcard stands for exactly one segment.
    expect(excluded('/.openclaw/agents/sessions/x.jsonl')).toBe(false);
  });

  it('leaves the existing literal exclusions working', () => {
    expect(excluded('/.openclaw/logs/gateway.log')).toBe(true);
    expect(excluded('/.openclaw/plugins/installs.json')).toBe(true);
    expect(excluded('/.ssh/id_ed25519')).toBe(true);
    expect(excluded('/.bash_history')).toBe(true);
    expect(excluded('/node_modules/pkg/index.js')).toBe(true);
  });

  it('documents the original bug: the literal prefix matched nothing', () => {
    // Exactly what the exclusion list used to contain. Against the path OpenClaw
    // really writes it returns false — the rule was a no-op, which is why every
    // conversation was persisted and replayed in the next sandbox.
    const old = { excludePathPrefixes: ['/.openclaw/sessions'] };
    expect(isExcludedFromSync('/.openclaw/agents/main/sessions/a.jsonl', old)).toBe(false);
    // The corrected pattern does match it.
    const fixed = { excludePathPrefixes: ['/.openclaw/agents/*/sessions'] };
    expect(isExcludedFromSync('/.openclaw/agents/main/sessions/a.jsonl', fixed)).toBe(true);
  });

  it('excluded rows are pruned, so old transcripts clean themselves up', () => {
    // syncFromFs adds only non-excluded paths to seenPaths and prune deletes
    // every DB row not in seenPaths, so transcripts already stored by the old
    // build are removed on the sync daemon's first pass (it uses prune: true).
    expect(syncSrc).toContain('if (shouldExcludePath(dbPath, syncOpts, false)) continue;');
    expect(syncSrc).toContain('!seenPaths.has(path)');
  });

  it('is inert for the default (non-home) sync options', () => {
    // Only the home sync carries these prefixes; a plain workspace sync must be
    // unaffected.
    expect(isExcludedFromSync('/.openclaw/agents/main/sessions/a.jsonl')).toBe(false);
  });
});

describe('sync.ts structural checks', () => {
  it('syncFromFs tracks seen paths for deletion', () => {
    expect(syncSrc).toContain('seenPaths');
    expect(syncSrc).toContain('seenPaths.add(');
  });

  it('syncFromFs can delete DB rows not seen on disk', () => {
    expect(syncSrc).toMatch(/DELETE FROM _openrind\.workspace_files/);
    expect(syncSrc).toContain('if (syncOpts.prune)');
    expect(syncSrc).toContain('!seenPaths.has(');
  });

  it('syncFromFs uses st.mode, not hardcoded values', () => {
    // Only check the walkDir function body (exclude the root dir INSERT)
    const walkDirStart = syncSrc.indexOf('async function walkDir');
    const walkDirEnd = syncSrc.indexOf('// Ensure root exists');
    const walkDirBody = syncSrc.slice(walkDirStart, walkDirEnd);
    expect(walkDirBody).toContain('st.mode');
    const insertStatements = walkDirBody.match(/INSERT INTO[\s\S]*?ON CONFLICT[\s\S]*?\]/g) || [];
    for (const stmt of insertStatements) {
      expect(stmt).not.toMatch(/0o40755|0o100644/);
    }
  });

  it('syncToFs applies chmod after writing files', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    expect(syncToFsBody).toContain('chmodSync(');
    expect(syncToFsBody).toContain('row.mode & 0o7777');
  });

  it('syncToFs prunes local files not in DB', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    expect(syncToFsBody).toContain('pruneLocal');
  });

  it('exclude uses exact directory name matching, not regex substring', () => {
    // Must use Set-based matching, not regex
    expect(syncSrc).toContain('DEFAULT_EXCLUDE_DIRS');
    expect(syncSrc).toContain("new Set(['node_modules', '.git', '.openrind-shell'])");
    // shouldExclude must use .has(), not .test()
    expect(syncSrc).toContain('excludeDirs.has(name)');
    // Must NOT have a regex-based exclude that would match .gitignore
    expect(syncSrc).not.toMatch(/exclude\.test\(name\)/);
  });

  it('.gitignore and .github are NOT excluded', () => {
    expect(syncSrc).not.toContain('/node_modules|\\.git/');
  });

  it('syncToFs prunes BEFORE creating (handles type conflicts)', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    const pruneIdx = syncToFsBody.indexOf('pruneLocal');
    const mkdirIdx = syncToFsBody.indexOf('mkdirSync(fullPath');
    const writeIdx = syncToFsBody.indexOf('writeFileSync(fullPath');
    // pruneLocal must appear BEFORE mkdir and writeFile
    expect(pruneIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeGreaterThan(pruneIdx);
    expect(writeIdx).toBeGreaterThan(pruneIdx);
  });

  it('pruneLocal handles type conflicts (file↔dir)', () => {
    // pruneLocal must check dbTypes for type mismatches, not just presence
    expect(syncSrc).toContain('dbTypes');
    expect(syncSrc).toContain('dbIsDir === false');
    expect(syncSrc).toContain('dbIsDir === true');
  });

  it('home sync policy excludes sensitive dirs, files, and keyrings', () => {
    expect(syncSrc).toContain('HOME_SYNC_EXCLUDE_DIRS');
    expect(syncSrc).toContain("'.ssh'");
    expect(syncSrc).toContain("'.aws'");
    expect(syncSrc).toContain("'.azure'");
    expect(syncSrc).toContain("'.gnupg'");
    expect(syncSrc).toContain("'.config'");
    expect(syncSrc).toContain('HOME_SYNC_EXCLUDE_FILES');
    expect(syncSrc).toContain("'.npmrc'");
    expect(syncSrc).toContain("'.git-credentials'");
    expect(syncSrc).toContain("'.netrc'");
    expect(syncSrc).toContain("'/.local/share/keyrings'");
  });

  it('home sync policy excludes noisy openclaw subdirs but preserves user state', () => {
    expect(syncSrc).toContain('HOME_SYNC_EXCLUDE_PATH_PREFIXES');
    expect(syncSrc).toContain("'/.openclaw/logs'");
    expect(syncSrc).toContain("'/.openclaw/cache'");
    expect(syncSrc).toContain("'/.openclaw/plugin-runtime-deps'");
    expect(syncSrc).toContain("'/.openclaw/gateway'");
    // openclaw.json, agents/, and memory-core data must remain syncable so
    // sessions/memory persist across sandbox restarts — verify .openclaw is
    // NOT in the basename excludeDirs set.
    expect(syncSrc).not.toMatch(/HOME_SYNC_EXCLUDE_DIRS = new Set\(\[[^\]]*'\.openclaw'/s);
  });

  it('home sync policy disables pruning without filtering by file size or type', () => {
    expect(syncSrc).toContain('createHomeSyncOptions');
    expect(syncSrc).toContain('prune: overrides.prune ?? false');
    expect(syncSrc).not.toContain('maxFileSizeBytes');
    expect(syncSrc).not.toContain('skipBinaryFiles');
  });

  it('syncFromFs reads file content without size or binary cutoffs', () => {
    expect(syncSrc).toContain('const content = readFileSync(fullPath);');
    expect(syncSrc).not.toContain('isBinaryContent');
    expect(syncSrc).not.toContain('syncOpts.maxFileSizeBytes');
    expect(syncSrc).not.toContain('syncOpts.skipBinaryFiles');
  });

  it('watchAndSync exposes dirty-state controls for sync fast paths', () => {
    expect(syncSrc).toContain('export interface SyncWatchHandle');
    expect(syncSrc).toContain('isDirty(): boolean');
    expect(syncSrc).toContain('isWatching(): boolean');
    expect(syncSrc).toContain('markClean(): void');
    expect(syncSrc).toContain('async suspend<T>(');
  });
});
