#!/usr/bin/env node
/**
 * agntly-server-simple.mjs — Minimal HTTP endpoint for Agntly marketplace
 * For testing and debugging before subprocess integration
 *
 * Environment:
 *   AGNTLY_API_KEY    — Agntly marketplace API key
 *   AGNTLY_BASE_URL   — API base (default: https://sandbox.api.agntly.io)
 */

import { createServer } from 'node:http';

// Load config from environment
const API_KEY = process.env.AGNTLY_API_KEY;
const API_BASE = process.env.AGNTLY_BASE_URL || 'https://sandbox.api.agntly.io';

if (!API_KEY) {
  console.warn('[warn] AGNTLY_API_KEY not set — running in mock-only mode');
}

console.log('[config] API_BASE:', API_BASE);

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
  console.log(`Agntly research agent listening on http://localhost:${PORT} (MOCK MODE)`);
  console.log(`  POST /agent/run   — task callback endpoint`);
  console.log(`  GET  /health      — health check`);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
