/**
 * Database connection — external PostgreSQL only.
 *
 * DATABASE_URL is required. Use Supabase, Neon, or any PostgreSQL instance.
 * Run `npx openrind-shell db-url postgresql://...` to store it once.
 */

import { createPool } from "./pool.js";
import type { DbPool } from "./pool.js";

/**
 * Get a database pool connected to the PostgreSQL instance at DATABASE_URL.
 * Throws if DATABASE_URL is not set.
 */
export async function getDatabaseConnection(): Promise<{
  pool: DbPool;
  connectionString: string;
  isEmbedded: boolean;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required.\n" +
        "Store it once with: npx openrind-shell db-url postgresql://user:pass@host/db\n" +
        "Or set it in your environment: export DATABASE_URL=postgresql://...",
    );
  }

  const pool = createPool(process.env.DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    await client.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw annotateConnectionError(err, process.env.DATABASE_URL);
  }
  client.release();
  return {
    pool,
    connectionString: process.env.DATABASE_URL,
    isEmbedded: false,
  };
}

/**
 * Turn opaque driver/pooler errors into an actionable message.
 *
 * The most common real-world failure is a Supabase connection-pooler (Supavisor)
 * "Tenant or user not found" error. Supavisor identifies the project by the
 * `postgres.<project-ref>` username AND by the pooler hostname shard — every
 * project lives on exactly one shard (`aws-0-<region>` OR `aws-1-<region>`).
 * If the host in DATABASE_URL points at the wrong shard/region for the project,
 * the connection reaches Supavisor (so it's not a network/policy problem) but
 * the tenant lookup fails. The raw error gives no hint that the *host* is wrong,
 * which sends people chasing credentials/networking instead.
 */
function annotateConnectionError(
  err: unknown,
  connectionString: string,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const message = original.message || "";
  if (!/tenant or user not found|tenant\/user .* not found/i.test(message)) {
    return original;
  }

  let host = "(unparseable host)";
  try {
    host = new URL(connectionString).host;
  } catch {
    /* leave placeholder */
  }

  const hint =
    `\n\nThis is a Supabase connection-pooler "tenant not found" error, which almost ` +
    `always means DATABASE_URL points at the wrong pooler host for your project ` +
    `(current host: ${host}).\n` +
    `The connection DID reach Supabase, so this is NOT a network or firewall problem.\n` +
    `Fix: open your Supabase dashboard → Connect → "Connection pooling", and copy the ` +
    `exact host. Check the shard (aws-0-... vs aws-1-...) and region match your project ` +
    `— e.g. a project on aws-0-ap-south-1 will fail on aws-1-ap-south-1. The username ` +
    `must stay in the "postgres.<project-ref>" form.`;

  const annotated = new Error(message + hint);
  annotated.stack = original.stack;
  // Preserve the driver error code (e.g. XX000) for callers that inspect it.
  const code = (original as { code?: unknown }).code;
  if (typeof code === "string") {
    (annotated as unknown as { code?: string }).code = code;
  }
  return annotated;
}

/**
 * No-op: kept for API compatibility.
 */
export async function stopEmbeddedDatabase(): Promise<void> {
  // PostgreSQL pool is ended via pool.end() — nothing to do here.
}
