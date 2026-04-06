import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const syncSrc = readFileSync('src/sync.ts', 'utf8');

describe('sync.ts structural checks', () => {
  it('syncFromFs tracks seen paths for deletion', () => {
    expect(syncSrc).toContain('seenPaths');
    expect(syncSrc).toContain('seenPaths.add(');
  });

  it('syncFromFs deletes DB rows not seen on disk', () => {
    expect(syncSrc).toMatch(/DELETE FROM _openeral\.workspace_files/);
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
    expect(syncSrc).toContain("new Set(['node_modules', '.git'])");
    // shouldExclude must use .has(), not .test()
    expect(syncSrc).toContain('excludeDirs.has(name)');
    // Must NOT have a regex-based exclude that would match .gitignore
    expect(syncSrc).not.toMatch(/exclude\.test\(name\)/);
  });

  it('.gitignore and .github are NOT excluded', () => {
    // The shouldExclude function checks exact names against the Set
    // '.gitignore' !== '.git' and '.github' !== '.git'
    // Verify no regex pattern that would match substrings
    expect(syncSrc).not.toContain('/node_modules|\\.git/');
  });
});
