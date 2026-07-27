import type pg from 'pg';
import type { DbPool } from './pool.js';

/**
 * Highest migration version this build knows how to apply. Recorded in
 * `_openrind.schema_version` once the DDL below has run, which is what lets
 * every later call take the fast path.
 */
export const SCHEMA_VERSION = 6;

/** Advisory lock key (0x4F50454E = 'OPEN' in hex). */
const MIGRATION_LOCK_KEY = 1330795854;

/** Total time to keep trying for the advisory lock before giving up. */
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 500;

/**
 * Cap on how long a single DDL statement may wait for a table lock.
 *
 * Without it a blocked DDL sits there until the 30s statement_timeout AND
 * queues ahead of every subsequent writer, so one boot stalls every concurrent
 * flush. Failing fast is strictly better — the schema is already correct in the
 * case that actually matters, and the caller can retry.
 */
const DDL_LOCK_TIMEOUT_MS = 5_000;

/**
 * Highest recorded schema version, or 0 when nothing has been applied.
 *
 * A missing `schema_version` table means a fresh database (or one migrated by a
 * build that predates version stamping), so it reads as 0 rather than raising.
 * This runs outside any explicit transaction, so the failed lookup cannot
 * poison the session.
 */
async function currentSchemaVersion(client: pg.PoolClient): Promise<number> {
  try {
    const r = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int AS version FROM _openrind.schema_version`,
    );
    return r.rows[0]?.version ?? 0;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return 0; // undefined_table
    throw err;
  }
}

/**
 * Take the migration lock without ever blocking on it.
 *
 * `pg_advisory_lock` blocks server-side, so a contended lock is cancelled by
 * statement_timeout and THROWS — turning "another sandbox is migrating" into a
 * fatal boot failure. `pg_try_advisory_lock` returns immediately, so the waiting
 * happens here, where it is bounded and where losing the race is recoverable.
 */
async function acquireMigrationLock(client: pg.PoolClient): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const r = await client.query(`SELECT pg_try_advisory_lock($1::bigint) AS acquired`, [
      MIGRATION_LOCK_KEY,
    ]);
    if (r.rows[0]?.acquired) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Create an index only when it is genuinely absent.
 *
 * `CREATE INDEX IF NOT EXISTS` is NOT free when the index already exists: it
 * takes a ShareLock on the table BEFORE checking, and ShareLock conflicts with
 * the RowExclusiveLock every INSERT holds. With several sandboxes sharing one
 * workspace, a boot would land on top of another sandbox's flush (~17s for 775
 * entries over a remote link), block, and die on statement_timeout with
 * `57014 canceling statement due to statement timeout` — while also queueing
 * ahead of every other writer.
 *
 * `to_regclass` is a catalog lookup that takes no lock on the table at all.
 * Measured against the live database: the blocked CREATE INDEX hit the timeout,
 * whereas CREATE TABLE IF NOT EXISTS (263ms) and GRANT (188ms) never blocked —
 * only the index needs this guard, but it is the one that broke boots.
 *
 * The DDL keeps its own IF NOT EXISTS so a racing creator is still handled.
 */
async function ensureIndex(
  client: pg.PoolClient,
  qualifiedIndexName: string,
  ddl: string,
): Promise<void> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    qualifiedIndexName,
  ]);
  if (r.rows[0]?.present) return;
  await client.query(ddl);
}

/**
 * Apply every migration. Idempotent — all objects use IF NOT EXISTS — but only
 * reached when `schema_version` says there is work to do.
 */
async function applyMigrations(client: pg.PoolClient): Promise<void> {
  // V1: Create _openrind schema and schema_version table
  await client.query(`CREATE SCHEMA IF NOT EXISTS _openrind`);

  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

  // V2: Create mount_log table
  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.mount_log (
            id SERIAL PRIMARY KEY,
            mounted_at TIMESTAMPTZ DEFAULT NOW(),
            mount_point TEXT NOT NULL,
            schemas_filter TEXT[],
            page_size INTEGER,
            openrind_shell_version TEXT
        )
      `);

  // V3: Create cache_hints table
  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.cache_hints (
            id SERIAL PRIMARY KEY,
            schema_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            hint_type TEXT NOT NULL,
            hint_value TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (schema_name, table_name, hint_type)
        )
      `);

  // V4: Create workspace_config, workspace_files, and index
  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.workspace_config (
            id TEXT PRIMARY KEY,
            display_name TEXT,
            config JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.workspace_files (
            workspace_id TEXT NOT NULL REFERENCES _openrind.workspace_config(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            parent_path TEXT NOT NULL,
            name TEXT NOT NULL,
            is_dir BOOLEAN NOT NULL DEFAULT false,
            content BYTEA,
            mode INTEGER NOT NULL DEFAULT 33188,
            size BIGINT NOT NULL DEFAULT 0,
            mtime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            ctime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            atime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            nlink INTEGER NOT NULL DEFAULT 1,
            uid INTEGER NOT NULL DEFAULT 1000,
            gid INTEGER NOT NULL DEFAULT 1000,
            PRIMARY KEY (workspace_id, path)
        )
      `);

  await ensureIndex(
    client,
    '_openrind.idx_ws_files_parent',
    `CREATE INDEX IF NOT EXISTS idx_ws_files_parent
            ON _openrind.workspace_files (workspace_id, parent_path)`,
  );

  // V5: Create optimization tables
  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.optimization_metrics (
            id BIGSERIAL PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            original_model TEXT NOT NULL,
            original_prompt_tokens INTEGER NOT NULL,
            original_estimated_cost DECIMAL(10, 6) NOT NULL,
            optimized_model TEXT NOT NULL,
            optimized_prompt_tokens INTEGER NOT NULL,
            optimized_actual_cost DECIMAL(10, 6) NOT NULL,
            optimizations_applied TEXT[] NOT NULL,
            task_type TEXT NOT NULL,
            cache_hit BOOLEAN NOT NULL DEFAULT false,
            tokens_saved INTEGER NOT NULL,
            cost_saved DECIMAL(10, 6) NOT NULL,
            savings_percentage DECIMAL(5, 2) NOT NULL,
            metadata JSONB
        )
      `);

  await ensureIndex(
    client,
    '_openrind.idx_optimization_metrics_workspace',
    `CREATE INDEX IF NOT EXISTS idx_optimization_metrics_workspace
            ON _openrind.optimization_metrics (workspace_id, timestamp DESC)`,
  );

  await ensureIndex(
    client,
    '_openrind.idx_optimization_metrics_model',
    `CREATE INDEX IF NOT EXISTS idx_optimization_metrics_model
            ON _openrind.optimization_metrics (optimized_model, timestamp DESC)`,
  );

  await client.query(`
        CREATE TABLE IF NOT EXISTS _openrind.api_cache (
            key TEXT PRIMARY KEY,
            response JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

  await ensureIndex(
    client,
    '_openrind.idx_api_cache_created',
    `CREATE INDEX IF NOT EXISTS idx_api_cache_created
            ON _openrind.api_cache (created_at)`,
  );

  // V6: grant read access to Supabase's built-in dashboard/API roles so
  // `_openrind.*` rows are visible in the Table Editor and via PostgREST.
  // On non-Supabase PostgreSQL these roles don't exist; the GRANT fails
  // with `role "..." does not exist` and we ignore it — strictly a
  // visibility fix for Supabase-hosted databases.
  for (const role of ['service_role', 'dashboard_user', 'authenticated', 'anon']) {
    try {
      await client.query(`GRANT USAGE ON SCHEMA _openrind TO ${role}`);
    } catch (err) {
      if ((err as { code?: string }).code !== '42704') throw err; // undefined_object
    }
  }
  for (const role of ['service_role', 'dashboard_user']) {
    try {
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA _openrind TO ${role}`);
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA _openrind GRANT SELECT ON TABLES TO ${role}`,
      );
    } catch (err) {
      if ((err as { code?: string }).code !== '42704') throw err;
    }
  }
}

