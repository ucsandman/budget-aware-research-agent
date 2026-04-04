/**
 * Cost Tracker for Budget-Aware Research Agent
 * 
 * Logs every paid execution and synthesis cost to a JSONL ledger.
 * Provides summary stats via CLI.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(__dirname, 'logs', 'cost-ledger.jsonl');

export function logCost(entry) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    query: entry.query || '',
    provider: entry.provider || 'unknown',
    searchCostUsd: entry.searchCostUsd ?? 0,
    synthesisCostUsd: entry.synthesisCostUsd ?? 0,
    totalCostUsd: (entry.searchCostUsd ?? 0) + (entry.synthesisCostUsd ?? 0),
    mode: entry.mode || 'unknown',
    synthesisMethod: entry.synthesisMethod || 'unknown',
    providerSource: entry.providerSource || 'unknown',
    routingDecision: entry.routingDecision || 'unknown',
    confidence: entry.confidence ?? 0
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n');
  return record;
}

export function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
}

export function summarize(entries = null) {
  const records = entries || readLedger();
  if (records.length === 0) return { totalQueries: 0, totalCostUsd: 0 };

  const totalCost = records.reduce((s, r) => s + (r.totalCostUsd || 0), 0);
  const paidQueries = records.filter(r => r.searchCostUsd > 0);
  const freeQueries = records.filter(r => r.searchCostUsd === 0);

  // By provider
  const byProvider = {};
  for (const r of records) {
    const p = r.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { count: 0, costUsd: 0 };
    byProvider[p].count += 1;
    byProvider[p].costUsd += r.totalCostUsd || 0;
  }

  // By day
  const byDay = {};
  for (const r of records) {
    const day = r.timestamp?.slice(0, 10) || 'unknown';
    if (!byDay[day]) byDay[day] = { count: 0, costUsd: 0 };
    byDay[day].count += 1;
    byDay[day].costUsd += r.totalCostUsd || 0;
  }

  // Synthesis cost breakdown
  const synthesisCost = records.reduce((s, r) => s + (r.synthesisCostUsd || 0), 0);
  const searchCost = records.reduce((s, r) => s + (r.searchCostUsd || 0), 0);

  return {
    totalQueries: records.length,
    paidQueries: paidQueries.length,
    freeQueries: freeQueries.length,
    totalCostUsd: totalCost,
    searchCostUsd: searchCost,
    synthesisCostUsd: synthesisCost,
    avgCostPerQuery: totalCost / records.length,
    avgCostPerPaidQuery: paidQueries.length > 0 ? totalCost / paidQueries.length : 0,
    byProvider,
    byDay
  };
}

// CLI: node cost-tracker.mjs [summary|tail|reset]
const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.includes('cost-tracker')) {
  const cmd = process.argv[2] || 'summary';

  if (cmd === 'summary') {
    const s = summarize();
    if (s.totalQueries === 0) {
      console.log('No queries logged yet.');
    } else {
      console.log(`📊 Research Agent Cost Summary`);
      console.log(`─────────────────────────────`);
      console.log(`Total queries:      ${s.totalQueries}`);
      console.log(`  Free:             ${s.freeQueries}`);
      console.log(`  Paid:             ${s.paidQueries}`);
      console.log(`Total cost:         $${s.totalCostUsd.toFixed(4)}`);
      console.log(`  Search (x402):    $${s.searchCostUsd.toFixed(4)}`);
      console.log(`  Synthesis (LLM):  $${s.synthesisCostUsd.toFixed(4)}`);
      console.log(`Avg cost/query:     $${s.avgCostPerQuery.toFixed(4)}`);
      console.log(`Avg cost/paid:      $${s.avgCostPerPaidQuery.toFixed(4)}`);
      console.log('');
      console.log('By provider:');
      for (const [name, data] of Object.entries(s.byProvider)) {
        console.log(`  ${name}: ${data.count} queries, $${data.costUsd.toFixed(4)}`);
      }
      console.log('');
      console.log('By day:');
      for (const [day, data] of Object.entries(s.byDay)) {
        console.log(`  ${day}: ${data.count} queries, $${data.costUsd.toFixed(4)}`);
      }
    }
  } else if (cmd === 'tail') {
    const n = parseInt(process.argv[3] || '10', 10);
    const records = readLedger();
    const tail = records.slice(-n);
    for (const r of tail) {
      const route = r.searchCostUsd > 0 ? 'PAID' : 'FREE';
      console.log(`${r.timestamp?.slice(0, 19)} [${route}] $${r.totalCostUsd?.toFixed(4)} ${r.query?.slice(0, 60)}`);
    }
  } else if (cmd === 'reset') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(LEDGER_PATH, '');
    console.log('Ledger cleared.');
  } else {
    console.log('Usage: node cost-tracker.mjs [summary|tail [N]|reset]');
  }
}
