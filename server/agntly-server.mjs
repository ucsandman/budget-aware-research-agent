#!/usr/bin/env node
/**
 * agntly-server.mjs — HTTP endpoint for the Agntly marketplace
 *
 * Receives task callbacks from Agntly, runs the budget-aware research agent,
 * and completes the task with synthesized results.
 *
 * Environment:
 *   AGNTLY_API_KEY    — Agntly marketplace API key
 *   AGNTLY_BASE_URL   — API base (default: https://sandbox.api.agntly.io)
 *
 * Usage:
 *   node server/agntly-server.mjs [--port 3847]
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Load config from environment
const API_KEY = process.env.AGNTLY_API_KEY;
const API_BASE = process.env.AGNTLY_BASE_URL || 'https://sandbox.api.agntly.io';
const PORT = parseInt(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '3847');

if (!API_KEY) {
  console.warn('[warn] AGNTLY_API_KEY not set — task completion callbacks will fail');
}

// Simple JSON fetch helper
async function agntlyFetch(method, path, body) {
  if (!API_KEY) throw new Error('AGNTLY_API_KEY environment variable is not set');
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
  const json = await res.json();
  return json;
}

// Run the research agent as a subprocess and capture output
function runResearch(query, live = true, budget = 0.25) {
  return new Promise((resolve, reject) => {
    const args = [
      join(PROJECT_ROOT, 'run-prototype.mjs'),
      '--answer',
      '--query', query,
      '--budget', String(budget),
      '--no-log',  // don't double-log when serving marketplace tasks
    ];
    if (live) args.push('--live');

    const proc = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Research timed out after 60s'));
    }, 60000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Research exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Parse the --answer mode output into structured result
function parseAnswerOutput(raw) {
  const lines = raw.split('\n');
  let answer = '';
  let sources = [];
  let inAnswer = false;
  let inSources = false;

  for (const line of lines) {
    if (line.startsWith('## Answer')) { inAnswer = true; inSources = false; continue; }
    if (line.startsWith('## Sources')) { inAnswer = false; inSources = true; continue; }
    if (line.startsWith('---')) { inAnswer = false; inSources = false; continue; }
    if (inAnswer) answer += line + '\n';
    if (inSources && line.startsWith('- ')) {
      const match = line.match(/^- (.+?)(?:\s+—\s+(.+))?$/);
      if (match) sources.push({ title: match[1].replace(/ \[paid\]$/, ''), url: match[2] || '' });
    }
  }

  // Extract confidence from footer
  const confMatch = raw.match(/Confidence:\s*(\d+)%/);
  const confidence = confMatch ? parseInt(confMatch[1]) / 100 : 0.5;

  return {
    answer: answer.trim(),
    sources,
    confidence,
  };
}

// Complete a task on Agntly
async function completeTask(taskId, result, completionToken) {
  return agntlyFetch('POST', `/v1/tasks/${taskId}/complete`, {
    result,
    completionToken,
  });
}

// HTTP server
const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: 'budget-aware-research' }));
    return;
  }

  // Agent task endpoint
  if (req.method === 'POST' && req.url === '/agent/run') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const taskId = data.taskId;
        const payload = data.payload || {};
        const completionToken = data.completionToken;
        const query = payload.query;

        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing payload.query' }));
          return;
        }

        // Acknowledge immediately (202)
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', taskId }));

        // Process async
        console.log(`[${new Date().toISOString()}] Task ${taskId}: "${query}"`);

        const budget = payload.budget || 0.05;
        const live = payload.live !== false; // default to live for marketplace tasks

        const rawOutput = await runResearch(query, live, budget);
        const parsed = parseAnswerOutput(rawOutput);

        console.log(`[${new Date().toISOString()}] Task ${taskId}: completed (${parsed.confidence * 100}% conf, ${parsed.sources.length} sources)`);

        // Complete on Agntly
        if (taskId && completionToken) {
          const completeResult = await completeTask(taskId, {
            answer: parsed.answer,
            sources: parsed.sources,
            confidence: parsed.confidence,
          }, completionToken);
          console.log(`[${new Date().toISOString()}] Task ${taskId}: Agntly completion ->`, completeResult.success ? 'OK' : completeResult.error);
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error:`, err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Agntly research agent listening on http://localhost:${PORT}`);
  console.log(`  POST /agent/run   — task callback endpoint`);
  console.log(`  GET  /health      — health check`);
});
