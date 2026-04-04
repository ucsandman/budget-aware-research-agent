import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runStructuredFreeProviders } from './structured-free-providers.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; BudgetAwareResearchAgent/0.1; +https://www.practicalsystems.io)';
const CACHE_DIR = 'C:/Users/sandm/clawd/research/budget-aware-research-agent/cache/free-pass';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BLOCKED_HOST_PATTERNS = [
  /medium\.com$/i,
  /beehiiv\.com$/i,
  /substack\.com$/i,
  /pinterest\.com$/i,
  /facebook\.com$/i,
  /linkedin\.com$/i,
  /instagram\.com$/i,
  /tiktok\.com$/i
];
const LOW_SIGNAL_TITLE_PATTERNS = [
  /complete guide/i,
  /landscape/i,
  /ecosystem/i,
  /top \d+/i,
  /best .* tools/i,
  /ultimate guide/i
];

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKeyFor(query, options = {}) {
  const payload = JSON.stringify({
    cacheSchemaVersion: 5,
    query: query.trim().toLowerCase(),
    count: options.count ?? 8,
    enrichCount: options.enrichCount ?? 6,
    keepCount: options.keepCount ?? 3,
    providerHint: process.env.BRAVE_API_KEY ? 'brave-or-fallbacks' : 'fallbacks-only'
  });
  return createHash('sha256').update(payload).digest('hex');
}

function cachePathFor(key) {
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(query, options = {}) {
  ensureCacheDir();
  const key = cacheKeyFor(query, options);
  const path = cachePathFor(key);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const ageMs = Date.now() - new Date(parsed.cachedAt).getTime();
    const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isFinite(ageMs) || ageMs > ttlMs) return null;
    return {
      ...parsed.result,
      cache: {
        key,
        path,
        hit: true,
        ageMs,
        cachedAt: parsed.cachedAt,
        ttlMs
      }
    };
  } catch {
    return null;
  }
}

function writeCache(query, options = {}, result) {
  ensureCacheDir();
  const key = cacheKeyFor(query, options);
  const path = cachePathFor(key);
  const payload = {
    cachedAt: new Date().toISOString(),
    query,
    options: {
      count: options.count ?? 8,
      enrichCount: options.enrichCount ?? 6,
      keepCount: options.keepCount ?? 3
    },
    result
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return {
    key,
    path,
    hit: false,
    ageMs: 0,
    cachedAt: payload.cachedAt,
    ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  };
}

function decodeHtmlEntities(value = '') {
  const named = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' '
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[lower] ?? _;
  });
}

