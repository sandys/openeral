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
 *
 * Retries transient connection failures (e.g. Supavisor timeouts while a
 * paused instance is waking up) to prevent the setup script from bailing
 * out too early.
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
  let lastErr;
  
  const deadline = Date.now() + 120000;
  
  // Try for connection issues up to an overall deadline (giving paused instances ~2 minutes to wake up)
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    try {
      client = await pool.connect();
      await client.query("SELECT 1");
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      
      // If it's a Supavisor timeout or ECONNREFUSED, we can retry
      if (/\{:error,\s*:timeout\}|ECONNREFUSED|ECONNRESET/i.test(msg)) {
        if (client) {
          try { client.release(err instanceof Error ? err : true); } catch {}
          client = undefined;
        }
        if (Date.now() + 5000 < deadline) {
          console.log(`[db] Connection attempt ${attempt} failed, retrying in 5s...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        } else {
          break;
        }
      } else {
        // Not a transient error, break and throw
        if (client) {
          try { client.release(err instanceof Error ? err : true); } catch {}
          client = undefined;
        }
        break;
      }
    }
  }

  if (lastErr) {
    await pool.end().catch(() => {});
    throw annotateConnectionError(lastErr, process.env.DATABASE_URL);
  }
  
  client!.release();
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
 *
 * Also annotates `{:error, :timeout}` to explicitly mention paused instances.
 */
function annotateConnectionError(
  err: unknown,
  connectionString: string,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const message = original.message || "";
  let hint = "";

  if (/tenant or user not found|tenant\/user .* not found/i.test(message)) {
    let host = "(unparseable host)";
    try {
      host = new URL(connectionString).host;
    } catch {
      /* leave placeholder */
    }

    hint =
      `\n\nThis is a Supabase connection-pooler "tenant not found" error, which almost ` +
      `always means DATABASE_URL points at the wrong pooler host for your project ` +
      `(current host: ${host}).\n` +
      `The connection DID reach Supabase, so this is NOT a network or firewall problem.\n` +
      `Fix: open your Supabase dashboard → Connect → "Connection pooling", and copy the ` +
      `exact host. Check the shard (aws-0-... vs aws-1-...) and region match your project ` +
      `— e.g. a project on aws-0-ap-south-1 will fail on aws-1-ap-south-1. The username ` +
      `must stay in the "postgres.<project-ref>" form.`;
  } else if (/\{:error,\s*:timeout\}/.test(message)) {
    hint =
      `\n\nThe connection reached the Supabase connection pooler, but the pooler timed ` +
      `out trying to reach the underlying database.\n` +
      `If your Supabase project is on the Free plan, it may have been paused due to ` +
      `inactivity. Open your Supabase dashboard to wake it up, which typically takes 1-3 minutes.`;
  }

  if (!hint) {
    return original;
  }

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
