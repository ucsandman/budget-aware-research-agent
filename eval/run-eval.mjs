#!/usr/bin/env node
/**
 * Eval runner for budget-aware research agent.
 * Runs all queries in eval-queries.json through the prototype in dry-run mode
 * and logs routing decisions, confidence, synthesis method, and timing.
 *
 * Usage:
 *   node eval/run-eval.mjs              # dry run (default)
 *   node eval/run-eval.mjs --live       # actually pay for paid queries
 *   node eval/run-eval.mjs --ids conceptual_01,current_01  # run subset
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = join(__dirname, '..', 'run-prototype.mjs');
const QUERIES_PATH = join(__dirname, 'eval-queries.json');
const RESULTS_DIR = join(__dirname, 'results');

mkdirSync(RESULTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const live = args.includes('--live');
const idsArg = args.find(a => a.startsWith('--ids'));
const idFilter = idsArg
  ? args[args.indexOf(idsArg) + 1]?.split(',')
  : null;

const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const filtered = idFilter ? queries.filter(q => idFilter.includes(q.id)) : queries;

console.log(`Running ${filtered.length} eval queries (${live ? 'LIVE' : 'DRY RUN'})...\n`);

const results = [];

for (const q of filtered) {
  const startMs = Date.now();
  const fwdArgs = [
    PROTOTYPE,
    '--query', q.query,
    '--no-log'
  ];
  if (q.mustBeCurrent) fwdArgs.push('--must-be-current');
  if (live) fwdArgs.push('--live');

  const result = spawnSync(process.execPath, fwdArgs, {
    encoding: 'utf8',
    timeout: 60000,
    cwd: join(__dirname, '..', '..', '..'),
    env: process.env,
    shell: false
  });

  const elapsedMs = Date.now() - startMs;

  let parsed = null;
  let error = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    error = result.stderr?.slice(0, 500) || result.stdout?.slice(0, 500) || 'unknown error';
  }

  const record = {
    id: q.id,
    category: q.category,
    query: q.query,
    expectFree: q.expectFree,
    elapsedMs,
    exitCode: result.status,
    error
  };

  if (parsed) {
    const d = parsed.decision || {};
    const e = parsed.execution || {};
    const f = parsed.finalResponse || {};
    record.shouldEscalatePaid = d.shouldEscalatePaid ?? null;
    record.reasonCodes = d.reasonCodes ?? [];
    record.selectedProvider = d.selectedProvider ?? null;
    record.providerSource = d.providerSource ?? null;
    record.executionMode = e.mode ?? null;
    record.costUsd = e.costUsd ?? 0;
    record.freeResultCount = parsed.freePass?.freeFindings?.length ?? 0;
    record.paidResultCount = e.paidFindings?.length ?? 0;
    record.finalConfidence = f.finalConfidence ?? null;
    record.category402 = parsed.discovery?.category ?? null;

    // Check if routing matched expectations
    const routedFree = !d.shouldEscalatePaid;
    record.routingCorrect = q.expectFree === routedFree;
  }

  results.push(record);

  // Print progress
  const icon = record.error ? '❌' : record.routingCorrect ? '✅' : '⚠️';
  const route = record.shouldEscalatePaid ? 'PAID' : 'FREE';
  const conf = record.finalConfidence ? `${(record.finalConfidence * 100).toFixed(0)}%` : '?';
  console.log(`${icon} ${q.id} [${route}] conf=${conf} ${elapsedMs}ms${record.routingCorrect === false ? ' ROUTING MISMATCH' : ''}`);
}

// Summary
console.log('\n--- Summary ---');
const correct = results.filter(r => r.routingCorrect === true).length;
const wrong = results.filter(r => r.routingCorrect === false).length;
const errors = results.filter(r => r.error).length;
const avgMs = Math.round(results.reduce((s, r) => s + r.elapsedMs, 0) / results.length);
const totalCost = results.reduce((s, r) => s + (r.costUsd || 0), 0);

console.log(`Routing accuracy: ${correct}/${results.length - errors} (${wrong} mismatches)`);
console.log(`Errors: ${errors}`);
console.log(`Avg latency: ${avgMs}ms`);
console.log(`Total cost: $${totalCost.toFixed(4)}`);

// Save results
const outPath = join(RESULTS_DIR, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify({ meta: { live, timestamp: new Date().toISOString(), count: results.length }, results }, null, 2));
console.log(`Results saved: ${outPath}`);
