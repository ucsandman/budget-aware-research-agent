/**
 * Research History Search
 * 
 * Search and filter past queries/results from the run logs.
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

export function searchHistory(query, options = {}) {
  const runs = readRuns();
  const searchLower = (query ?? '').toLowerCase();
  const matchMode = options.matchMode || 'all';

  const results = runs.filter(run => {
    const q = run.query?.toLowerCase() ?? '';
    const answer = run.outcome?.answer?.toLowerCase() ?? '';
    const provider = run.outcome?.provider?.toLowerCase() ?? '';

    switch (matchMode) {
      case 'query':
        return q.includes(searchLower);
      case 'answer':
        return answer.includes(searchLower);
      case 'provider':
        return provider.includes(searchLower);
      case 'all':
      default:
        return q.includes(searchLower) || answer.includes(searchLower) || provider.includes(searchLower);
    }
  });

  return results.map(run => ({
    timestamp: run.timestamp,
    query: run.query,
    answer: run.outcome?.answer,
    provider: run.outcome?.provider,
    paid: run.decision?.shouldEscalatePaid ?? false,
    confidence: run.outcome?.finalConfidence,
    costUsd: run.execution?.actualCostUsd ?? 0,
    sourceCount: run.outcome?.sources?.length ?? 0
  }));
}

// CLI: node history-search.mjs "query term" [--mode query|answer|provider|all]
const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.includes('history-search')) {
  const args = process.argv.slice(2);
  let searchTerm = '';
  let mode = 'all';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      searchTerm = args[i];
    }
  }

  if (!searchTerm) {
    console.log('Usage: node history-search.mjs "<search term>" [--mode query|answer|provider|all]');
    process.exit(1);
  }

  const results = searchHistory(searchTerm, { matchMode: mode });

  if (results.length === 0) {
    console.log(`No results found for: "${searchTerm}"`);
  } else {
    console.log(`Found ${results.length} matching queries:\n`);
    for (const r of results) {
      const route = r.paid ? '💰 PAID' : '🆓 FREE';
      const time = r.timestamp?.slice(0, 19).replace('T', ' ') || '?';
      const conf = r.confidence ? `${Math.round(r.confidence * 100)}%` : '-';
      const cost = r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '$0';
      console.log(`${time} [${route}] ${conf} conf, ${cost}`);
      console.log(`  Q: ${r.query?.slice(0, 80) || '?'}`);
      if (r.answer) console.log(`  A: ${r.answer?.slice(0, 120)}...`);
      console.log(`  Provider: ${r.provider?.slice(0, 50) || '?'} (${r.sourceCount || 0} sources)`);
      console.log('');
    }
  }
}
