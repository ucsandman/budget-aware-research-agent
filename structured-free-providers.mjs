import { suggestFreeProviders } from './free-provider-registry.mjs';

const USER_AGENT = 'BudgetAwareResearchAgent/0.1 (mailto:wes.sander.uc@gmail.com)';
const STOP_TERMS = new Set([
  'chain', 'chains', 'crypto', 'token', 'tokens', 'project', 'projects', 'protocol', 'protocols',
  'defi', 'ecosystem', 'market', 'markets', 'data', 'lookup', 'look', 'recent', 'best', 'top', 'find',
  'compare', 'comparison', 'category', 'categories', 'tvl', 'by', 'on', 'for', 'with', 'and', 'the',
  'base', 'agent', 'agents'
]);
const GENERIC_COMPARISON_ENTITY_TERMS = new Set([
  'what', 'which', 'are', 'how', 'they', 'them', 'their', 'main', 'tradeoffs', 'across', 'current', 'builders', 'right', 'now', 'relevant',
  'protocols', 'protocol', 'looks', 'look', 'most', 'active', 'differ', 'alternatives'
]);

const CATEGORY_ALIASES = [
  { canonical: 'lending', variants: ['lending', 'lend', 'loans', 'loan'] },
  { canonical: 'dex', variants: ['dex', 'dexes', 'exchange', 'exchanges', 'swaps', 'swap', 'amm', 'amms'] },
  { canonical: 'bridge', variants: ['bridge', 'bridges', 'bridging'] },
  { canonical: 'stablecoins', variants: ['stablecoin', 'stablecoins'] },
  { canonical: 'yield', variants: ['yield', 'yield farming', 'farm', 'farming'] },
  { canonical: 'perps', variants: ['perps', 'perpetual', 'perpetuals'] },
  { canonical: 'cdp', variants: ['cdp', 'collateralized debt'] },
  { canonical: 'options', variants: ['options', 'option vault'] },
  { canonical: 'liquid staking', variants: ['liquid staking', 'lst', 'staking'] },
  { canonical: 'restaking', variants: ['restaking', 'restake'] },
  { canonical: 'privacy', variants: ['privacy', 'private'] },
  { canonical: 'prediction market', variants: ['prediction market', 'prediction markets', 'predictions'] },
  { canonical: 'payments', variants: ['payments', 'payment'] },
  { canonical: 'cex', variants: ['cex', 'centralized exchange', 'centralized exchanges'] }
];

const CATEGORY_VARIANT_TO_CANONICAL = new Map(
  CATEGORY_ALIASES.flatMap((entry) => entry.variants.map((variant) => [variant.toLowerCase(), entry.canonical]))
);

function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function scoreQueryOverlap(text, query) {
  const haystack = cleanText(text).toLowerCase();
  const terms = query.toLowerCase().split(/\W+/).filter((word) => word.length >= 4);
  const unique = [...new Set(terms)];
  return unique.filter((term) => haystack.includes(term)).length;
}

function queryTerms(query) {
  return [...new Set(query.toLowerCase().split(/\W+/).filter((word) => word.length >= 3))];
}

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, 'i').test(text);
}

function pickBestTitle(work = {}) {
  const title = Array.isArray(work.title) ? work.title[0] : work.title;
  return cleanText(title || 'Untitled work');
}

function pickBestDate(work = {}) {
  const parts = work.issued?.['date-parts']?.[0] || work.created?.['date-parts']?.[0];
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const [y, m = 1, d = 1] = parts;
  return [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}

function pickBestUrl(work = {}) {
  return work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : '');
}

function pickAuthors(work = {}) {
  const authors = Array.isArray(work.author) ? work.author : [];
  return authors.slice(0, 3).map((author) => cleanText([author.given, author.family].filter(Boolean).join(' '))).filter(Boolean);
}

function summarizeCrossrefWork(work = {}) {
  const authors = pickAuthors(work);
  const year = pickBestDate(work).slice(0, 4);
  const container = Array.isArray(work['container-title']) ? work['container-title'][0] : work['container-title'];
  const pieces = [];
  if (authors.length > 0) pieces.push(`Authors: ${authors.join(', ')}`);
  if (container) pieces.push(`Venue: ${cleanText(container)}`);
  if (year) pieces.push(`Year: ${year}`);
  if (work.type) pieces.push(`Type: ${cleanText(work.type)}`);
  return pieces.join(' | ');
}

