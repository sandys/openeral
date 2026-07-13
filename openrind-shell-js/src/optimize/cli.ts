#!/usr/bin/env node

/**
 * CLI commands for optimization
 */

import { hostname } from 'node:os';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrations.js';
import { getOptimizationStats, formatStats } from './metrics.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    console.log(`
Openrind Commands

Usage:
  npx openrind-shell <command> [options]

Commands:
  stats                Show API usage statistics (costs, tokens, cache hits)
  analyze              Analyze session history and propose changes to reduce future token usage
  apply                Apply proposals from analyze (patches CLAUDE.md, creates context file, etc.)
  test-db              Test database connection
  help                 Show this help message

Stats Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Number of days to analyze (default: 7)

Analyze / Apply Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Days of session history to analyze (default: 7)
  --project-root <p>   Project root directory (default: auto-detect from cwd)
  --dry-run            Preview changes without writing files (apply only)
  --proposal <id>      Apply a specific proposal by ID (apply only; omit = apply all)
  --json               Output as JSON (analyze only)

Proposal IDs:
  model-routing        Add model selection rules to CLAUDE.md
  context-file         Create .claude/CONTEXT.md + add read/update instruction
  readme-updates       Add README maintenance instruction to CLAUDE.md
  lazy-reading         Add file reading efficiency rules to CLAUDE.md
  memory-compact       Strip code blocks and duplicates from memory files

Note:
  DATABASE_URL is required (Supabase, Neon, or any external PostgreSQL).
  Run \`npx openrind-shell db-url postgresql://...\` to store it once.
  Set OPENRIND_GATEWAY_API_KEY to sync live usage data from OpenrindGateway before showing stats.
  Run sessions via 'npx openrind-shell' first so analyze has usage data.

Examples:
  npx openrind-shell stats
  npx openrind-shell analyze
  npx openrind-shell apply
  npx openrind-shell apply --dry-run
  npx openrind-shell apply --proposal model-routing
  npx openrind-shell apply --proposal context-file
`);
    process.exit(0);
  }

  // Parse options
  let workspaceId = process.env.OPENRIND_SHELL_WORKSPACE_ID || hostname();
  let days = 7;
  let jsonOutput = false;
  let dryRun = false;
  let projectRoot = '';
  const proposalIds: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceId = args[++i];
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = args[++i];
    } else if (args[i] === '--proposal' && args[i + 1]) {
      proposalIds.push(args[++i]);
    }
  }

  // Test database connection
  if (command === 'test-db') {
    const { getDatabaseConnection } = await import('../db/embedded.js');
    console.log('Testing database connection...');

    try {
      const conn = await getDatabaseConnection();
      const result = await conn.pool.query('SELECT version() AS v');
      const version = (result.rows[0] as any)?.v ?? 'unknown';
      console.log('✅ Connected (external PostgreSQL)');
      console.log(`   ${String(version).split('\n')[0]}`);
      await conn.pool.end();
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Connection failed: ${err.message}`);
      console.error('   Check DATABASE_URL and ensure PostgreSQL is reachable.');
      process.exit(1);
    }
  }

  let pool: import('pg').Pool;

  try {
    const { getDatabaseConnection } = await import('../db/embedded.js');
    const dbConn = await getDatabaseConnection();
    pool = dbConn.pool;
  } catch (err: any) {
    console.error(`❌ Database connection failed: ${err.message}`);
    console.error('   Check DATABASE_URL and ensure PostgreSQL is reachable.');
    process.exit(1);
  }

  try {
    await runMigrations(pool);

    if (command === 'stats') {
      // Sync from OpenrindGateway first if we have a presign URL and API key
      const presignUrl = process.env.OPENRIND_SHELL_PRESIGN_URL;
      const openrindGatewayKey = process.env.OPENRIND_GATEWAY_API_KEY;
      if (presignUrl && openrindGatewayKey) {
        console.log('Syncing usage data from OpenrindGateway...');
        try {
          const { decodePresignUrl, syncOpenrindGatewayData } = await import('./openrind-gateway-api.js');
          const decoded = decodePresignUrl(presignUrl);
          const result = await syncOpenrindGatewayData(pool, workspaceId, openrindGatewayKey, {
            sessionId: decoded.sessionId,
            daysBack: days,
          });
          if (result.stored > 0) {
            console.log(`  Synced ${result.stored} new events from OpenrindGateway`);
          } else {
            console.log('  No new events to sync');
          }
        } catch (err: any) {
          console.warn(`  Warning: could not sync from OpenrindGateway: ${err.message}`);
        }
        console.log('');
      }

      const stats = await getOptimizationStats(pool, workspaceId, days);
      console.log(formatStats(stats, days));
    } else if (command === 'analyze') {
      const { analyzePromptSurface, formatPromptSurfaceReport } = await import('./analyzer.js');
      const report = await analyzePromptSurface({
        pool,
        workspaceId,
        projectRoot: projectRoot || process.cwd(),
        daysBack: days,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatPromptSurfaceReport(report));
      }
    } else if (command === 'apply') {
      const { analyzePromptSurface, applyRecommendations } = await import('./analyzer.js');
      const report = await analyzePromptSurface({
        pool,
        workspaceId,
        projectRoot: projectRoot || process.cwd(),
        daysBack: days,
      });
      await applyRecommendations(report, {
        dryRun,
        proposals: proposalIds.length > 0 ? proposalIds : undefined,
      });
    } else {
      console.error(`Unknown command: ${command}`);
      console.error('Run "npx openrind-shell optimize help" for usage');
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