function cleanText(value = '') {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

function hostFromUrl(value = '') {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function blockedHost(host) {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function titleLooksLowSignal(title = '') {
  return LOW_SIGNAL_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  timeout.unref?.();

  // If caller provides an external signal, abort when it fires
  if (options.signal) {
    if (options.signal.aborted) { clearTimeout(timeout); controller.abort(); }
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers ?? {})
      },
      body: options.body,
      signal: controller.signal,
      redirect: 'follow'
    });
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      text: await res.text(),
      contentType: res.headers.get('content-type') ?? ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function braveSearch(query, count = 8) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Brave search failed with ${res.status}`);
  const json = await res.json();
  return {
    provider: 'brave',
    results: (json.web?.results ?? []).slice(0, count).map((item) => ({
      title: cleanText(item.title ?? ''),
      url: item.url,
      snippet: cleanText(item.description ?? '')
    }))
  };
}

async function duckDuckGoHtmlSearch(query, count = 8) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { ok, status, text } = await fetchText(url, { timeoutMs: 12000 });
  if (!ok) throw new Error(`DuckDuckGo HTML search failed with ${status}`);

  const results = [];
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>(.*?)<\/div>)?/gi;
  let match;
  while ((match = regex.exec(text)) && results.length < count) {
    const href = decodeDuckDuckGoUrl(match[1]);
    const title = cleanText(match[2]);
    const snippet = cleanText(match[3] || match[4] || '');
    if (href && title) results.push({ title, url: href, snippet });
  }

  return { provider: 'duckduckgo-html', results };
}

async function duckDuckGoLiteSearch(query, count = 8) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const { ok, status, text } = await fetchText(url, { timeoutMs: 12000 });
  if (!ok) throw new Error(`DuckDuckGo Lite search failed with ${status}`);

  const results = [];
  const regex = /<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(text)) && results.length < count * 3) {
    const href = decodeDuckDuckGoUrl(match[1]);
    const title = cleanText(match[2]);
    if (!href || !title) continue;
    if (/duckduckgo\.com/i.test(href) || /^\/?lite\//i.test(href)) continue;
    results.push({ title, url: href, snippet: '' });
  }

  return { provider: 'duckduckgo-lite', results: dedupeResults(results).slice(0, count) };
}

async function searchWeb(query, count = 8, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const attempts = [
    async () => await braveSearch(query, count),
    async () => await duckDuckGoHtmlSearch(query, count),
    async () => await duckDuckGoLiteSearch(query, count)
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && result.results.length > 0) {
        return {
          ...result,
          fallbackNotes: errors
        };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(errors.length > 0 ? errors.join(' | ') : 'All web search providers returned no results.');
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(match?.[1] ?? '');
}

function extractMetaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return '';
}

function extractFirstParagraph(html) {
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((text) => text.length >= 80 && text.length <= 420);
  return paragraphs[0] ?? '';
}

function summarizeText(value = '', maxLen = 280) {
  const cleaned = cleanText(value);
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

async function enrichResult(result, signal) {
  try {
    const fetched = await fetchText(result.url, { timeoutMs: 8000, signal });
    if (!fetched.ok || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) {
      return { ...result, host: hostFromUrl(result.url) };
    }

    const pageTitle = extractTitle(fetched.text);
    const description = extractMetaDescription(fetched.text);
    const firstParagraph = extractFirstParagraph(fetched.text);
    const finalUrl = fetched.url || result.url;
    const host = hostFromUrl(finalUrl);

    return {
      ...result,
      url: finalUrl,
      host,
      pageTitle: pageTitle || result.title,
      pageDescription: summarizeText(description || firstParagraph || result.snippet)
    };
  } catch {
    return { ...result, host: hostFromUrl(result.url) };
  }
}

function qualityScore(item, query) {
  let score = 0;
  const title = (item.pageTitle || item.title || '').toLowerCase();
  const summary = (item.pageDescription || item.snippet || '').toLowerCase();
  const host = (item.host || hostFromUrl(item.url)).toLowerCase();
  const queryWords = query.toLowerCase().split(/\W+/).filter((word) => word.length >= 4);

  if (host && !blockedHost(host)) score += 2;
  if (host && (/docs\./i.test(host) || /learn\./i.test(host) || /developer/i.test(host))) score += 2;
  if (summary.length >= 60) score += 1;
  if (summary.length >= 120) score += 1;
  if (!titleLooksLowSignal(title)) score += 1;
  if (/api|docs|pricing|platform|developer|protocol|integration|sdk|search|payment|agent/i.test(`${title} ${summary}`)) score += 2;

  const overlap = queryWords.filter((word) => title.includes(word) || summary.includes(word)).length;
  score += Math.min(3, overlap);

  if (blockedHost(host)) score -= 4;
  if (titleLooksLowSignal(title) && !/api|docs|platform|protocol/i.test(title)) score -= 2;

  return score;
}

function dedupeResults(results = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of results) {
    const key = `${hostFromUrl(item.url)}|${(item.title || '').toLowerCase()}`;
    if (!item.url || !item.title || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function filterAndRankResults(results, query, limit = 3) {
  return dedupeResults(results)
    .map((item) => ({ ...item, qualityScore: qualityScore(item, query) }))
    .filter((item) => item.qualityScore >= 2)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, limit);
}

function scoreFreePass(query, findings, provider) {
  const conceptual = /(what is|in simple terms|why might it matter)/i.test(query);
  const strategic = /(is it smarter|and why|good first wedge|priorit)/i.test(query);
  const highlyCurrent = /(last 30 days|right now|current)/i.test(query);
  const broadMapping = /(map|ecosystem|landscape|vendors?|platforms?|best current|most relevant)/i.test(query);
  const avgQuality = findings.length > 0
    ? findings.reduce((sum, item) => sum + (item.qualityScore ?? 0), 0) / findings.length
    : 0;

  let baselineConfidence = findings.length > 0 ? 0.56 + Math.min(0.16, avgQuality * 0.03) : 0.3;
  let freshnessScore = provider === 'brave' ? 0.68 : provider.includes('duckduckgo-lite') ? 0.52 : 0.58;
  let specificityScore = findings.length >= 3 ? 0.6 : findings.length >= 2 ? 0.5 : 0.38;
  let depthScore = findings.length >= 3 ? 0.56 : findings.length >= 2 ? 0.46 : 0.34;
  const qualityNotes = [];

  if (conceptual) {
    baselineConfidence += 0.16;
    freshnessScore += 0.08;
    qualityNotes.push('Conceptual explanation is usually fine on the free path.');
  }
  if (strategic) {
    baselineConfidence += 0.08;
    specificityScore += 0.06;
    qualityNotes.push('Strategic questions depend more on synthesis than retrieval volume.');
  }
  if (highlyCurrent) {
    freshnessScore -= 0.22;
    baselineConfidence -= 0.08;
    qualityNotes.push('Explicit freshness pressure weakens the free baseline.');
  }
  if (broadMapping) {
    specificityScore -= 0.14;
    depthScore -= 0.12;
    qualityNotes.push('Broad mapping prompts often produce noisier free search coverage.');
  }
  if (avgQuality < 3) {
    specificityScore -= 0.08;
    depthScore -= 0.06;
    qualityNotes.push('Most free results were low-signal or commentary-heavy.');
  } else {
    qualityNotes.push(`Average free-result quality score: ${avgQuality.toFixed(2)}.`);
  }
  if (findings.length === 0) {
    qualityNotes.push('Free search returned no usable results after filtering.');
  } else {
    qualityNotes.push(`Free search kept ${findings.length} findings via ${provider}.`);
  }

  return {
    baselineConfidence: Math.max(0, Math.min(1, baselineConfidence)),
    freshnessScore: Math.max(0, Math.min(1, freshnessScore)),
    specificityScore: Math.max(0, Math.min(1, specificityScore)),
    depthScore: Math.max(0, Math.min(1, depthScore)),
    qualityNotes
  };
}

async function computeFreeResearch(query, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const structured = await runStructuredFreeProviders(query, options);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const search = await searchWeb(query, options.count ?? 8, signal);
  const enriched = [];
  for (const result of search.results.slice(0, options.enrichCount ?? 6)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    enriched.push(await enrichResult(result, signal));
  }

  const keepCount = options.keepCount ?? 3;
  const rankedWeb = filterAndRankResults(enriched, query, keepCount + 1);
  const structuredFindings = structured.results.flatMap((result) => result.findings ?? []);
  const structuredAssistOnlyFindings = structuredFindings.filter((item) => item.structuredAssistOnly);
  const normalStructuredFindings = structuredFindings.filter((item) => !item.structuredAssistOnly);

  const findings = [
    ...normalStructuredFindings,
    ...rankedWeb.map((item) => ({
      source: item.pageTitle || item.title,
      url: item.url,
      summary: summarizeText(item.pageDescription || item.snippet || ''),
      qualityScore: item.qualityScore,
      provider: search.provider
    })),
    ...structuredAssistOnlyFindings
  ].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
   .slice(0, keepCount);

  const providerParts = [];
  if (structuredFindings.length > 0) providerParts.push('structured');
  providerParts.push(search.provider);
  const providerLabel = providerParts.join('+');
  const scores = scoreFreePass(query, findings, providerLabel);
  const qualityNotes = [
    ...scores.qualityNotes,
    ...structured.notes,
    ...(search.fallbackNotes ?? []).map((note) => `Fallback note: ${note}`)
  ];
  return {
    query,
    provider: providerLabel,
    freeFindings: findings,
    structuredResults: structured.results,
    baselineAnswer: findings.length > 0
      ? findings.map((item, index) => `${index + 1}. ${item.source}: ${item.summary}`).join(' ')
      : 'Free web search did not return enough usable evidence.',
    ...scores,
    qualityNotes
  };
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.(); // don't keep process alive
    })
  ]);
}

export async function runFreeResearch(query, options = {}) {
  const useCache = options.useCache !== false;
  if (useCache) {
    const cached = readCache(query, options);
    if (cached) return cached;
  }

  const maxMs = options.maxMs ?? 30000;
  const fallback = {
    query,
    provider: 'timeout',
    freeFindings: [],
    structuredResults: [],
    baselineAnswer: '',
    baselineConfidence: 0.1,
    freshnessScore: 0.3,
    specificityScore: 0.2,
    depthScore: 0.2,
    qualityNotes: [`Free research timed out after ${maxMs}ms`]
  };

  // Race computation against hard timeout
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, maxMs);
  timer.unref?.();

  let result;
  try {
    result = await Promise.race([
      computeFreeResearch(query, { ...options, signal: ac.signal }),
      new Promise((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })
    ]);
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    if (timedOut || err?.name === 'AbortError') {
      result = fallback;
    } else {
      throw err;
    }
  }
  const cache = useCache
    ? writeCache(query, options, result)
    : { hit: false, ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS };

  return {
    ...result,
    cache
  };
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.endsWith('/research/budget-aware-research-agent/free-research.mjs')) {
  const args = process.argv.slice(2);
  const noCache = args.includes('--no-cache');
  const query = args.filter((arg) => arg !== '--no-cache').join(' ').trim();
  if (!query) {
    console.error('Usage: node research/budget-aware-research-agent/free-research.mjs [--no-cache] "<query>"');
    process.exit(1);
  }
  runFreeResearch(query, { useCache: !noCache })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