function classifyAcademicLookup(query) {
  const lower = query.toLowerCase();
  const hardSignals = ['doi', 'citation', 'citations', 'paper', 'papers', 'journal', 'publication', 'published', 'author', 'authors', 'research'];
  const softSignals = ['study', 'studies', 'preprint', 'conference', 'bibliography', 'scholar'];
  const overlap = hardSignals.filter((token) => lower.includes(token)).length;
  const softOverlap = softSignals.filter((token) => lower.includes(token)).length;
  const hasLookupShape = /(find|lookup|resolve|get|recent|latest|which|what)\b/i.test(query);
  const score = overlap * 2 + softOverlap + (hasLookupShape ? 1 : 0);
  return {
    score,
    likelyAcademicLookup: score >= 3,
    note: score >= 3
      ? `Academic lookup signals detected (score ${score}).`
      : `Academic lookup signals too weak for Crossref (score ${score}).`
  };
}

function classifyDexComparisonShape(query) {
  const lower = query.toLowerCase();
  const hasDexSignal = /\bdex\b|\bamm\b|\bswaps?\b|\bexchanges?\b/i.test(lower);
  const hasCompareSignal = /\bcompare\b|\bcomparison\b|\bdiffer\b|\btradeoffs?\b|\balternatives?\b|\bbest\b|\btop\b|\bwhich\b/i.test(lower);
  const hasBroadSignal = /\bcurrent\b|\blandscape\b|\becosystem\b|\bmap\b|\bplatforms?\b|\bprotocols?\b/i.test(lower);
  const entityTerms = extractEntityTerms(query, extractCategoryPreferences(query));
  const namedProtocolPresent = entityTerms.length > 0;
  return {
    isBroadDexComparison: hasDexSignal && hasCompareSignal && (hasBroadSignal || !namedProtocolPresent),
    namedProtocolPresent,
    note: hasDexSignal && hasCompareSignal
      ? namedProtocolPresent
        ? 'Detected DEX comparison shape with named entities.'
        : 'Detected broad DEX comparison shape; structured data should assist, not dominate.'
      : 'No special DEX comparison routing applied.'
  };
}

function extractChainPreferences(query) {
  const lower = query.toLowerCase();
  const aliases = [
    { canonical: 'base', variants: ['base'] },
    { canonical: 'ethereum', variants: ['ethereum', 'mainnet', 'eth'] },
    { canonical: 'solana', variants: ['solana', 'sol'] },
    { canonical: 'arbitrum', variants: ['arbitrum', 'arb'] },
    { canonical: 'optimism', variants: ['optimism', 'op mainnet'] },
    { canonical: 'polygon', variants: ['polygon', 'matic'] },
    { canonical: 'avalanche', variants: ['avalanche', 'avax'] },
    { canonical: 'bnb chain', variants: ['bnb chain', 'binance smart chain', 'bsc'] },
    { canonical: 'tron', variants: ['tron'] },
    { canonical: 'aptos', variants: ['aptos'] },
    { canonical: 'sui', variants: ['sui'] }
  ];

  return aliases
    .filter((entry) => entry.variants.some((variant) => containsPhrase(lower, variant)))
    .map((entry) => entry.canonical);
}

function extractCategoryPreferences(query) {
  const lower = query.toLowerCase();
  return CATEGORY_ALIASES
    .filter((entry) => entry.variants.some((variant) => containsPhrase(lower, variant)))
    .map((entry) => entry.canonical);
}

function normalizeProtocolCategory(category = '') {
  const lower = cleanText(category).toLowerCase();
  if (!lower) return '';

  if (/\bdex\b/.test(lower) || /\bamm\b/.test(lower)) return 'dex';
  if (/\blending\b/.test(lower) || /\blending market\b/.test(lower) || /\blending protocol\b/.test(lower)) return 'lending';
  if (/\bbridge\b/.test(lower)) return 'bridge';
  if (/\bstablecoin/.test(lower)) return 'stablecoins';
  if (/\byield\b/.test(lower) || /\bfarm/.test(lower)) return 'yield';
  if (/\bperp/.test(lower)) return 'perps';
  if (/\bcdp\b/.test(lower)) return 'cdp';
  if (/\boption/.test(lower)) return 'options';
  if (lower.includes('liquid staking')) return 'liquid staking';
  if (lower.includes('restak')) return 'restaking';
  if (/\bprivacy\b/.test(lower)) return 'privacy';
  if (lower.includes('prediction')) return 'prediction market';
  if (/\bpayment/.test(lower)) return 'payments';
  if (/\bcex\b/.test(lower)) return 'cex';

  return lower;
}

