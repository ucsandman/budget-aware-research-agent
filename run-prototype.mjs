import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rewriteQueryForPaidSearch } from './query-rewrite.mjs';
import { runFreeResearch } from './free-research.mjs';
import { suggestFreeProviders } from './free-provider-registry.mjs';
import { discoverProviders, pickProvider, classifyQueryCategory } from './provider-discovery.mjs';
import { synthesizeAnswer } from './synthesize.mjs';
import { logCost } from './cost-tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_REQUEST = {
  budgetUsdMax: 0.25,
  freshnessNeed: 'medium',
  depthNeed: 'medium',
  mustBeCurrent: false,
  dryRun: true,
  notes: ''
};

const LIVE_ARTIFACTS_DIR = join(__dirname, 'logs', 'live-paid');

function parseArgs(argv) {
  const out = { ...DEFAULT_REQUEST, log: true, answerMode: false };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--query') out.query = argv[++i];
    else if (arg === '--request') Object.assign(out, JSON.parse(readFileSync(argv[++i], 'utf8')));
    else if (arg === '--budget') out.budgetUsdMax = Number(argv[++i]);
    else if (arg === '--freshness') out.freshnessNeed = argv[++i];
    else if (arg === '--depth') out.depthNeed = argv[++i];
    else if (arg === '--must-be-current') out.mustBeCurrent = true;
    else if (arg === '--live') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-log') out.log = false;
    else if (arg === '--answer') out.answerMode = true;
    else positional.push(arg);
  }

  if (!out.query && positional.length > 0) out.query = positional.join(' ');
  if (!out.query) {
    throw new Error('Missing query. Use --query "..." or pass the query positionally.');
  }

  return out;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function slugify(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'query';
}

function artifactStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureLiveArtifactsDir() {
  mkdirSync(LIVE_ARTIFACTS_DIR, { recursive: true });
}