/**
 * Run all database migrations (V1-V6) in order.
 *
 * Called on EVERY sandbox boot, and several sandboxes can share one workspace,
 * so the common case has to be cheap and must not contend with concurrent
 * writers. Three things make that true:
 *
 *   1. A version check short-circuits an already-migrated database in a single
 *      SELECT (~1 round trip) — no advisory lock, no DDL, no table locks.
 *      Before this, ~22 DDL statements ran on every boot; on a remote database
 *      that is ~4s of latency during which the migration lock is held, so N
 *      concurrent boots serialised into N x 4s.
 *   2. The advisory lock is polled, never blocked on, so losing the race to
 *      another sandbox is recoverable instead of fatal.
 *   3. Index creation is guarded by a catalog lookup, and any DDL that does run
 *      gets a short lock_timeout so it can never queue ahead of writers.
 *
 * Still idempotent and still safe to call concurrently.
 */
export async function runMigrations(pool: DbPool): Promise<void> {
  const client = await pool.connect();
  try {
    // Prevent indefinite hangs. Note this caps a whole statement, including any
    // time it spends waiting for a lock.
    await client.query('SET statement_timeout = 30000'); // 30 seconds

    // Fast path: already migrated. This is every boot after the first.
    if ((await currentSchemaVersion(client)) >= SCHEMA_VERSION) return;

    if (!(await acquireMigrationLock(client))) {
      // Someone else holds the lock — almost certainly another sandbox running
      // these same migrations. If they finished, we are done.
      if ((await currentSchemaVersion(client)) >= SCHEMA_VERSION) return;
      throw new Error(
        `Timed out after ${Math.round(LOCK_WAIT_MS / 1000)}s waiting for the migration ` +
          `advisory lock, and the schema is still below v${SCHEMA_VERSION}. ` +
          `Another process may be stuck mid-migration.`,
      );
    }

    try {
      // Re-check under the lock: whoever we queued behind has very likely just
      // done the work.
      if ((await currentSchemaVersion(client)) >= SCHEMA_VERSION) return;

      await client.query(`SET lock_timeout = ${DDL_LOCK_TIMEOUT_MS}`);
      await applyMigrations(client);

      // Stamp every version so the fast path engages from now on. Databases
      // migrated by an older build already have the schema but an empty
      // schema_version table; they pick this up on their next boot.
      await client.query(
        `INSERT INTO _openrind.schema_version (version)
         SELECT generate_series(1, $1::int)
         ON CONFLICT (version) DO NOTHING`,
        [SCHEMA_VERSION],
      );
    } finally {
      try {
        await client.query('SET lock_timeout = 0');
      } catch {
        /* best effort — the connection is going back to the pool regardless */
      }
      try {
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_LOCK_KEY]);
      } catch {
        /* the lock is session-scoped, so it is released when the session ends */
      }
    }
  } finally {
    client.release();
  }
}
