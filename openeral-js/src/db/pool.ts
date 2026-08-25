import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createTunneledSocket, isLocalHost, resolveHttpProxy } from './http-connect-socket.js';

export type DbPool = pg.Pool;

// Supabase's pooler chain terminates at its private Root 2021 CA. OpenShell's
// SSL_CERT_FILE contains the local proxy CA, so the PostgreSQL end-to-end TLS
// client must explicitly add the Supabase root instead of replacing strict
// verification with rejectUnauthorized=false.
const SUPABASE_POOLER_SUFFIX = '.pooler.supabase.com';
const SUPABASE_ROOT_2021_CA_PATH = '/opt/openrind-shell/certs/supabase-root-2021-ca.pem';
const CONNECTION_STRING_TLS_OPTIONS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];

function isSupabasePooler(host: string | undefined): host is string {
  return !!host && host.toLowerCase().endsWith(SUPABASE_POOLER_SUFFIX);
}

/**
 * Create a pg.Pool that tunnels through the OpenShell HTTP CONNECT proxy
 * when the current process has `HTTPS_PROXY`/`HTTP_PROXY` set AND the target
 * host is not a loopback address.
 *
 * This is how Openrind Shell reaches external PostgreSQL (e.g. Supabase) from
 * inside an OpenShell sandbox. The sandbox netns rejects direct TCP to
 * supabase:5432; the CONNECT tunnel is the only route.
 *
 * Outside an OpenShell sandbox (no HTTPS_PROXY), or for loopback targets
 * (PGlite, local testing), the pool behaves exactly like the previous
 * implementation — a plain `pg.Pool` with no tunneling.
 */
export function createPool(connectionString: string): DbPool {
  const proxyUrl = resolveHttpProxy();
  let targetHost: string | undefined;
  try {
    const u = new URL(connectionString);
    targetHost = u.hostname;
  } catch {
    /* malformed connection string — pg will surface the error */
  }

  const useTunnel = !!proxyUrl && !isLocalHost(targetHost);
  let poolConnectionString = connectionString;

  const poolConfig: pg.PoolConfig = {
    connectionString: poolConnectionString,
    max: 4,
    // Supavisor may need time to wake a paused database before accepting a
    // session. The caller adds bounded retries around transient failures.
    connectionTimeoutMillis: 60000,
  };

  if (
    (process.env.OPENRIND_SHELL_REQUIRE_POSTGRES_TLS === '1'
      || process.env.OPENERAL_REQUIRE_POSTGRES_TLS === '1')
    && !isLocalHost(targetHost)
  ) {
    let parsedConnectionString: URL | undefined;
    let sslMode = '';
    try {
      parsedConnectionString = new URL(connectionString);
      sslMode = parsedConnectionString.searchParams.get('sslmode')?.toLowerCase() ?? '';
    } catch {
      // pg reports malformed connection strings with its normal diagnostic.
    }
    if (sslMode === 'disable' || sslMode === 'allow') {
      throw new Error('PostgreSQL TLS cannot be disabled in this runtime');
    }
    if (parsedConnectionString) {
      // node-postgres otherwise lets query-string TLS options overwrite the
      // strict, pinned policy below.
      for (const option of CONNECTION_STRING_TLS_OPTIONS) {
        parsedConnectionString.searchParams.delete(option);
      }
      poolConnectionString = parsedConnectionString.toString();
      poolConfig.connectionString = poolConnectionString;
    }
    if (isSupabasePooler(targetHost)) {
      if (!existsSync(SUPABASE_ROOT_2021_CA_PATH)) {
        throw new Error(
          `The FUSE image is missing its pinned Supabase CA at ${SUPABASE_ROOT_2021_CA_PATH}`,
        );
      }
      poolConfig.ssl = {
        ca: readFileSync(SUPABASE_ROOT_2021_CA_PATH, 'utf8'),
        rejectUnauthorized: true,
        servername: targetHost,
      };
    } else {
      poolConfig.ssl = { rejectUnauthorized: true };
    }
  }

  if (useTunnel) {
    // pg 8.20 calls `stream` *synchronously* and expects a raw net.Socket.
    // It then calls `setNoDelay(true)` and `.connect(port, host)` on the
    // returned socket. Our tunneled socket accepts `.connect(port, host)`,
    // routes the TCP to the proxy, and fires 'connect' only once CONNECT
    // has been negotiated — matching pg's expectations.
    poolConfig.stream = (() =>
      createTunneledSocket({ proxyUrl: proxyUrl! })) as pg.PoolConfig['stream'];
  }

  return new pg.Pool(poolConfig);
}
