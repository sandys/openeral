import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import type { DbPool } from './pool.js';

export const FUSE_SCHEMA_VERSION = 1;
export const FUSE_MIGRATION_VERSION = 7;
export const FUSE_MARKER_VERSION = 1;

export interface FuseRuntimeIdentity {
  version: number;
  workspaceId: string;
  datasourceHash: string;
  schemaVersion: number;
  volumeId: string;
  completedAt: string;
}

export interface PreparedFuseVolume {
  volumeId: string;
  rootNodeId: number;
  importedItems: number;
  seededItems: number;
}

export interface FuseSeedEntry {
  path: string;
  kind: 'directory' | 'file';
  mode: number;
  content?: Buffer;
}

interface LegacyRow {
  path: string;
  is_dir: boolean;
  content: Buffer | null;
  mode: number;
  size: string | number;
  mtime_ns: string;
  ctime_ns: string;
  atime_ns: string;
  nlink: number;
  uid: number;
  gid: number;
}

export function fuseDatasourceHash(databaseUrl: string): string {
  return createHash('sha256').update(`postgres:${databaseUrl}`).digest('hex');
}

export function buildFuseRuntimeIdentity(
  workspaceId: string,
  databaseUrl: string,
): FuseRuntimeIdentity {
  return {
    version: FUSE_MARKER_VERSION,
    workspaceId,
    datasourceHash: fuseDatasourceHash(databaseUrl),
    schemaVersion: FUSE_SCHEMA_VERSION,
    volumeId: `workspace:${workspaceId}`,
    completedAt: new Date().toISOString(),
  };
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readFuseRuntimeIdentity(path: string): FuseRuntimeIdentity | null {
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<FuseRuntimeIdentity>;
    if (marker.version !== FUSE_MARKER_VERSION) return null;
    if (typeof marker.workspaceId !== 'string') return null;
    if (typeof marker.datasourceHash !== 'string') return null;
    if (marker.schemaVersion !== FUSE_SCHEMA_VERSION) return null;
    if (typeof marker.volumeId !== 'string') return null;
    if (typeof marker.completedAt !== 'string') return null;
    return marker as FuseRuntimeIdentity;
  } catch {
    return null;
  }
}

export function fuseRuntimeIdentityMatches(
  path: string,
  workspaceId: string,
  databaseUrl: string,
): boolean {
  const marker = readFuseRuntimeIdentity(path);
  if (!marker) return false;
  const expected = buildFuseRuntimeIdentity(workspaceId, databaseUrl);
  return marker.workspaceId === expected.workspaceId
    && marker.datasourceHash === expected.datasourceHash
    && marker.schemaVersion === expected.schemaVersion
    && marker.volumeId === expected.volumeId;
}

