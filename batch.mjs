#!/usr/bin/env node
/**
 * Batch Research Runner
 * 
 * Run multiple research queries from a file or inline list.
 * 
 * Usage:
 *   node batch.mjs --file queries.txt
 *   node batch.mjs "question 1" "question 2" "question 3"
 *   node batch.mjs --file queries.txt --live --budget 0.05
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = join(__dirname, 'run-prototype.mjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { queries: [], live: false, budget: null, outputFile: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' || a === '-f') {
      const file = args[++i];
      if (!existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }
      const lines = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      opts.queries.push(...lines);
    } else if (a === '--live') {
      opts.live = true;
    } else if (a === '--budget') {
      opts.budget = args[++i];
    } else if (a === '--output' || a === '-o') {
      opts.outputFile = args[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node batch.mjs "question 1" "question 2"
  node batch.mjs --file queries.txt
  node batch.mjs --file queries.txt --live --budget 0.05
  node batch.mjs --file queries.txt --output results.md

Options:
  --file, -f     File with one query per line (# for comments)
  --live         Enable paid search
  --budget       Max spend per query (USD)
  --output, -o   Save results to markdown file`);
      process.exit(0);
    } else if (!a.startsWith('--')) {
      opts.queries.push(a);
    }
  }
  return opts;
}

function runQuery(query, live, budget) {
  const args = ['--answer', query];
  if (live) args.unshift('--live');
  if (budget) args.unshift('--budget', budget);

  const result = spawnSync('node', [PROTOTYPE, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    shell: false,
    cwd: process.cwd()
  });

  return {
    query,
    output: result.stdout || '',
    error: result.stderr || '',
    exitCode: result.status,
    timedOut: result.signal === 'SIGTERM'
  };
}

const opts = parseArgs();
if (opts.queries.length === 0) {
  console.log('No queries provided. Use --file or pass queries as arguments.');
  process.exit(1);
}

console.log(`Running ${opts.queries.length} queries${opts.live ? ' (LIVE)' : ' (dry run)'}...\n`);

const results = [];
const outputLines = [`# Batch Research Results\n`, `Generated: ${new Date().toISOString()}\n`, `Queries: ${opts.queries.length} | Mode: ${opts.live ? 'LIVE' : 'dry run'}\n`, `---\n`];

for (let i = 0; i < opts.queries.length; i++) {
  const q = opts.queries[i];
  const progress = `[${i + 1}/${opts.queries.length}]`;
  process.stdout.write(`${progress} ${q.slice(0, 60)}...`);

  const start = Date.now();
  const result = runQuery(q, opts.live, opts.budget);
  const elapsed = Date.now() - start;

  if (result.timedOut) {
    console.log(` ⏱️ TIMEOUT (${elapsed}ms)`);
    results.push({ ...result, status: 'timeout', elapsed });
    outputLines.push(`### ${i + 1}. ${q}\n`, `**Status:** ⏱️ Timed out after ${elapsed}ms\n\n---\n`);
  } else if (result.exitCode !== 0) {
    console.log(` ❌ ERROR (${elapsed}ms)`);
    results.push({ ...result, status: 'error', elapsed });
    outputLines.push(`### ${i + 1}. ${q}\n`, `**Status:** ❌ Error: ${result.error.slice(0, 200)}\n\n---\n`);
  } else {
    console.log(` ✅ (${elapsed}ms)`);
    results.push({ ...result, status: 'ok', elapsed });
    outputLines.push(`### ${i + 1}. ${q}\n`, `${result.output}\n\n---\n`);
  }
}

// Summary
const ok = results.filter(r => r.status === 'ok').length;
const errors = results.filter(r => r.status === 'error').length;
const timeouts = results.filter(r => r.status === 'timeout').length;
const avgMs = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length);

console.log(`\n--- Batch Summary ---`);
console.log(`✅ ${ok} succeeded | ❌ ${errors} errors | ⏱️ ${timeouts} timeouts`);
console.log(`Avg latency: ${avgMs}ms`);

if (opts.outputFile) {
  outputLines.push(`\n## Summary\n`, `- ✅ ${ok} succeeded\n`, `- ❌ ${errors} errors\n`, `- ⏱️ ${timeouts} timeouts\n`, `- Avg latency: ${avgMs}ms\n`);
  writeFileSync(opts.outputFile, outputLines.join('\n'));
  console.log(`Results saved: ${opts.outputFile}`);
}