function saveLiveArtifacts(query, requestPayload, rawResponse) {
  ensureLiveArtifactsDir();
  const stamp = artifactStamp();
  const slug = slugify(query);
  const base = `${stamp}-${slug}`;
  const payloadPath = join(LIVE_ARTIFACTS_DIR, `${base}.payload.json`);
  const responsePath = join(LIVE_ARTIFACTS_DIR, `${base}.response.json`);
  const manifestPath = join(LIVE_ARTIFACTS_DIR, `${base}.manifest.json`);

  writeFileSync(payloadPath, JSON.stringify(requestPayload, null, 2));
  writeFileSync(responsePath, JSON.stringify(rawResponse, null, 2));
  const manifest = {
    savedAt: new Date().toISOString(),
    query,
    payloadPath,
    responsePath,
    requestId: rawResponse?.data?.requestId ?? '',
    transactionHash: rawResponse?.metadata?.payment?.transactionHash ?? ''
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { payloadPath, responsePath, manifestPath };
}

function makeDecision(request, rewrite, freePass) {
  const query = request.query;
  const queryLower = query.toLowerCase();

  // --- Query shape classification ---
  // Conceptual: simple "what is X" with no time/data constraint
  const isConceptual = /^what (is|are) /i.test(query) && !request.mustBeCurrent
    && !/last \d+|recent|latest|current|this week|this month|today/i.test(query);
  // Strategic/opinion: reasoning questions better served by LLM than search
  const isStrategic = /(is it smarter|should i|good first wedge|priorit|pros and cons)/i.test(query);
  // Vague future: too open-ended for paid to add value
  const isVagueFuture = /(future opportunities|what might happen|predictions)/i.test(query);

  // --- Niche detection: topics where free sources are typically thin ---
  const nicheSignals = [
    /\b(dex|defi|liquidity|tvl|amm)\b/i,
    /\b(airdrop|token launch|tokenomics)\b/i,
    /\b(competitors?|market share|landscape)\b/i,
    /\b(402 index|agentcash|x402)\b/i,   // our own niche
    /\bon (base|arbitrum|optimism|solana) chain\b/i,
    /\bby (volume|tvl|users|revenue)\b/i
  ];
  const nicheScore = nicheSignals.reduce((n, re) => n + (re.test(query) ? 1 : 0), 0);
  const isNiche = nicheScore >= 1;

  // --- Time sensitivity detection ---
  const hasTimePressure = request.mustBeCurrent
    || /last \d+ (days?|weeks?|hours?)/i.test(query)
    || /\b(current|latest|recent|this week|right now|today)\b/i.test(query);

  // --- Score the value of escalating to paid ---
  const reasonCodes = [];
  let estimatedValueGain = 0;

  if (hasTimePressure) {
    reasonCodes.push('time_sensitive');
    estimatedValueGain += 0.25;
  }
  if (request.mustBeCurrent) {
    reasonCodes.push('must_be_current');
    estimatedValueGain += 0.15;
  }
  if (freePass.freshnessScore < 0.5) {
    reasonCodes.push('stale_free_results');
    estimatedValueGain += 0.18;
  }
  if (isNiche) {
    reasonCodes.push('niche_topic');
    estimatedValueGain += 0.25;
    // Extra penalty: niche topics with only generic free results
    if (freePass.specificityScore < 0.65) {
      estimatedValueGain += 0.1;
    }
  }

  // Free quality signals (only penalize when truly weak)
  const freeResultCount = freePass.freeFindings?.length ?? 0;
  if (freeResultCount <= 1) {
    reasonCodes.push('thin_free_results');
    estimatedValueGain += 0.2;
  }
  if (freePass.specificityScore < 0.4) {
    reasonCodes.push('insufficient_specificity');
    estimatedValueGain += 0.12;
  }
  if (freePass.depthScore < 0.4) {
    reasonCodes.push('insufficient_depth');
    estimatedValueGain += 0.12;
  }

  // Rewrite applied means paid can leverage a sharper query
  if (rewrite.rewriteApplied && estimatedValueGain > 0.15) {
    reasonCodes.push('rewrite_sharpens_paid');
    estimatedValueGain += 0.05;
  }

  // --- Stay-free overrides (strongest first) ---
  if (request.budgetUsdMax < 0.01) {
    return makeStayFreeResult(['budget_too_low'], estimatedValueGain, request);
  }
  if (isVagueFuture) {
    return makeStayFreeResult(['scope_too_vague', 'paid_gain_too_small'], estimatedValueGain, request);
  }
  if (isStrategic) {
    return makeStayFreeResult(['strategic_reasoning_better_fit'], estimatedValueGain, request);
  }
  // Conceptual stays free if we have decent free results, even for niche topics
  // The free coverage for "what is X" is usually good enough
  if (isConceptual && freeResultCount >= 2 && freePass.specificityScore >= 0.5) {
    return makeStayFreeResult(['conceptual_answer_sufficient', 'paid_gain_too_small'], estimatedValueGain, request);
  }

  // --- Escalation threshold ---
  // Need meaningful signal to escalate, not just minor specificity dips
  const escalationThreshold = 0.30;
  const shouldEscalate = estimatedValueGain >= escalationThreshold;

  if (!shouldEscalate) {
    return makeStayFreeResult(
      reasonCodes.length > 0 ? ['free_answer_sufficient', ...reasonCodes] : ['free_answer_sufficient'],
      estimatedValueGain,
      request
    );
  }

  return {
    shouldEscalatePaid: true,
    reasonCodes: [...new Set(reasonCodes)],
    decisionSummary: summarizeEscalation(reasonCodes),
    estimatedValueGain: clamp01(estimatedValueGain),
    estimatedPaidCostUsd: 0.01,
    budgetCheck: 'pass'
  };
}

function makeStayFreeResult(reasons, gain, request) {
  return {
    shouldEscalatePaid: false,
    reasonCodes: reasons,
    decisionSummary: `Stay free: ${reasons[0].replace(/_/g, ' ')}.`,
    estimatedValueGain: clamp01(gain),
    estimatedPaidCostUsd: 0.01,
    budgetCheck: request.budgetUsdMax >= 0.01 ? 'pass' : 'fail'
  };
}

function summarizeEscalation(codes) {
  if (codes.includes('must_be_current') || codes.includes('time_sensitive')) {
    return 'Escalate: query needs fresh data that free sources are unlikely to have.';
  }
  if (codes.includes('niche_topic')) {
    return 'Escalate: niche topic where free coverage is typically thin.';
  }
  if (codes.includes('thin_free_results')) {
    return 'Escalate: free search returned too few results to answer confidently.';
  }
  return 'Escalate: paid search is likely to materially improve the answer.';
}

function summarizePaidResult(raw) {
  const results = raw?.data?.results ?? [];
  return results.slice(0, 5).map((item) => ({
    source: item.title,
    url: item.url,
    summary: item.highlights?.[0]?.slice(0, 280) ?? 'No highlight returned.'
  }));
}

function executePaidSearch(query, dryRun, providerEndpoint = 'https://stableenrich.dev/api/exa/search', providerName = 'stableenrich.dev/api/exa/search') {
  if (dryRun) {
    return {
      provider: providerName,
      endpoint: providerEndpoint,
      mode: 'dry_run',
      costUsd: 0,
      rawResultSummary: 'Dry run only. Paid execution skipped.',
      paidFindings: [],
      executionNotes: ['No live payment executed.'],
      artifactPaths: null
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'budget-aware-research-'));
  const payloadPath = join(tempDir, 'payload.json');
  const payload = {
    query,
    numResults: 5,
    contents: {
      highlights: {
        numSentences: 2,
        highlightsPerUrl: 2,
        query
      }
    }
  };

  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  const result = spawnSync(process.execPath, [
    join(__dirname, 'lib', 'agentcash-fetch.mjs'),
    providerEndpoint,
    payloadPath
  ], {
    cwd: __dirname,
    encoding: 'utf8',
    shell: false,
    env: process.env
  });

  rmSync(tempDir, { recursive: true, force: true });

  if (result.status !== 0) {
    return {
      provider: providerName,
      endpoint: providerEndpoint,
      mode: 'live',
      costUsd: 0,
      rawResultSummary: 'Paid execution failed.',
      paidFindings: [],
      executionNotes: [result.stderr?.trim() || result.stdout?.trim() || 'Unknown AgentCash failure'],
      artifactPaths: null
    };
  }

  const raw = JSON.parse(result.stdout);
  const artifactPaths = saveLiveArtifacts(query, payload, raw);
  return {
    provider: providerName,
    endpoint: providerEndpoint,
    mode: 'live',
    costUsd: raw?.data?.costDollars?.total ?? 0.01,
    rawResultSummary: `Returned ${raw?.data?.results?.length ?? 0} paid results.`,
    paidFindings: summarizePaidResult(raw),
    executionNotes: [
      `requestId=${raw?.data?.requestId ?? 'unknown'}`,
      `transactionHash=${raw?.metadata?.payment?.transactionHash ?? 'unknown'}`,
      `artifactManifest=${artifactPaths.manifestPath}`
    ],
    artifactPaths
  };
}

function buildFinalResponse(request, rewrite, freePass, freeProviderSuggestions, decision, execution) {
  const paidUsed = decision.shouldEscalatePaid && execution.mode === 'live' && execution.paidFindings.length > 0;
  const finalConfidence = clamp01(
    freePass.baselineConfidence +
    (decision.shouldEscalatePaid ? 0.08 : 0) +
    (paidUsed ? 0.12 : 0)
  );

  const sourcesUsed = execution.paidFindings.map((item) => ({
    type: execution.mode === 'live' ? 'paid' : 'free',
    source: item.source,
    url: item.url
  }));

  return {
    query: request.query,
    answerSummary: decision.shouldEscalatePaid
      ? `Prototype recommends paid escalation${rewrite.rewriteApplied ? ' after query rewrite' : ''} for this query shape.`
      : 'Prototype recommends staying on the free path for this query shape.',
    freeOnlySummary: freePass.baselineAnswer,
    structuredFreeOptions: freeProviderSuggestions,
    paidUsed,
    paidExecutionMode: execution.mode,
    paidRecommended: decision.shouldEscalatePaid,
    paidContributionSummary: execution.mode === 'live'
      ? execution.rawResultSummary
      : 'No live paid contribution in this run.',
    sourcesUsed,
    finalConfidence,
    spendDecision: {
      usedPaid: paidUsed,
      costUsd: execution.costUsd,
      decisionSummary: decision.decisionSummary,
      reasonCodes: decision.reasonCodes,
      worthIt: paidUsed || (decision.shouldEscalatePaid && request.dryRun)
    },
    nextTimeRecommendation: rewrite.rewriteApplied
      ? 'Keep the rewrite step in front of broad mapping prompts before any paid search.'
      : 'Only add paid escalation when freshness or discovery gaps are visible.'
  };
}

function buildLogRecord(request, rewrite, freePass, freeProviderSuggestions, decision, execution, finalResponse) {
  return {
    timestamp: new Date().toISOString(),
    query: request.query,
    request: {
      budgetUsdMax: request.budgetUsdMax,
      freshnessNeed: request.freshnessNeed,
      depthNeed: request.depthNeed,
      mustBeCurrent: request.mustBeCurrent,
      dryRun: request.dryRun
    },
    queryRewrite: rewrite,
    freePass: {
      provider: freePass.provider,
      baselineConfidence: freePass.baselineConfidence,
      freshnessScore: freePass.freshnessScore,
      specificityScore: freePass.specificityScore,
      depthScore: freePass.depthScore,
      qualityNotes: freePass.qualityNotes,
      structuredResults: freePass.structuredResults,
      cache: freePass.cache
    },
    freeProviderSuggestions,
    decision,
    execution: {
      mode: execution.mode,
      actualCostUsd: execution.costUsd,
      provider: execution.provider,
      executionNotes: execution.executionNotes,
      artifactPaths: execution.artifactPaths
    },
    outcome: {
      finalConfidence: finalResponse.finalConfidence,
      worthIt: finalResponse.spendDecision.worthIt,
      recommendation: finalResponse.nextTimeRecommendation,
      answer: finalResponse.finalAnswer?.slice(0, 300),
      provider: finalResponse.selectedProvider,
      sources: finalResponse.sources?.map(s => s.title || s.source)
    }
  };
}

const FREE_RESEARCH_TIMEOUT_MS = 25000;
const FREE_RESEARCH_FALLBACK = {
  query: '',
  provider: 'timeout',
  freeFindings: [],
  structuredResults: [],
  baselineAnswer: '',
  baselineConfidence: 0.1,
  freshnessScore: 0.3,
  specificityScore: 0.2,
  depthScore: 0.2,
  qualityNotes: ['Free research timed out (subprocess killed)']
};

async function runFreeResearchSafe(query, options) {
  try {
    const directResult = await Promise.race([
      runFreeResearch(query, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FREE_RESEARCH_TIMEOUT_MS))
    ]);
    return directResult;
  } catch (err) {
    if (err.message === 'timeout') {
      return { ...FREE_RESEARCH_FALLBACK, query, qualityNotes: [`Free research timed out after ${FREE_RESEARCH_TIMEOUT_MS}ms`] };
    }
    // Non-timeout errors: log and return fallback so paid routing can still proceed
    console.error(`[free-research] Error: ${err.message}`);
    return { ...FREE_RESEARCH_FALLBACK, query, qualityNotes: [`Free research failed: ${err.message}`] };
  }
}

