import { readFileSync } from 'node:fs';

const REGISTRY_PATH = 'C:/Users/sandm/clawd/research/budget-aware-research-agent/free-provider-registry.json';

export function loadFreeProviderRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

export function suggestFreeProviders(query) {
  const registry = loadFreeProviderRegistry();
  const lower = query.toLowerCase();
  const matchedIds = new Set();
  const matchedIntents = [];

  for (const rule of registry.routing.intentRules) {
    if (rule.patterns.some((pattern) => lower.includes(pattern.toLowerCase()))) {
      matchedIntents.push(rule.intent);
      for (const id of rule.providerIds) matchedIds.add(id);
    }
  }

  const suggestedProviders = registry.providers
    .filter((provider) => matchedIds.has(provider.id))
    .sort((a, b) => b.fitScore - a.fitScore);

  return {
    matchedIntents,
    suggestedProviders,
    fallbackPolicy: registry.routing.fallbackPolicy
  };
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/').toLowerCase() ?? '';
if (invokedPath.endsWith('/research/budget-aware-research-agent/free-provider-registry.mjs')) {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node research/budget-aware-research-agent/free-provider-registry.mjs "<query>"');
    process.exit(1);
  }
  console.log(JSON.stringify(suggestFreeProviders(query), null, 2));
}
