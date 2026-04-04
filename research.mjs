#!/usr/bin/env node
/**
 * research — quick CLI wrapper
 * 
 * Usage:
 *   node research.mjs "your question here"
 *   node research.mjs --live "your question here"
 *   node research.mjs --live --budget 0.10 "your question here"
 *   node research.mjs --json "your question here"
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = join(__dirname, 'run-prototype.mjs');

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node research.mjs [options] "your question"

Options:
  --live          Enable paid search (default: dry run)
  --budget <USD>  Max spend per query (default: 0.25)
  --json          Output full JSON instead of answer
  --current       Flag query as needing fresh results
  --deep          Flag query as needing depth

Examples:
  node research.mjs "What is x402?"
  node research.mjs --live "Latest agent framework releases"
  node research.mjs --live --budget 0.05 --current "Solana TPS last 24h"`);
  process.exit(0);
}

// Parse our simplified args, forward everything to run-prototype
const fwd = ['--answer'];
const positional = [];
let jsonMode = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--live') fwd.push('--live');
  else if (a === '--budget') { fwd.push('--budget', args[++i]); }
  else if (a === '--json') { jsonMode = true; }
  else if (a === '--current') { fwd.push('--must-be-current'); }
  else if (a === '--deep') { fwd.push('--depth', 'high'); }
  else if (a === '--no-log') { fwd.push('--no-log'); }
  else positional.push(a);
}

if (jsonMode) {
  // remove --answer, output raw JSON
  const idx = fwd.indexOf('--answer');
  if (idx !== -1) fwd.splice(idx, 1);
}

const query = positional.join(' ');
if (!query) {
  console.error('Error: no question provided');
  process.exit(1);
}

fwd.push('--query', query);

const result = spawnSync(process.execPath, [PROTOTYPE, ...fwd], {
  encoding: 'utf8',
  cwd: 'C:/Users/sandm/clawd',
  env: process.env,
  shell: false
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
