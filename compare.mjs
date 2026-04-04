#!/usr/bin/env node
/**
 * Compare Mode: Side-by-side free vs paid results for the same query
 * 
 * Usage:
 *   node compare.mjs "your question here"
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = join(__dirname, 'run-prototype.mjs');

function runWithMode(query, live) {
  const args = ['--answer', query];
  if (live) args.unshift('--live', '--no-log');
  else args.unshift('--no-log');

  const result = spawnSync('node', [PROTOTYPE, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    shell: false
  });

  return {
    output: result.stdout?.trim() || '',
    error: result.stderr?.trim() || '',
    exitCode: result.status,
    timedOut: result.signal === 'SIGTERM'
  };
}

const query = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ').trim();
if (!query) {
  console.log('Usage: node compare.mjs "your question"');
  process.exit(1);
}

console.log(`Comparing free vs paid for: "${query}"\n`);

// Run free
console.log('Running free path...');
const freeStart = Date.now();
const freeResult = runWithMode(query, false);
const freeMs = Date.now() - freeStart;

// Run paid
console.log('Running paid path...');
const paidStart = Date.now();
const paidResult = runWithMode(query, true);
const paidMs = Date.now() - paidStart;

console.log('');
console.log('═══════════════════════════════════════');
console.log('  🆓 FREE PATH');
console.log('═══════════════════════════════════════');
console.log(freeResult.output || `Error: ${freeResult.error}`);
console.log(`\nLatency: ${freeMs}ms`);

console.log('');
console.log('═══════════════════════════════════════');
console.log('  💰 PAID PATH');
console.log('═══════════════════════════════════════');
console.log(paidResult.output || `Error: ${paidResult.error}`);
console.log(`\nLatency: ${paidMs}ms`);

console.log('');
console.log('═══════════════════════════════════════');
console.log('  📊 COMPARISON');
console.log('═══════════════════════════════════════');
console.log(`Free latency:  ${freeMs}ms`);
console.log(`Paid latency:  ${paidMs}ms`);
console.log(`Delta:         +${paidMs - freeMs}ms for paid`);

// Extract confidence from outputs
const freeConf = freeResult.output.match(/Confidence: (\d+)%/)?.[1];
const paidConf = paidResult.output.match(/Confidence: (\d+)%/)?.[1];
if (freeConf && paidConf) {
  console.log(`Free confidence: ${freeConf}%`);
  console.log(`Paid confidence: ${paidConf}%`);
  console.log(`Confidence delta: +${paidConf - freeConf}%`);
}

// Extract cost
const paidCost = paidResult.output.match(/\$(\d+\.\d+)/)?.[1];
if (paidCost) {
  console.log(`Paid cost: $${paidCost}`);
}
