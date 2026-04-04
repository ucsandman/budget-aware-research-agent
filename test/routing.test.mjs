import { test, describe } from 'node:test';
import assert from 'node:assert';
import { makeDecision } from '../run-prototype.mjs';

// Helper: build a mock freePass result
function mockFreePass(overrides = {}) {
  return {
    freeFindings: [{ source: 'Test', summary: 'test result' }, { source: 'Test2', summary: 'test result 2' }],
    structuredResults: [],
    baselineConfidence: 0.6,
    freshnessScore: 0.6,
    specificityScore: 0.6,
    depthScore: 0.5,
    qualityNotes: [],
    ...overrides,
  };
}

// Helper: build a mock rewrite result (no rewrite applied)
function mockRewrite(overrides = {}) {
  return {
    originalQuery: '',
    rewrittenQuery: '',
    rewriteApplied: false,
    rewriteReason: 'not_broad_mapping_prompt',
    strategy: 'pass_through',
    broadnessScore: 0,
    ...overrides,
  };
}

describe('makeDecision routing logic', () => {
  test('conceptual query with decent free results stays free', () => {
    const request = {
      query: 'What is x402 and how does it work?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'medium',
      depthNeed: 'medium',
      mustBeCurrent: false,
    };
    const freePass = mockFreePass({
      freeFindings: [
        { source: 'Doc 1', summary: 'x402 explained' },
        { source: 'Doc 2', summary: 'x402 protocol details' },
      ],
      specificityScore: 0.6,
    });

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, false, 'Conceptual query should stay free');
    assert.ok(
      decision.reasonCodes.includes('conceptual_answer_sufficient') || decision.reasonCodes.includes('free_answer_sufficient'),
      `Expected conceptual/free reason, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('time-sensitive query escalates to paid', () => {
    const request = {
      query: 'What agent framework releases happened in the last 2 weeks?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'high',
      depthNeed: 'medium',
      mustBeCurrent: true,
    };
    const freePass = mockFreePass({
      freshnessScore: 0.35,
      specificityScore: 0.4,
    });

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, true, 'Time-sensitive query should escalate');
    assert.ok(
      decision.reasonCodes.includes('time_sensitive') || decision.reasonCodes.includes('must_be_current'),
      `Expected time_sensitive reason, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('niche DeFi query escalates to paid', () => {
    const request = {
      query: 'What are the top DEX aggregators on Base chain by volume?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'medium',
      depthNeed: 'medium',
      mustBeCurrent: false,
    };
    const freePass = mockFreePass({
      freeFindings: [{ source: 'Generic article', summary: 'DEX overview' }],
      specificityScore: 0.4,
      depthScore: 0.35,
    });

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, true, 'Niche DeFi query should escalate');
    assert.ok(
      decision.reasonCodes.includes('niche_topic'),
      `Expected niche_topic reason, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('budget too low stays free regardless of query type', () => {
    const request = {
      query: 'Latest Solana TPS in the last 24 hours',
      budgetUsdMax: 0.005,
      freshnessNeed: 'high',
      depthNeed: 'medium',
      mustBeCurrent: true,
    };
    const freePass = mockFreePass({ freshnessScore: 0.2 });

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, false, 'Budget too low should stay free');
    assert.ok(
      decision.reasonCodes.includes('budget_too_low'),
      `Expected budget_too_low reason, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('strategic reasoning query stays free', () => {
    const request = {
      query: 'Is it smarter to build a search API or a data enrichment API as a good first wedge?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'medium',
      depthNeed: 'medium',
      mustBeCurrent: false,
    };
    const freePass = mockFreePass();

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, false, 'Strategic query should stay free');
    assert.ok(
      decision.reasonCodes.includes('strategic_reasoning_better_fit'),
      `Expected strategic_reasoning reason, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('thin free results with niche topic escalates', () => {
    const request = {
      query: 'Who are the main competitors to AgentCash in the agent payments space?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'medium',
      depthNeed: 'medium',
      mustBeCurrent: false,
    };
    const freePass = mockFreePass({
      freeFindings: [],
      specificityScore: 0.3,
      depthScore: 0.3,
    });

    const decision = makeDecision(request, mockRewrite(), freePass);

    assert.strictEqual(decision.shouldEscalatePaid, true, 'Thin results on niche topic should escalate');
    assert.ok(
      decision.reasonCodes.includes('thin_free_results') || decision.reasonCodes.includes('niche_topic'),
      `Expected thin_free_results or niche_topic, got: ${decision.reasonCodes.join(', ')}`
    );
  });

  test('decision returns expected shape', () => {
    const request = {
      query: 'What is x402?',
      budgetUsdMax: 0.25,
      freshnessNeed: 'medium',
      depthNeed: 'medium',
      mustBeCurrent: false,
    };
    const decision = makeDecision(request, mockRewrite(), mockFreePass());

    assert.ok(typeof decision.shouldEscalatePaid === 'boolean');
    assert.ok(Array.isArray(decision.reasonCodes));
    assert.ok(typeof decision.decisionSummary === 'string');
    assert.ok(typeof decision.estimatedValueGain === 'number');
    assert.ok(decision.estimatedValueGain >= 0 && decision.estimatedValueGain <= 1);
  });
});