function extractEntityTerms(query, preferredCategories = []) {
  const categoryVariantsToStrip = new Set();
  for (const canonical of preferredCategories) {
    categoryVariantsToStrip.add(canonical.toLowerCase());
    for (const [variant, mappedCanonical] of CATEGORY_VARIANT_TO_CANONICAL.entries()) {
      if (mappedCanonical === canonical) {
        categoryVariantsToStrip.add(variant);
      }
    }
  }

  return queryTerms(query)
    .filter((term) => !STOP_TERMS.has(term))
    .filter((term) => !categoryVariantsToStrip.has(term.toLowerCase()))
    .filter((term) => !GENERIC_COMPARISON_ENTITY_TERMS.has(term.toLowerCase()));
}

function normalizeChainTvls(chainTvls = {}) {
  return Object.entries(chainTvls)
    .map(([name, value]) => ({
      name: cleanText(name),
      lower: cleanText(name).toLowerCase(),
      value: Number(value) || 0
    }))
    .filter((entry) => entry.name);
}

function scoreChainMatch(protocol = {}, preferredChains = []) {
  if (preferredChains.length === 0) {
    return { chainMatchScore: 0, matchedChains: [], strongestMatchedChainTvl: 0, chainPenalty: 0 };
  }

  const chainEntries = normalizeChainTvls(protocol.chainTvls ?? {});
  const protocolChains = [
    cleanText(protocol.chain || ''),
    ...((protocol.chains || []).map((chain) => cleanText(chain)))
  ].filter(Boolean).map((chain) => chain.toLowerCase());

  const matchedChains = [];
  let strongestMatchedChainTvl = 0;
  for (const preferred of preferredChains) {
    const lowerPreferred = preferred.toLowerCase();
    const matchedEntry = chainEntries.find((entry) => entry.lower === lowerPreferred || entry.lower.startsWith(`${lowerPreferred}-`));
    const matchedProtocolChain = protocolChains.some((chain) => chain === lowerPreferred || chain.startsWith(`${lowerPreferred}-`));
    if (matchedEntry || matchedProtocolChain) {
      matchedChains.push(preferred);
      strongestMatchedChainTvl = Math.max(strongestMatchedChainTvl, matchedEntry?.value ?? 0);
    }
  }

  const chainMatchScore = matchedChains.length === 0
    ? 0
    : 2 + Math.min(2, Math.log10(Math.max(1, strongestMatchedChainTvl)) - 4);

  const chainPenalty = matchedChains.length === 0 && preferredChains.length > 0 ? 2 : 0;

  return {
    chainMatchScore: Math.max(0, chainMatchScore),
    matchedChains,
    strongestMatchedChainTvl,
    chainPenalty
  };
}

function scoreCategoryMatch(protocol = {}, preferredCategories = []) {
  const normalizedCategory = normalizeProtocolCategory(protocol.category || '');
  if (preferredCategories.length === 0) {
    return { categoryScore: 0, matchedCategories: [], categoryPenalty: 0, normalizedCategory };
  }

  const matchedCategories = preferredCategories.filter((category) => category === normalizedCategory);
  const categoryScore = matchedCategories.length > 0 ? 3 : 0;

  let categoryPenalty = 0;
  if (matchedCategories.length === 0 && preferredCategories.length > 0) {
    if (normalizedCategory === 'cex') {
      categoryPenalty = 3;
    } else {
      categoryPenalty = 2;
    }
  }

  return {
    categoryScore,
    matchedCategories,
    categoryPenalty,
    normalizedCategory
  };
}

function scoreEntitySpecificity(protocol = {}, entityTerms = []) {
  if (entityTerms.length === 0) {
    return { entityScore: 0, matchedEntityTerms: [] };
  }

  const searchable = cleanText([
    protocol.name,
    protocol.slug,
    protocol.symbol,
    protocol.category,
    protocol.chain,
    ...(protocol.chains || [])
  ].filter(Boolean).join(' ')).toLowerCase();

  const matchedEntityTerms = entityTerms.filter((term) => searchable.includes(term.toLowerCase()));
  const entityScore = matchedEntityTerms.length === 0 ? 0 : Math.min(3, matchedEntityTerms.length * 1.5);
  return { entityScore, matchedEntityTerms };
}

