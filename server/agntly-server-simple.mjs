#!/usr/bin/env node
/**
 * agntly-server-simple.mjs — Minimal HTTP endpoint for Agntly marketplace
 * For testing and debugging before subprocess integration
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
let API_KEY, API_BASE;
try {
  const envPath = join(__dirname, '..', '..', 'secrets', 'agntly-sandbox.env');
  const envLines = readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of envLines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  API_KEY = env.AGNTLY_API_KEY;
  API_BASE = env.AGNTLY_BASE_URL || 'https://sandbox.api.agntly.io';
  console.log('[config] API_KEY loaded, API_BASE:', API_BASE);
} catch (e) {
  console.error('[config] Error:', e.message);
  process.exit(1);
}

const PORT = 3847;

// Mock research agent response (no subprocess)
function mockResearch(query) {
  return `## Answer
For the query "${query}", here's a concise synthesis based on available information.
Key points: This is a mock response for testing the Agntly integration.

## Sources
- Source 1 — https://example.com/source1
- Source 2 — https://example.com/source2

---
Confidence: 65%`;
}

// HTTP server
const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: 'budget-aware-research', mode: 'mock' }));
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
        const query = payload.query;

        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing payload.query' }));
          return;
        }

        // Acknowledge immediately (202)
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', taskId }));

        console.log(`[${new Date().toISOString()}] Task ${taskId}: "${query}"`);

        // Mock processing
        const mockOutput = mockResearch(query);
        console.log(`[${new Date().toISOString()}] Task ${taskId}: completed (mock)`);
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

server.listen(PORT, () => {
  console.log(`✓ Agntly research agent listening on http://localhost:${PORT} (MOCK MODE)`);
  console.log(`  POST /agent/run   — task callback endpoint`);
  console.log(`  GET  /health      — health check`);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
