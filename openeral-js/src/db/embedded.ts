/**
 * Database connection — embedded PGlite or external PostgreSQL.
 *
 * Priority:
 *   1. DATABASE_URL env var is set  →  external PostgreSQL (backward compat / CI)
 *   2. No DATABASE_URL              →  embedded PGlite  (auto-start, no Docker needed)
 *
 * PGlite is a WASM build of PostgreSQL that runs fully in-process.
 * No Docker, no server process, no runtime binary downloads.
 * Data is persisted to disk at OPENRIND_SHELL_DATA_DIR or the legacy
 * OPENERAL_DATA_DIR (default: ~/.openeral/data).
 */

import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createPool } from './pool.js';
import type { DbPool } from './pool.js';

const DEFAULT_CONNECT_RETRY_MS = 5_000;
const DEFAULT_CONNECT_DEADLINE_MS = 120_000;

function positiveIntegerEnv(primary: string, legacy: string, fallback: number): number {
  const raw = process.env[primary] ?? process.env[legacy];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isTransientConnectionError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : '';
  const message = err instanceof Error ? err.message : String(err);
  return /\{:error,\s*:timeout\}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated unexpectedly/i.test(message)
    || ['08001', '08006', '57P03'].includes(code);
}

function annotateConnectionError(err: unknown, connectionString: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const message = original.message || '';
  let hint = '';

  if (/tenant or user not found|tenant\/user .* not found/i.test(message)) {
    let host = '(unparseable host)';
    try {
      host = new URL(connectionString).host;
    } catch {
      // The original parse error remains the useful failure when the URL is invalid.
    }
    hint =
      `\n\nThe connection reached the Supabase pooler, but the tenant was not found. `
      + `DATABASE_URL commonly has the wrong pooler shard or region (current host: ${host}). `
      + `Copy the exact pooler URL from Supabase Dashboard > Connect; keep the `
      + '`postgres.<project-ref>` username unchanged.';
  } else if (/\{:error,\s*:timeout\}/.test(message)) {
    hint =
      '\n\nThe Supabase pooler timed out reaching the underlying database. '
      + 'A paused project may need to be resumed from the Supabase dashboard.';
  }

  if (!hint) return original;

  const annotated = new Error(message + hint);
  annotated.stack = original.stack;
  const code = (original as { code?: unknown }).code;
  if (typeof code === 'string') {
    (annotated as { code?: string }).code = code;
  }
  return annotated;
}

/** Default data directory (persists across sessions). */
const DEFAULT_DATA_DIR = join(homedir(), '.openeral', 'data');

// Singleton — one PGlite instance per Node process.
let _db: PGlite | null = null;

/**
 * Wrap a PGlite instance in a pg.Pool-compatible adapter.
 *
 * Only the methods actually used in this codebase are implemented:
 *   pool.query(text, values)
 *   pool.connect() → { query, release }
 *   pool.end()
 */
function buildPGlitePool(db: PGlite): DbPool {
  const adapter = {
    async query(text: string, values?: unknown[]) {
      return db.query(text, values as any[]);
    },

    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          return db.query(text, values as any[]);
        },
        release() {
          // PGlite is single-connection — nothing to release.
        },
      };
    },

    async end() {
      if (_db === db) {
        await db.close();
        _db = null;
      }
    },
  };

  // Cast: our adapter satisfies every method the codebase calls on DbPool.
  return adapter as unknown as DbPool;
}

/**
 * Get a database pool.
 *
 * - With DATABASE_URL: opens a real pg.Pool (external PostgreSQL).
 * - Without DATABASE_URL: starts embedded PGlite (no server required).
 */
export async function getDatabaseConnection(): Promise<{
  pool: DbPool;
  connectionString: string;
  isEmbedded: boolean;
}> {
  // ── External PostgreSQL ────────────────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    const connectionString = process.env.DATABASE_URL;
    const pool = createPool(connectionString);
    const retryMs = positiveIntegerEnv(
      'OPENRIND_SHELL_DB_CONNECT_RETRY_MS',
      'OPENERAL_DB_CONNECT_RETRY_MS',
      DEFAULT_CONNECT_RETRY_MS,
    );
    const deadlineMs = positiveIntegerEnv(
      'OPENRIND_SHELL_DB_CONNECT_DEADLINE_MS',
      'OPENERAL_DB_CONNECT_DEADLINE_MS',
      DEFAULT_CONNECT_DEADLINE_MS,
    );
    const deadline = Date.now() + deadlineMs;
    let attempt = 0;
    let lastError: unknown;

    while (Date.now() < deadline) {
      attempt++;
      try {
        // Pool.query keeps the CONNECT-backed socket and its pg client in one
        // operation. Pool.connect adds a separate client handoff that the
        // OpenShell SSH relay can tear down immediately after tunnel setup.
        await pool.query('SELECT 1');
        return {
          pool,
          connectionString,
          isEmbedded: false,
        };
      } catch (err) {
        lastError = err;

        if (!isTransientConnectionError(err) || Date.now() + retryMs >= deadline) break;
        process.stderr.write(`[db] connection attempt ${attempt} failed; retrying in ${retryMs}ms\n`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }

    await pool.end().catch(() => undefined);
    throw annotateConnectionError(lastError, connectionString);
  }

  // ── Embedded PGlite ────────────────────────────────────────────────────────
  if (!_db) {
    const dataDir = process.env.OPENRIND_SHELL_DATA_DIR
      ?? process.env.OPENERAL_DATA_DIR
      ?? DEFAULT_DATA_DIR;
    mkdirSync(dataDir, { recursive: true });

    _db = new PGlite(dataDir);

    // PGlite v0.x initialises asynchronously; wait until ready.
    const maybeReady = (_db as any).waitReady as Promise<void> | undefined;
    if (maybeReady) await maybeReady;
  }

  const dataDir = process.env.OPENRIND_SHELL_DATA_DIR
    ?? process.env.OPENERAL_DATA_DIR
    ?? DEFAULT_DATA_DIR;
  return {
    pool: buildPGlitePool(_db),
    connectionString: `pglite://${dataDir}`,
    isEmbedded: true,
  };
}

/**
 * Gracefully close the embedded PGlite instance.
 * No-op when using external PostgreSQL.
 */
export async function stopEmbeddedDatabase(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}