function protocolUrl(protocol = {}) {
  if (protocol.url) {
    const raw = String(protocol.url);
    return raw.startsWith('http') ? raw : `https://defillama.com${raw}`;
  }
  return `https://defillama.com/protocol/${protocol.slug || ''}`;
}

function applyStructuredRoutingPolicy(query, providerResult) {
  const dexShape = classifyDexComparisonShape(query);
  const findings = [...(providerResult.findings ?? [])];
  const notes = [...(providerResult.notes ?? [])];

  if (providerResult.provider === 'defillama' && dexShape.isBroadDexComparison && !dexShape.namedProtocolPresent) {
    const assistedFindings = findings
      .map((item) => ({
        ...item,
        qualityScore: Math.max(3, Math.min(item.qualityScore ?? 0, 6)),
        structuredAssistOnly: true
      }))
      .slice(0, 1);

    notes.push('Applied hybrid routing rule: broad DEX comparison prompts only get one structured DefiLlama assist result, so web discovery still leads the answer.');
    return {
      ...providerResult,
      findings: assistedFindings,
      notes,
      routingPolicy: 'assist_only_for_broad_dex_comparison',
      dexComparisonShape: dexShape
    };
  }

  return {
    ...providerResult,
    notes: dexShape.note !== 'No special DEX comparison routing applied.' ? [...notes, dexShape.note] : notes,
    routingPolicy: 'normal',
    dexComparisonShape: dexShape
  };
}

export async function queryCrossref(query, options = {}) {
  const rows = options.rows ?? 5;
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&sort=relevance&order=desc`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Crossref request failed with ${res.status}`);
  }
  const json = await res.json();
  const items = json?.message?.items ?? [];
  const findings = items.map((work) => {
    const source = pickBestTitle(work);
    const summary = summarizeCrossrefWork(work);
    const overlapScore = scoreQueryOverlap(`${source} ${summary}`, query);
    const doiBonus = work.DOI ? 1 : 0;
    return {
      source,
      url: pickBestUrl(work),
      summary,
      qualityScore: 5 + Math.min(3, overlapScore) + doiBonus,
      provider: 'crossref',
      doi: work.DOI || '',
      publishedDate: pickBestDate(work),
      overlapScore
    };
  }).filter((item) => item.source && item.url && item.overlapScore >= (options.crossrefMinOverlap ?? 2))
    .sort((a, b) => b.overlapScore - a.overlapScore || b.qualityScore - a.qualityScore)
    .slice(0, options.crossrefKeepCount ?? 3);

  return {
    provider: 'crossref',
    matchedIntent: 'paper_lookup',
    findings,
    notes: findings.length > 0
      ? [`Crossref returned ${findings.length} structured research metadata results after stricter overlap filtering.`]
      : ['Crossref returned no sufficiently relevant structured research metadata results.']
  };
}

