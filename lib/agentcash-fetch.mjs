import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let url = 'https://stableenrich.dev/api/exa/search';
let payloadPath;

// Support: run-agentcash-fetch.mjs <payloadPath>
// Support: run-agentcash-fetch.mjs <url> <payloadPath>
if (args.length >= 2) {
  url = args[0];
  payloadPath = args[1];
} else if (args.length === 1) {
  payloadPath = args[0];
} else {
  console.error('Usage: run-agentcash-fetch.mjs [url] <payload-json-path>');
  process.exit(1);
}

const result = spawnSync('node', [
  'tools/ops/agentcash/fetch-json.mjs',
  url,
  payloadPath
], {
  encoding: 'utf8',
  shell: false,
  env: process.env
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
