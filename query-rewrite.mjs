const BROAD_MAPPING_PATTERNS = [
  /\bmap\b/i,
  /\becosystem\b/i,
  /\blandscape\b/i,
  /\bvendors?\b/i,
  /\btools?\b/i,
  /\bplatforms?\b/i,
  /\balternatives?\b/i,
  /\bright now\b/i,
  /\bcurrent\b/i,
  /\bbest\b/i,
  /\bmost relevant\b/i
];

const AGENT_WORKFLOW_HINTS = [
  /\bagents?\b/i,
  /\bagentic\b/i,
  /\bx402\b/i,
  /\bpayments?\b/i,
  /\bresearch\b/i,
  /\bbrowser\b/i,
  /\bscrap(?:e|ing)\b/i,
  /\benrichment\b/i
];

function scoreBroadness(query) {
  let score = 0;
  for (const pattern of BROAD_MAPPING_PATTERNS) {
    if (pattern.test(query)) score += 1;
  }
  if (query.split(/\s+/).length >= 12) score += 1;
  return score;
}

function hasWorkflowSignal(query) {
  return AGENT_WORKFLOW_HINTS.some((pattern) => pattern.test(query));
}

function extractDomain(query) {
  const lower = query.toLowerCase();
  if (lower.includes('browser')) return 'browser infrastructure for AI agents';
  if (lower.includes('x402')) return 'x402 and agent-native payments';
  if (lower.includes('research') || lower.includes('scraping') || lower.includes('enrichment')) {
    return 'agent web research, search augmentation, and scraping';
  }
  if (lower.includes('premium data') || lower.includes('programmatically')) {
    return 'tools that let agents buy premium data or services programmatically';
  }
  return query.replace(/[?.!]+$/, '');
}

export function rewriteQueryForPaidSearch(query) {
  const broadnessScore = scoreBroadness(query);
  const shouldRewrite = broadnessScore >= 3 && hasWorkflowSignal(query);

  if (!shouldRewrite) {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      rewriteApplied: false,
      rewriteReason: 'not_broad_mapping_prompt',
      strategy: 'pass_through',
      broadnessScore
    };
  }

  const domain = extractDomain(query);
  const rewrittenQuery = [
    `Find current ${domain} relevant to AI agent workflows.`,
    'Prioritize primary sources and product docs from the last 12 months.',
    'Cluster results into infrastructure, platforms, and enabling tools when applicable.',
    'For each strong result, capture what it is, who it is for, and the main tradeoff that matters for builders.',
    'Prefer concrete builder-relevant differences over generic market-overview commentary.'
  ].join(' ');

  return {
    originalQuery: query,
    rewrittenQuery,
    rewriteApplied: true,
    rewriteReason: 'broad_mapping_prompt_tightened_for_paid_search',
    strategy: 'narrow_to_builder_relevant_comparison_frame',
    broadnessScore
  };
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.endsWith('/query-rewrite.mjs')) {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node query-rewrite.mjs "<query>"');
    process.exit(1);
  }
  console.log(JSON.stringify(rewriteQueryForPaidSearch(query), null, 2));
}