function summarizeDefiLlamaProtocol(protocol = {}) {
  const pieces = [];
  if (protocol.category) pieces.push(`Category: ${cleanText(protocol.category)}`);
  if (protocol.chain) pieces.push(`Chain: ${cleanText(protocol.chain)}`);
  if (protocol.tvl != null) pieces.push(`TVL: ${Number(protocol.tvl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  if (protocol.change_1d != null) pieces.push(`1d change: ${Number(protocol.change_1d).toFixed(2)}%`);
  return pieces.join(' | ');
}

export async function queryDefiLlama(query, options = {}) {
  const res = await fetch('https://api.llama.fi/protocols', {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`DefiLlama request failed with ${res.status}`);
  }

  const json = await res.json();
  const preferredChains = extractChainPreferences(query);
  const preferredCategories = extractCategoryPreferences(query);
  const entityTerms = extractEntityTerms(query, preferredCategories);
  const findings = (Array.isArray(json) ? json : [])
    .map((protocol) => {
      const source = cleanText(protocol.name || '');
      const url = protocolUrl(protocol);
      const summary = summarizeDefiLlamaProtocol(protocol);
      const searchable = `${source} ${protocol.symbol || ''} ${protocol.category || ''} ${(protocol.chains || []).join(' ')} ${summary}`;
      const overlapScore = scoreQueryOverlap(searchable, query);
      const entity = scoreEntitySpecificity(protocol, entityTerms);
      const chain = scoreChainMatch(protocol, preferredChains);
      const category = scoreCategoryMatch(protocol, preferredCategories);
      const combinedScore = overlapScore + entity.entityScore + chain.chainMatchScore + category.categoryScore - chain.chainPenalty - category.categoryPenalty;

      return {
        source,
        url,
        summary,
        qualityScore: 5 + Math.min(6, Math.max(0, combinedScore)),
        provider: 'defillama',
        overlapScore,
        entityScore: entity.entityScore,
        matchedEntityTerms: entity.matchedEntityTerms,
        chainMatchScore: chain.chainMatchScore,
        matchedChains: chain.matchedChains,
        strongestMatchedChainTvl: chain.strongestMatchedChainTvl,
        chainPenalty: chain.chainPenalty,
        categoryScore: category.categoryScore,
        matchedCategories: category.matchedCategories,
        normalizedCategory: category.normalizedCategory,
        categoryPenalty: category.categoryPenalty,
        chainTvls: protocol.chainTvls ?? {},
        slug: protocol.slug || ''
      };
    })
    .filter((item) => item.source && item.url && (item.overlapScore + item.entityScore + item.chainMatchScore + item.categoryScore - item.chainPenalty - item.categoryPenalty) >= (options.defillamaMinScore ?? 2))
    .sort((a, b) => {
      const aCombined = a.overlapScore + a.entityScore + a.chainMatchScore + a.categoryScore - a.chainPenalty - a.categoryPenalty;
      const bCombined = b.overlapScore + b.entityScore + b.chainMatchScore + b.categoryScore - b.chainPenalty - b.categoryPenalty;
      return bCombined - aCombined
        || b.categoryScore - a.categoryScore
        || b.strongestMatchedChainTvl - a.strongestMatchedChainTvl
        || b.qualityScore - a.qualityScore;
    })
    .slice(0, options.defillamaKeepCount ?? 3);

  const noteParts = [];
  if (preferredChains.length > 0) noteParts.push(`preferred chains: ${preferredChains.join(', ')}`);
  if (preferredCategories.length > 0) noteParts.push(`preferred categories: ${preferredCategories.join(', ')}`);
  if (entityTerms.length > 0) noteParts.push(`entity terms: ${entityTerms.join(', ')}`);

  return {
    provider: 'defillama',
    matchedIntent: 'protocol_lookup',
    findings,
    notes: findings.length > 0
      ? [`DefiLlama returned ${findings.length} structured protocol/project results after chain/entity/category-aware filtering${noteParts.length > 0 ? ` (${noteParts.join(' | ')})` : ''}.`]
      : ['DefiLlama returned no sufficiently relevant protocol/project results for this query.']
  };
}

export async function runStructuredFreeProviders(query, options = {}) {
  const suggestions = suggestFreeProviders(query);
  const providerIds = suggestions.suggestedProviders.map((provider) => provider.id);
  const results = [];
  const notes = [];
  const academic = classifyAcademicLookup(query);

  if (providerIds.includes('crossref')) {
    notes.push(academic.note);
    if (academic.likelyAcademicLookup) {
      try {
        const crossref = applyStructuredRoutingPolicy(query, await queryCrossref(query, { rows: options.crossrefRows ?? 5 }));
        if ((crossref.findings ?? []).length > 0) {
          results.push(crossref);
        }
        notes.push(...crossref.notes);
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      notes.push('Crossref was suggested by intent matching but skipped because the query did not look like a concrete academic lookup.');
    }
  }

  if (providerIds.includes('defillama')) {
    try {
      const defillama = applyStructuredRoutingPolicy(query, await queryDefiLlama(query, {
        defillamaMinScore: options.defillamaMinScore ?? 2,
        defillamaKeepCount: options.defillamaKeepCount ?? 3
      }));
      if ((defillama.findings ?? []).length > 0) {
        results.push(defillama);
      }
      notes.push(...defillama.notes);
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    suggestions,
    results,
    notes
  };
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.endsWith('/research/budget-aware-research-agent/structured-free-providers.mjs')) {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node research/budget-aware-research-agent/structured-free-providers.mjs "<query>"');
    process.exit(1);
  }
  runStructuredFreeProviders(query)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
