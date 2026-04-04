/**
 * Research Agent Dashboard Generator
 * 
 * Generates an HTML dashboard from the cost ledger and run logs.
 * Open in browser for visual cost/routing analytics.
 */

import { readLedger, summarize } from './cost-tracker.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_LOG = join(__dirname, 'logs', 'runs.jsonl');
const OUTPUT = join(__dirname, 'dashboard.html');

function readRuns() {
  if (!existsSync(RUNS_LOG)) return [];
  return readFileSync(RUNS_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateDashboard() {
  const records = readLedger();
  const stats = summarize(records);
  const runs = readRuns();

  // Routing accuracy from recent evals
  const recentPaid = records.filter(r => r.routingDecision === 'paid').length;
  const recentFree = records.filter(r => r.routingDecision === 'free').length;

  // Build query history table rows
  const historyRows = records.slice().reverse().slice(0, 50).map(r => {
    const route = r.searchCostUsd > 0 ? '💰 PAID' : '🆓 FREE';
    const cost = r.totalCostUsd > 0 ? `$${r.totalCostUsd.toFixed(4)}` : '$0';
    const conf = r.confidence ? `${Math.round(r.confidence * 100)}%` : '-';
    const time = r.timestamp?.slice(0, 19).replace('T', ' ') || '-';
    const query = escapeHtml(r.query?.slice(0, 80) || '-');
    const provider = escapeHtml(r.provider?.slice(0, 40) || '-');
    return `<tr>
      <td>${time}</td>
      <td>${query}</td>
      <td class="${r.searchCostUsd > 0 ? 'paid' : 'free'}">${route}</td>
      <td>${cost}</td>
      <td>${conf}</td>
      <td>${provider}</td>
    </tr>`;
  }).join('\n');

  // Daily cost chart data
  const days = Object.entries(stats.byDay || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const dayLabels = days.map(d => `"${d[0]}"`).join(',');
  const dayCosts = days.map(d => d[1].costUsd.toFixed(4)).join(',');
  const dayCounts = days.map(d => d[1].count).join(',');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research Agent Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --text: #e4e4e7;
    --muted: #71717a;
    --accent: #6366f1;
    --green: #22c55e;
    --amber: #f59e0b;
    --red: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 0.875rem; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.75rem; font-weight: 700; margin-top: 4px; }
  .card .detail { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
  .paid { color: var(--amber); font-weight: 600; }
  .free { color: var(--green); font-weight: 600; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th {
    text-align: left;
    padding: 10px 12px;
    color: var(--muted);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  tr:hover { background: rgba(99, 102, 241, 0.05); }
  .section-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 12px;
    margin-top: 8px;
  }
  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    height: 120px;
    padding: 12px 0;
  }
  .bar-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 40px;
  }
  .bar {
    width: 100%;
    max-width: 48px;
    background: var(--accent);
    border-radius: 4px 4px 0 0;
    min-height: 2px;
    transition: height 0.3s;
  }
  .bar-label {
    font-size: 0.65rem;
    color: var(--muted);
    margin-top: 4px;
    white-space: nowrap;
  }
  .bar-value {
    font-size: 0.7rem;
    color: var(--text);
    margin-bottom: 4px;
  }
  .provider-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .provider-badge {
    background: rgba(99, 102, 241, 0.15);
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 0.8rem;
  }
  .empty { color: var(--muted); text-align: center; padding: 40px; }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<h1>🔥 Research Agent Dashboard</h1>
<p class="subtitle">Budget-aware routing analytics / Updated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</p>

<div class="grid">
  <div class="card">
    <div class="label">Total Queries</div>
    <div class="value">${stats.totalQueries}</div>
    <div class="detail"><span class="free">${stats.freeQueries} free</span> / <span class="paid">${stats.paidQueries} paid</span></div>
  </div>
  <div class="card">
    <div class="label">Total Spend</div>
    <div class="value">$${stats.totalCostUsd.toFixed(4)}</div>
    <div class="detail">Search: $${stats.searchCostUsd.toFixed(4)} / Synthesis: $${stats.synthesisCostUsd.toFixed(4)}</div>
  </div>
  <div class="card">
    <div class="label">Avg Cost / Query</div>
    <div class="value">$${stats.avgCostPerQuery.toFixed(4)}</div>
    <div class="detail">Avg paid: $${stats.avgCostPerPaidQuery.toFixed(4)}</div>
  </div>
  <div class="card">
    <div class="label">Routing Split</div>
    <div class="value">${stats.totalQueries > 0 ? Math.round((stats.freeQueries / stats.totalQueries) * 100) : 0}% free</div>
    <div class="detail">${stats.paidQueries} queries escalated to paid</div>
  </div>
</div>

<div class="card" style="margin-bottom: 24px;">
  <div class="section-title">Daily Activity</div>
  ${days.length === 0 ? '<div class="empty">No data yet</div>' : `
  <div class="bar-chart">
    ${days.map(([day, data]) => {
      const maxCount = Math.max(...days.map(d => d[1].count), 1);
      const height = Math.max(4, (data.count / maxCount) * 100);
      return `<div class="bar-col">
        <div class="bar-value">${data.count}</div>
        <div class="bar" style="height: ${height}px"></div>
        <div class="bar-label">${day.slice(5)}</div>
      </div>`;
    }).join('')}
  </div>
  `}
</div>

<div class="card" style="margin-bottom: 24px;">
  <div class="section-title">Providers</div>
  <div class="provider-list">
    ${Object.entries(stats.byProvider || {}).map(([name, data]) =>
      `<div class="provider-badge">${escapeHtml(name.slice(0, 30))} &mdash; ${data.count} queries, $${data.costUsd.toFixed(4)}</div>`
    ).join('')}
  </div>
</div>

<div class="card">
  <div class="section-title">Query History (last 50)</div>
  ${records.length === 0 ? '<div class="empty">No queries yet. Run: research "your question"</div>' : `
  <div style="overflow-x: auto;">
  <table>
    <thead>
      <tr><th>Time</th><th>Query</th><th>Route</th><th>Cost</th><th>Conf</th><th>Provider</th></tr>
    </thead>
    <tbody>
      ${historyRows}
    </tbody>
  </table>
  </div>
  `}
</div>

</body>
</html>`;

  writeFileSync(OUTPUT, html);
  console.log(`Dashboard written to: ${OUTPUT}`);
  return OUTPUT;
}

generateDashboard();
