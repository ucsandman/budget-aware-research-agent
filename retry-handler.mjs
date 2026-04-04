/**
 * Retry Handler for Failed Queries
 * 
 * Detects failed paid queries and retries with fallback strategies:
 * 1. Retry same provider (once)
 * 2. Fall back to free search
 * 3. Fall back to alternative paid provider
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_LOG = join(__dirname, 'logs', 'runs.jsonl');

function readRuns() {
  if (!existsSync(RUNS_LOG)) return [];
  return readFileSync(RUNS_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function findFailedQueries() {
  const runs = readRuns();
  const failures = [];

  for (const run of runs) {
    // Check for execution failures
    if (run.execution?.error || run.execution?.mode === 'failed') {
      failures.push({
        timestamp: run.timestamp,
        query: run.request?.query,
        provider: run.finalResponse?.selectedProvider,
        error: run.execution?.error,
        costUsd: run.execution?.costUsd ?? 0,
        isPaid: run.decision?.shouldEscalatePaid ?? false,
        retryable: true
      });
    }
    // Check for synthesis failures
    else if (run.finalResponse?.error) {
      failures.push({
        timestamp: run.timestamp,
        query: run.request?.query,
        provider: run.finalResponse?.selectedProvider,
        error: run.finalResponse?.error,
        costUsd: run.execution?.costUsd ?? 0,
        isPaid: run.decision?.shouldEscalatePaid ?? false,
        retryable: true
      });
    }
    // Check for routing conflicts
    else if (run.decision?.routingConfidence && run.decision.routingConfidence < 0.5) {
      failures.push({
        timestamp: run.timestamp,
        query: run.request?.query,
        provider: run.finalResponse?.selectedProvider,
        error: 'Low routing confidence',
        costUsd: run.execution?.costUsd ?? 0,
        isPaid: run.decision?.shouldEscalatePaid ?? false,
        retryable: true
      });
    }
  }

  return failures;
}

export function suggestRetryStrategy(failure) {
  const strategies = [];

  if (failure.isPaid) {
    // For paid failures, suggest fallback to free first (cost recovery)
    strategies.push({
      priority: 1,
      name: 'free-fallback',
      description: 'Fall back to free search (cost recovery)',
      command: `research "${failure.query}"`
    });

    // Then suggest retry with same provider
    strategies.push({
      priority: 2,
      name: 'retry-paid',
      description: `Retry with ${failure.provider || 'paid provider'} (same query)`,
      command: `research --live "${failure.query}"`
    });

    // Suggest alternative provider if available
    strategies.push({
      priority: 3,
      name: 'alt-provider',
      description: 'Try alternative paid provider',
      command: `research --live --budget 0.02 "${failure.query}"`
    });
  } else {
    // For free failures, escalate to paid
    strategies.push({
      priority: 1,
      name: 'escalate-paid',
      description: 'Escalate to paid search',
      command: `research --live "${failure.query}"`
    });

    // Retry with more conservative settings
    strategies.push({
      priority: 2,
      name: 'retry-free-conservative',
      description: 'Retry free search with reduced enrichment',
      command: `research "${failure.query}"` // will use cache if available
    });
  }

  return strategies;
}

// CLI: node retry-handler.mjs [list|suggest <index>]
const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.includes('retry-handler')) {
  const cmd = process.argv[2] || 'list';

  if (cmd === 'list') {
    const failures = findFailedQueries();
    if (failures.length === 0) {
      console.log('✅ No failed queries found.');
    } else {
      console.log(`⚠️ Found ${failures.length} failed queries:\n`);
      for (let i = 0; i < failures.length; i++) {
        const f = failures[i];
        const route = f.isPaid ? '💰' : '🆓';
        const time = f.timestamp?.slice(0, 19).replace('T', ' ') || '?';
        console.log(`${i + 1}. [${route}] ${time}`);
        console.log(`   Q: ${f.query?.slice(0, 80) || '?'}`);
        console.log(`   Error: ${f.error}`);
        console.log(`   Provider: ${f.provider || 'unknown'}`);
        console.log('');
      }
      console.log(`Use: node retry-handler.mjs suggest <number> to see retry strategies`);
    }
  } else if (cmd === 'suggest') {
    const idx = parseInt(process.argv[3], 10) - 1;
    const failures = findFailedQueries();
    if (idx < 0 || idx >= failures.length) {
      console.log(`Invalid index. Use 1-${failures.length}`);
      process.exit(1);
    }
    const failure = failures[idx];
    const strategies = suggestRetryStrategy(failure);
    console.log(`Retry strategies for: "${failure.query}"\n`);
    for (const s of strategies) {
      console.log(`${s.priority}. ${s.name.toUpperCase()}`);
      console.log(`   ${s.description}`);
      console.log(`   ${s.command}`);
      console.log('');
    }
  } else {
    console.log('Usage: node retry-handler.mjs [list|suggest <number>]');
  }
}