function printAnswer(request, freePass, decision, execution, finalResponse) {
  const lines = [];
  lines.push(`Q: ${request.query}`);
  lines.push('');

  // LLM-synthesized answer from all sources
  const freeFindings = freePass.freeFindings || freePass.results || [];
  const paidFindings = execution.paidFindings || [];
  const synthesis = synthesizeAnswer(request.query, freeFindings, paidFindings);

  lines.push('## Answer');
  lines.push(synthesis.answer);
  lines.push('');

  // Sources list
  const allSources = [...paidFindings, ...freeFindings].slice(0, 6);
  if (allSources.length > 0) {
    lines.push('## Sources');
    for (const s of allSources) {
      const title = s.title || s.source || 'Untitled';
      const url = s.url || s.link || '';
      const tag = paidFindings.includes(s) ? ' [paid]' : '';
      lines.push(`- ${title}${tag}${url ? ` — ${url}` : ''}`);
    }
    lines.push('');
  }

  // Decision footer
  lines.push('---');
  const conf = `${(finalResponse.finalConfidence * 100).toFixed(0)}%`;
  if (decision.shouldEscalatePaid) {
    const cost = execution.mode === 'live' ? ` | $${execution.costUsd.toFixed(3)}` : ' | dry run';
    lines.push(`Provider: ${decision.selectedProvider} (${decision.providerSource})${cost} | Confidence: ${conf} | Synthesis: ${synthesis.method}`);
  } else {
    lines.push(`Free path | ${decision.reasonCodes.join(', ')} | Confidence: ${conf} | Synthesis: ${synthesis.method}`);
  }

  console.log(lines.join('\n'));
}