export async function prepareFuseVolume(
  pool: DbPool,
  workspaceId: string,
  uid = 1000,
  gid = 1000,
  seedEntries: FuseSeedEntry[] = [],
): Promise<PreparedFuseVolume> {
  const client = await pool.connect();
  const volumeId = `workspace:${workspaceId}`;
  let rootNodeId = 0;
  let importedItems = 0;
  let seededItems = 0;

  const lock = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [volumeId],
  );
  if (lock.rows[0]?.acquired !== true) {
    client.release();
    throw new Error(
      `workspace ${workspaceId} already has an active filesystem writer; stop it before creating another`,
    );
  }
  try {
    const migration = await client.query(
      'SELECT 1 FROM _openeral.schema_version WHERE version = $1',
      [FUSE_MIGRATION_VERSION],
    );
    if (migration.rows.length !== 1) {
      throw new Error(`filesystem migration V${FUSE_MIGRATION_VERSION} is not installed`);
    }

    await client.query(
      `INSERT INTO _openeral.workspace_config (id, display_name, config)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, 'sandbox'],
    );

    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const existing = await client.query(
        `SELECT root_node_id, schema_version
           FROM _openeral.fs_volumes
          WHERE workspace_id = $1
          FOR UPDATE`,
        [workspaceId],
      );
      if (existing.rows.length > 0) {
        const schemaVersion = Number(existing.rows[0].schema_version);
        if (schemaVersion !== FUSE_SCHEMA_VERSION) {
          throw new Error(`unsupported filesystem schema version ${schemaVersion}`);
        }
        rootNodeId = Number(existing.rows[0].root_node_id);
        // OpenShell image UIDs are not guaranteed to be 1000. Keep the mount
        // root owned by the actual sandbox identity so a recreated sandbox can
        // enter the persisted tree without broadening its mode bits.
        await client.query(
          `UPDATE _openeral.fs_nodes
              SET uid = $3, gid = $4
            WHERE volume_id = $1 AND node_id = $2`,
          [volumeId, rootNodeId, uid, gid],
        );
      } else {
        await client.query(
          `INSERT INTO _openeral.fs_volumes
             (volume_id, workspace_id, root_node_id, schema_version)
           VALUES ($1, $2, 0, $3)`,
          [volumeId, workspaceId, FUSE_SCHEMA_VERSION],
        );
        const now = wallClockNs();
        const root = await client.query(
          `INSERT INTO _openeral.fs_nodes
             (volume_id, kind, mode, uid, gid, size, nlink,
              atime_ns, mtime_ns, ctime_ns)
           VALUES ($1, 2, $2, $3, $4, 0, 2, $5, $5, $5)
           RETURNING node_id`,
          [volumeId, 0o755, uid, gid, now],
        );
        rootNodeId = Number(root.rows[0].node_id);
        await client.query(
          'UPDATE _openeral.fs_volumes SET root_node_id = $2 WHERE volume_id = $1',
          [volumeId, rootNodeId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const alreadyImported = await client.query(
      'SELECT 1 FROM _openeral.fs_legacy_imports WHERE workspace_id = $1',
      [workspaceId],
    );
    if (alreadyImported.rows.length === 0) {
      const renamedWorkspace = await client.query(
        'SELECT 1 FROM _openeral.renamed_workspace_imports WHERE workspace_id = $1',
        [workspaceId],
      );
      importedItems = await importLegacyWorkspace(
        client,
        workspaceId,
        volumeId,
        rootNodeId,
        uid,
        gid,
        renamedWorkspace.rows.length > 0,
      );
    }
    seededItems = await seedMissingWorkspaceEntries(
      client,
      volumeId,
      rootNodeId,
      uid,
      gid,
      seedEntries,
    );
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [volumeId]);
    } finally {
      client.release();
    }
  }

  return { volumeId, rootNodeId, importedItems, seededItems };
}

async function seedMissingWorkspaceEntries(
  client: pg.PoolClient,
  volumeId: string,
  rootNodeId: number,
  uid: number,
  gid: number,
  entries: FuseSeedEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const ordered = [...entries].sort((left, right) => {
    const leftDepth = left.path.split('/').length;
    const rightDepth = right.path.split('/').length;
    return leftDepth - rightDepth || left.path.localeCompare(right.path);
  });
  const unique = new Set<string>();
  for (const entry of ordered) {
    validateLegacyPath(entry.path, true);
    if (unique.has(entry.path)) throw new Error(`duplicate FUSE seed path: ${entry.path}`);
    unique.add(entry.path);
  }

  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const existing = await client.query<{
      parent_node_id: string | number;
      name: Buffer;
      child_node_id: string | number;
      kind: number;
    }>(
      `SELECT d.parent_node_id, d.name, d.child_node_id, n.kind
         FROM _openeral.fs_dirents d
         JOIN _openeral.fs_nodes n
           ON n.volume_id = d.volume_id AND n.node_id = d.child_node_id
        WHERE d.volume_id = $1 AND NOT n.deleted`,
      [volumeId],
    );
    const children = new Map<string, { nodeId: number; kind: number }>();
    for (const row of existing.rows) {
      children.set(
        `${Number(row.parent_node_id)}\0${Buffer.from(row.name).toString('hex')}`,
        { nodeId: Number(row.child_node_id), kind: Number(row.kind) },
      );
    }

    const paths = new Map<string, number>([['/', rootNodeId]]);
    let seeded = 0;
    for (const entry of ordered) {
      const parentPath = dirnamePath(entry.path);
      const parentNodeId = paths.get(parentPath);
      if (parentNodeId === undefined) {
        throw new Error(`FUSE seed parent is missing: ${parentPath}`);
      }
      const name = basenamePath(entry.path);
      const key = `${parentNodeId}\0${Buffer.from(name).toString('hex')}`;
      const prior = children.get(key);
      const expectedKind = entry.kind === 'directory' ? 2 : 1;
      if (prior) {
        if (prior.kind !== expectedKind) {
          throw new Error(`FUSE seed path has the wrong type: ${entry.path}`);
        }
        paths.set(entry.path, prior.nodeId);
        continue;
      }

      const content = entry.kind === 'file' ? (entry.content ?? Buffer.alloc(0)) : null;
      const now = wallClockNs();
      const nodeId = await insertNode(client, {
        volumeId,
        parentNodeId,
        name,
        kind: expectedKind,
        mode: entry.mode & 0o7777,
        uid,
        gid,
        size: content?.length ?? 0,
        nlink: entry.kind === 'directory' ? 2 : 1,
        atimeNs: now,
        mtimeNs: now,
        ctimeNs: now,
        content,
      });
      children.set(key, { nodeId, kind: expectedKind });
      paths.set(entry.path, nodeId);
      seeded += 1;
    }
    await client.query('COMMIT');
    return seeded;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function importLegacyWorkspace(
  client: pg.PoolClient,
  workspaceId: string,
  volumeId: string,
  rootNodeId: number,
  fallbackUid: number,
  fallbackGid: number,
  includeWholeWorkspace: boolean,
): Promise<number> {
  const result = await client.query<LegacyRow>(
    `SELECT path, is_dir, content, mode, size, mtime_ns, ctime_ns,
            atime_ns, nlink, uid, gid
       FROM _openeral.workspace_files
      WHERE workspace_id = $1
        AND path <> '/'
        AND (
          $2::boolean
          OR path IN ('/.claude', '/.openrind-shell', '/.openeral', '/.claude.json')
          OR path LIKE '/.claude/%'
          OR path LIKE '/.openrind-shell/%'
          OR path LIKE '/.openeral/%'
        )
      ORDER BY array_length(regexp_split_to_array(path, '/'), 1), path`,
    [workspaceId, includeWholeWorkspace],
  );

  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const paths = new Map<string, number>([['/', rootNodeId]]);

    const ensureDirectory = async (path: string): Promise<number> => {
      const existing = paths.get(path);
      if (existing !== undefined) return existing;
      const parentPath = dirnamePath(path);
      const parentNodeId = await ensureDirectory(parentPath);
      const nodeId = await insertNode(client, {
        volumeId,
        parentNodeId,
        name: basenamePath(path),
        kind: 2,
        mode: 0o755,
        uid: fallbackUid,
        gid: fallbackGid,
        size: 0,
        nlink: 2,
        atimeNs: wallClockNs(),
        mtimeNs: wallClockNs(),
        ctimeNs: wallClockNs(),
        content: null,
      });
      paths.set(path, nodeId);
      return nodeId;
    };

    let imported = 0;
    for (const row of result.rows) {
      validateLegacyPath(row.path, includeWholeWorkspace);
      const parentPath = dirnamePath(row.path);
      const parentNodeId = await ensureDirectory(parentPath);
      const prior = paths.get(row.path);
      const mode = Number(row.mode) & 0o7777;
      if (row.is_dir) {
        const nodeId = prior ?? await insertNode(client, {
          volumeId,
          parentNodeId,
          name: basenamePath(row.path),
          kind: 2,
          mode: mode || 0o755,
          uid: validOwner(row.uid, fallbackUid),
          gid: validOwner(row.gid, fallbackGid),
          size: 0,
          nlink: Math.max(2, Number(row.nlink) || 2),
          atimeNs: validNs(row.atime_ns),
          mtimeNs: validNs(row.mtime_ns),
          ctimeNs: validNs(row.ctime_ns),
          content: null,
        });
        paths.set(row.path, nodeId);
        if (prior !== undefined) {
          await client.query(
            `UPDATE _openeral.fs_nodes
                SET mode = $3, uid = $4, gid = $5, atime_ns = $6,
                    mtime_ns = $7, ctime_ns = $8
              WHERE volume_id = $1 AND node_id = $2`,
            [
              volumeId,
              nodeId,
              mode || 0o755,
              validOwner(row.uid, fallbackUid),
              validOwner(row.gid, fallbackGid),
              validNs(row.atime_ns),
              validNs(row.mtime_ns),
              validNs(row.ctime_ns),
            ],
          );
        }
      } else {
        if (prior !== undefined) {
          throw new Error(`legacy import path conflicts with a directory: ${row.path}`);
        }
        const content = row.content == null ? Buffer.alloc(0) : Buffer.from(row.content);
        const nodeId = await insertNode(client, {
          volumeId,
          parentNodeId,
          name: basenamePath(row.path),
          kind: 1,
          mode: mode || 0o600,
          uid: validOwner(row.uid, fallbackUid),
          gid: validOwner(row.gid, fallbackGid),
          size: content.length,
          nlink: 1,
          atimeNs: validNs(row.atime_ns),
          mtimeNs: validNs(row.mtime_ns),
          ctimeNs: validNs(row.ctime_ns),
          content,
        });
        paths.set(row.path, nodeId);
      }
      imported += 1;
    }

    await client.query(
      `INSERT INTO _openeral.fs_legacy_imports (workspace_id, volume_id)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, volumeId],
    );
    await client.query('COMMIT');
    return imported;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

