# Budget-Aware Research Agent

A research agent that automatically routes between free and paid search based on query characteristics, free result quality, and expected value gain.

## Features

- **Smart routing** — Analyzes query type, freshness needs, topic niche-ness, and free result quality to decide whether paid search is worth it
- **Dynamic provider discovery** — Queries [402 Index](https://402index.io) at runtime to find the cheapest healthy x402 provider for each query category
- **LLM synthesis** — Uses gpt-4o-mini (or Gemini Flash when quota allows) to synthesize sources into coherent answers
- **Budget controls** — Dry-run by default, configurable max spend per query
- **Caching** — Free search results cached for 6h to avoid redundant calls
- **Eval framework** — Built-in eval runner with routing accuracy metrics

## Quick Start

**Ask a question:**
```bash
research "What is x402?"
research --live "Solana TPS in the last 24 hours"
research --live --current "Latest agent framework releases"
research --live --budget 0.10 "DeFi protocols on Base by TVL"
```

**View insights:**
```bash
research-dashboard     # Open cost dashboard (HTML)
research-costs         # Cost summary & breakdown
research-history defi  # Find past DeFi-related queries
research-retry list    # See failed queries and retry strategies
```

**Raw/advanced usage:**
```bash
node research/budget-aware-research-agent/research.mjs --json "What is x402?"
node research/budget-aware-research-agent/research.mjs --answer --no-log "Question"
```

All commands assume `C:\Users\sandm\clawd\bin` is in PATH (it is).

## How Routing Works

The agent classifies queries and evaluates whether paid search would add enough value to justify the cost.

### Query Classification

- **Conceptual** — "What is X?" questions with good free documentation
- **Time-sensitive** — Recent events, current data, "last N days/weeks"
- **Niche** — DeFi, specific chains, market research, obscure tools
- **Strategic** — Opinion/reasoning questions better served by LLM than search

### Escalation Logic

Paid search triggers when:
- Query is flagged `--current` or mentions recent time frames
- Free results are stale (freshness score < 0.5)
- Topic is niche and free results are generic
- Free search returned ≤1 result
- Estimated value gain ≥ 0.30 threshold

Stays free when:
- Budget < $0.01
- Query is conceptual and has 2+ decent free results
- Query asks for strategic reasoning (better for LLM)
- Scope is too vague for paid to help

### Provider Selection

The agent queries **402 Index** at runtime to discover x402 providers by category:
- Search → web research (Exa, Perplexity, etc.)
- DeFi → blockchain data providers
- Social → Twitter/X search APIs

Picks the **cheapest healthy provider** that fits budget. Falls back to `stableenrich.dev/api/exa/search` if 402 Index is unavailable.

## Operations & Monitoring

### Cost Tracking
```bash
# View summary
research-costs summary

# View recent queries (tail N)
research-costs tail 10

# Reset ledger (if needed)
research-costs reset
```

### Query History
```bash
# Search by query content
research-history "defi" --mode query

# Search by provider
research-history "exa" --mode provider

# Search anything (queries + providers)
research-history "base" --mode all
```

### Failure Recovery
```bash
# List failed queries
research-retry list

# Get retry strategies for a specific failure
research-retry suggest 1
```

### Visual Dashboard
```bash
research-dashboard  # Generates dashboard.html with charts/tables
```

Then open `research/budget-aware-research-agent/dashboard.html` in your browser.

## Eval Framework

Run the eval suite to test routing accuracy:

```bash
# Dry run (default)
node research/budget-aware-research-agent/eval/run-eval.mjs

# Run specific queries
node research/budget-aware-research-agent/eval/run-eval.mjs --ids conceptual_01,current_01

# Live paid execution (will spend real USDC)
node research/budget-aware-research-agent/eval/run-eval.mjs --live
```

Eval queries are in `eval/eval-queries.json`. Results saved to `eval/results/`.

**Current accuracy:** 78% (7/9 correct routing decisions in dry-run eval)

## Architecture

```
research.mjs                   # CLI wrapper
└─> run-prototype.mjs          # Main orchestration
    ├─> provider-discovery.mjs # Query 402 Index for paid providers
    ├─> free-research.mjs      # Brave API + DuckDuckGo fallback
    ├─> query-rewrite.mjs      # Sharpen vague queries for paid search
    ├─> synthesize.mjs         # LLM answer synthesis
    └─> tmp/run-agentcash-fetch.mjs  # x402 payment + fetch
```

## Configuration

Set environment variables:

- `BRAVE_API_KEY` — Unlock Brave Search (much better than DDG scraping)
- `GEMINI_API_KEY` — Preferred for synthesis (cheapest)
- `OPENAI_API_KEY` — Fallback for synthesis
- AgentCash wallet must be funded (onboard via `npx agentcash@latest onboard <code>`)

## Cost Profile

**Free path:** $0 (Brave/DDG + local LLM synthesis)

**Paid path (dry run):** $0

**Paid path (live):**
- x402 search: ~$0.005 per query (Exa via StableEnrich)
- LLM synthesis: ~$0.0003 (gpt-4o-mini)
- **Total:** ~$0.0053 per paid query (verified via cost tracker)

Default budget: $0.25/query (configurable via `--budget`)

**Full tool suite:**
```bash
# Cost analytics (CLI)
research-costs summary
research-costs tail 20

# Visual dashboard (HTML)
research-dashboard          # opens dashboard.html

# Search history
research-history "x402"
research-history "defi" --mode answer

# Retry failed queries
research-retry list
research-retry suggest 1

# Reset ledger
research-costs reset
```

All queries logged to:
- `logs/cost-ledger.jsonl` — cost tracking
- `logs/runs.jsonl` — full query/answer/routing logs
- `dashboard.html` — visual analytics (auto-generated)

## Known Issues

- **DuckDuckGo timeout on specific queries** — Some queries cause DuckDuckGo to hang indefinitely (likely bot detection). The free research path has a 25s timeout with fallback, but Node's event loop may keep the process alive due to dangling fetch handles. **Fix:** Set `BRAVE_API_KEY` to bypass DuckDuckGo entirely.
- Gemini free tier quota exhausted → using OpenAI gpt-4o-mini for synthesis (fallback works fine)
- Routing accuracy is 78% (7/9 correct) — some edge cases where niche detection conflicts with conceptual exemptions

## What's Included

✅ Smart free/paid routing with 78% accuracy
✅ Dynamic provider discovery via 402 Index
✅ Cost tracking & JSONL ledger
✅ Query history search
✅ Failure detection & retry suggestions
✅ HTML cost dashboard with daily charts
✅ LLM answer synthesis (gpt-4o-mini, Gemini fallback)
✅ Global CLI commands (`research`, `research-costs`, etc.)
✅ Eval framework with 10-query test suite

## Batch Mode

Run multiple queries from a file:

```bash
# Create a query file (one per line, # for comments)
echo "What is EigenLayer?" > queries.txt
echo "What are rollups?" >> queries.txt

# Run batch
research-batch --file queries.txt
research-batch --file queries.txt --live --budget 0.05
research-batch --file queries.txt --output results.md

# Or inline
research-batch "question 1" "question 2" "question 3"
```

## Compare Mode

Side-by-side free vs paid results for the same query:

```bash
research-compare "What DeFi protocols on Base have the highest TVL?"
```

Shows both answer paths with latency, confidence delta, and cost.

## Roadmap

- [ ] Add `BRAVE_API_KEY` to eliminate DuckDuckGo timeout edge case
- [ ] Multi-provider aggregation (query multiple paid sources in parallel)
- [ ] Streaming output mode for long synthesis
- [ ] Budget guardrails & spend alerts

## Example Outputs

### Conceptual (free path)

```
Q: What is x402?
## Answer
x402 is an open standard for internet-native payments designed to facilitate
seamless micropayments for both humans and AI agents...

## Sources
- What is x402? | Ledger
- x402 - Payment Required | Internet-Native Payments Standard

---
Free path | conceptual_answer_sufficient | Confidence: 88% | Synthesis: llm-openai-gpt4o-mini
```

### Time-sensitive (paid path)

```
Q: What new agent framework releases happened in the last 2 weeks?
## Answer
In the last two weeks, there have been no new releases or major updates to the
Microsoft Agent Framework. The latest release was noted on October 3, 2025...

## Sources
- Releases · microsoft/agent-framework · GitHub
- Microsoft Releases 'Microsoft Agent Framework' - MarkTechPost [paid]

---
Provider: Exa (via 402 Index) | $0.005 | Confidence: 80% | Synthesis: llm-openai-gpt4o-mini
```

---

Built 2026-04-03 by MoltFire 🔥
