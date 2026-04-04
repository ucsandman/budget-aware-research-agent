#!/usr/bin/env node
/**
 * agntly-setup.mjs — Register agent on Agntly marketplace, create wallet, self-test
 * 
 * Usage:
 *   node agntly-setup.mjs register    — register agent on marketplace
 *   node agntly-setup.mjs wallet      — create/check wallet
 *   node agntly-setup.mjs test        — dispatch a test task to our own agent
 *   node agntly-setup.mjs status      — check agent + wallet status
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const envPath = join(__dirname, '..', '..', 'secrets', 'agntly-sandbox.env');
const envLines = readFileSync(envPath, 'utf8').split('\n');
const env = {};
for (const line of envLines) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}

const API_KEY = env.AGNTLY_API_KEY;
const API_BASE = env.AGNTLY_BASE_URL || 'https://sandbox.api.agntly.io';
const AGENT_ID = 'practical-systems-research';

async function api(method, path, body) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

async function register() {
  console.log('Registering agent on Agntly marketplace...');
  const result = await api('POST', '/v1/agents', {
    agentId: AGENT_ID,
    name: 'Budget-Aware Research Agent',
    description: 'Smart research agent that routes queries between free and paid (x402) sources based on query complexity, freshness needs, and budget constraints. Returns synthesized answers with source citations and confidence scores.',
    endpoint: 'http://localhost:3847/agent/run',  // will update with tunnel/public URL
    priceUsdc: '0.02',
    category: 'research',
    tags: ['x402', 'research', 'budget-aware', 'synthesis', 'practical-systems'],
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function wallet() {
  console.log('Checking/creating wallet...');
  // Try to get existing wallet first
  const existing = await api('GET', '/v1/wallets');
  console.log('Existing wallets:', JSON.stringify(existing, null, 2));
  
  if (!existing.data || (Array.isArray(existing.data) && existing.data.length === 0)) {
    console.log('Creating new wallet...');
    const created = await api('POST', '/v1/wallets', {
      label: 'Research Agent Wallet',
      agentId: AGENT_ID,
    });
    console.log('Created:', JSON.stringify(created, null, 2));
    return created;
  }
  return existing;
}

async function test() {
  console.log('Dispatching test task to our own agent...');
  const result = await api('POST', '/v1/tasks', {
    agentId: AGENT_ID,
    payload: { query: 'What is x402 and how does it enable micropayments for AI agents?' },
    budget: '0.02',
    timeoutMs: 60000,
  });
  console.log(JSON.stringify(result, null, 2));
  
  if (result.success && result.data?.id) {
    console.log(`\nTask created: ${result.data.id}`);
    console.log(`Status: ${result.data.status}`);
    console.log(`\nCheck later with: node agntly-setup.mjs task-status ${result.data.id}`);
  }
  return result;
}

async function taskStatus(taskId) {
  const result = await api('GET', `/v1/tasks/${taskId}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function status() {
  console.log('--- Agent Status ---');
  const agents = await api('GET', '/v1/agents');
  const ours = agents.data?.find?.(a => a.agentId === AGENT_ID) || 'not found';
  console.log('Agent:', JSON.stringify(ours, null, 2));
  
  console.log('\n--- Wallet Status ---');
  const wallets = await api('GET', '/v1/wallets');
  console.log('Wallets:', JSON.stringify(wallets, null, 2));
}

// CLI routing
const cmd = process.argv[2];
switch (cmd) {
  case 'register': await register(); break;
  case 'wallet': await wallet(); break;
  case 'test': await test(); break;
  case 'status': await status(); break;
  case 'task-status': await taskStatus(process.argv[3]); break;
  default:
    console.log('Usage: node agntly-setup.mjs [register|wallet|test|status|task-status <id>]');
}