async function main() {
  const request = parseArgs(process.argv.slice(2));
  const rewrite = rewriteQueryForPaidSearch(request.query);
  const freeProviderSuggestions = suggestFreeProviders(request.query);

  // Discover paid provider dynamically via 402 Index
  const queryCategory = classifyQueryCategory(request.query);
  const discovery = await discoverProviders(queryCategory);
  const providerPick = pickProvider(discovery, request.budgetUsdMax);

  const freePass = await runFreeResearchSafe(request.query, {
    count: 5,
    enrichCount: 3,
    keepCount: 3,
    useCache: true
  });

  // Hybrid routing: if rewrite was applied, re-evaluate free sufficiency
  // after the query is sharpened, but before escalating to paid.
  if (rewrite.rewriteApplied) {
    freePass.qualityNotes.push('Rewrite applied; re-evaluating sufficiency with sharpened frame.');
    freePass.specificityScore = clamp01(freePass.specificityScore - 0.15);
  }
  if (request.mustBeCurrent || request.freshnessNeed === 'high') {
    freePass.freshnessScore = clamp01(freePass.freshnessScore - 0.12);
    freePass.qualityNotes.push('Applied extra freshness penalty because the request explicitly needs current information.');
  }
  if (request.depthNeed === 'high') {
    freePass.depthScore = clamp01(freePass.depthScore - 0.08);
    freePass.qualityNotes.push('Applied extra depth penalty because the request asks for higher detail than a shallow search pass guarantees.');
  }

  const selectedEndpoint = providerPick.provider?.endpoint || 'https://stableenrich.dev/api/exa/search';
  const selectedName = providerPick.provider?.name || 'stableenrich.dev/api/exa/search';

  const decision = makeDecision(request, rewrite, freePass);
  // Override decision's provider fields with dynamic discovery
  decision.selectedProvider = selectedName;
  decision.selectedProviderEndpoint = selectedEndpoint;
  decision.providerSource = discovery.source;
  decision.providerAlternatives = providerPick.alternativeCount;
  if (providerPick.overBudget) {
    decision.selectedProviderWhy = `Cheapest available (${selectedName}) exceeds budget but no cheaper option found.`;
  } else if (discovery.source === 'fallback') {
    decision.selectedProviderWhy = `402 Index unavailable, fell back to default provider.`;
  } else {
    decision.selectedProviderWhy = `Cheapest healthy x402 provider for "${queryCategory}" via 402 Index (${discovery.source}).`;
  }

  const execution = decision.shouldEscalatePaid
    ? executePaidSearch(rewrite.rewrittenQuery, request.dryRun, selectedEndpoint, selectedName)
    : {
        provider: selectedName,
        endpoint: selectedEndpoint,
        mode: request.dryRun ? 'dry_run' : 'skipped',
        costUsd: 0,
        rawResultSummary: 'Paid execution not used.',
        paidFindings: [],
        executionNotes: ['Decision stayed on free path.'],
        artifactPaths: null
      };
  const finalResponse = buildFinalResponse(request, rewrite, freePass, freeProviderSuggestions, decision, execution);
  
  // Synthesize answer for logging (even if not printing)
  const freeFindings = freePass.freeFindings || freePass.results || [];
  const paidFindings = execution.paidFindings || [];
  const synthesis = synthesizeAnswer(request.query, freeFindings, paidFindings);
  
  // Add synthesis to finalResponse for logging
  finalResponse.finalAnswer = synthesis.answer;
  finalResponse.selectedProvider = decision.selectedProvider || 'free';
  finalResponse.sources = [...paidFindings, ...freeFindings].slice(0, 6);
  finalResponse.synthesisMethod = synthesis.method;

  const logRecord = buildLogRecord(request, rewrite, freePass, freeProviderSuggestions, decision, execution, finalResponse);

  if (request.log) {
    const logsDir = join(__dirname, 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(
      join(logsDir, 'runs.jsonl'),
      `${JSON.stringify(logRecord)}\n`
    );
  }

  // Cost tracking (always log, even dry runs)
  const synthesisCostEstimate = execution.mode === 'live' || !request.dryRun ? 0.0003 : 0;
  logCost({
    query: request.query,
    provider: decision.selectedProvider || selectedName,
    searchCostUsd: execution.costUsd || 0,
    synthesisCostUsd: synthesisCostEstimate,
    mode: execution.mode,
    synthesisMethod: request.answerMode ? 'llm' : 'none',
    providerSource: decision.providerSource || discovery.source,
    routingDecision: decision.shouldEscalatePaid ? 'paid' : 'free',
    confidence: finalResponse.finalConfidence || 0
  });

  // Output mode
  if (request.answerMode) {
    printAnswer(request, freePass, decision, execution, finalResponse);
  } else {
    console.log(JSON.stringify({ request, queryRewrite: rewrite, freePass, discovery: { source: discovery.source, category: queryCategory, picked: selectedName, alternatives: providerPick.alternativeCount }, decision, execution, finalResponse }, null, 2));
  }
}

// Named exports for testing
export { makeDecision, makeStayFreeResult };

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Only run main() when executed directly (not imported for testing)
const invoked = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (invoked.endsWith('/run-prototype.mjs')) {
  main()
    .then(() => {
      // Force exit after a short delay to flush stdout
      // Needed because dangling fetch handles may keep the event loop alive
      setTimeout(() => process.exit(0), 200);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