interface InsertNodeOptions {
  volumeId: string;
  parentNodeId: number;
  name: string;
  kind: 1 | 2;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  atimeNs: string;
  mtimeNs: string;
  ctimeNs: string;
  content: Buffer | null;
}

async function insertNode(client: pg.PoolClient, options: InsertNodeOptions): Promise<number> {
  const node = await client.query(
    `INSERT INTO _openeral.fs_nodes
       (volume_id, kind, mode, uid, gid, size, nlink,
        atime_ns, mtime_ns, ctime_ns)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING node_id`,
    [
      options.volumeId,
      options.kind,
      options.mode,
      options.uid,
      options.gid,
      options.size,
      options.nlink,
      options.atimeNs,
      options.mtimeNs,
      options.ctimeNs,
    ],
  );
  const nodeId = Number(node.rows[0].node_id);
  await client.query(
    `INSERT INTO _openeral.fs_dirents
       (volume_id, parent_node_id, name, child_node_id)
     VALUES ($1, $2, $3, $4)`,
    [options.volumeId, options.parentNodeId, Buffer.from(options.name), nodeId],
  );
  if (options.content && options.content.length > 0) {
    for (let offset = 0, index = 0; offset < options.content.length; offset += 262_144, index++) {
      await client.query(
        `INSERT INTO _openeral.fs_chunks (volume_id, node_id, chunk_index, data)
         VALUES ($1, $2, $3, $4)`,
        [options.volumeId, nodeId, index, options.content.subarray(offset, offset + 262_144)],
      );
    }
  }
  return nodeId;
}

function dirnamePath(path: string): string {
  const offset = path.lastIndexOf('/');
  return offset <= 0 ? '/' : path.slice(0, offset);
}

function basenamePath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function validateLegacyPath(path: string, includeWholeWorkspace: boolean): void {
  if (!path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`invalid legacy path: ${path}`);
  }
  const allowed = path === '/.claude'
    || path === '/.openrind-shell'
    || path === '/.openeral'
    || path === '/.claude.json'
    || path.startsWith('/.claude/')
    || path.startsWith('/.openrind-shell/')
    || path.startsWith('/.openeral/');
  if (!includeWholeWorkspace && !allowed) {
    throw new Error(`legacy path is outside the import allowlist: ${path}`);
  }
  for (const component of path.slice(1).split('/')) {
    if (!component || component === '.' || component === '..' || Buffer.byteLength(component) > 255) {
      throw new Error(`invalid legacy path component in ${path}`);
    }
  }
}

function validNs(value: string): string {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= BigInt('9223372036854775807')
      ? parsed.toString()
      : wallClockNs();
  } catch {
    return wallClockNs();
  }
}

function validOwner(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : fallback;
}

function wallClockNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function runtimePath(runtimeDir: string, name: string): string {
  return join(runtimeDir, name);
}
