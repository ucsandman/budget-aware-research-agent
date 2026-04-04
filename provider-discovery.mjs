/**
 * Provider Discovery via 402 Index
 * 
 * Queries 402index.io to find the best paid provider for a given
 * query category at runtime, instead of hardcoding providers.
 * 
 * Cache-first: provider listings change slowly, so cache for 24h.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_BASE = 'https://402index.io/api/v1';
const CACHE_DIR = 'C:/Users/sandm/clawd/research/budget-aware-research-agent/cache/providers';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const CATEGORY_MAP = {
  'web-research': 'search',
  'company-lookup': 'enrichment',
  'people-search': 'enrichment',
  'social-data': 'social',
  'web-scraping': 'scraping',
  'news': 'news',
  'academic': 'search'
};

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(category) {
  return `providers-${category}.json`;
}

function readProviderCache(category) {
  ensureCacheDir();
  const path = join(CACHE_DIR, cacheKey(category));
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const age = Date.now() - new Date(data.cachedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeProviderCache(category, providers) {
  ensureCacheDir();
  const path = join(CACHE_DIR, cacheKey(category));
  const data = {
    cachedAt: new Date().toISOString(),
    category,
    providers
  };
  writeFileSync(path, JSON.stringify(data, null, 2));
  return data;
}

async function queryIndex(category) {
  const url = `${INDEX_BASE}/services?protocol=x402&health=healthy&category=${encodeURIComponent(category)}&sort=price&order=asc&limit=10`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`402 Index query failed: ${res.status}`);
  const json = await res.json();
  return (json.services ?? json.data ?? json ?? []).map(svc => ({
    name: svc.name ?? svc.provider ?? 'unknown',
    endpoint: svc.endpoint ?? svc.url ?? '',
    priceUsd: svc.price_usd ?? svc.price ?? null,
    protocol: svc.protocol ?? 'x402',
    health: svc.health ?? 'unknown',
    description: svc.description ?? '',
    paymentAsset: svc.payment_asset ?? 'USDC'
  }));
}

/**
 * Discover providers for a query category.
 * Returns cached results if fresh, otherwise queries 402 Index.
 */
export async function discoverProviders(queryCategory) {
  const indexCategory = CATEGORY_MAP[queryCategory] ?? queryCategory;
  
  const cached = readProviderCache(indexCategory);
  if (cached) {
    return {
      source: 'cache',
      category: indexCategory,
      providers: cached.providers,
      cachedAt: cached.cachedAt
    };
  }

  try {
    const providers = await queryIndex(indexCategory);
    writeProviderCache(indexCategory, providers);
    return {
      source: 'live',
      category: indexCategory,
      providers,
      cachedAt: new Date().toISOString()
    };
  } catch (err) {
    // Fallback to hardcoded default
    return {
      source: 'fallback',
      category: indexCategory,
      providers: [{
        name: 'Exa Search (via StableEnrich)',
        endpoint: 'https://stableenrich.dev/api/exa/search',
        priceUsd: 0.01,
        protocol: 'x402',
        health: 'healthy',
        description: 'Web search via Exa API',
        paymentAsset: 'USDC'
      }],
      error: err.message,
      cachedAt: null
    };
  }
}

/**
 * Pick the best provider for a given query shape.
 * Prefers cheapest healthy x402 provider in the right category.
 */
export function pickProvider(discoveryResult, budgetUsd = 0.25) {
  const affordable = discoveryResult.providers.filter(
    p => p.priceUsd !== null && p.priceUsd <= budgetUsd
  );
  
  if (affordable.length === 0 && discoveryResult.providers.length > 0) {
    // Return cheapest even if over budget, let caller decide
    return {
      provider: discoveryResult.providers[0],
      overBudget: true,
      alternativeCount: discoveryResult.providers.length
    };
  }
  
  return {
    provider: affordable[0] ?? discoveryResult.providers[0] ?? null,
    overBudget: false,
    alternativeCount: discoveryResult.providers.length
  };
}

/**
 * Classify a query into a provider category.
 */
export function classifyQueryCategory(query) {
  const q = query.toLowerCase();
  if (/company|business|org|startup|funding|revenue/i.test(q)) return 'company-lookup';
  if (/person|people|contact|email|linkedin|who is/i.test(q)) return 'people-search';
  if (/instagram|tiktok|youtube|twitter|social|follower/i.test(q)) return 'social-data';
  if (/scrape|crawl|extract|page content/i.test(q)) return 'web-scraping';
  if (/paper|journal|doi|citation|arxiv|pubmed/i.test(q)) return 'academic';
  if (/news|breaking|headline|announcement/i.test(q)) return 'news';
  return 'web-research';
}

// CLI entrypoint
const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.endsWith('/provider-discovery.mjs')) {
  const query = process.argv.slice(2).join(' ').trim() || 'x402 agent payment providers on Base';
  const category = classifyQueryCategory(query);
  console.log(`Query: ${query}`);
  console.log(`Category: ${category}`);
  discoverProviders(category)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      const pick = pickProvider(result);
      console.log('\nBest pick:', JSON.stringify(pick, null, 2));
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
