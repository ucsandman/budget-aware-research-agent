# Budget-Aware Research Agent

A zero-dependency Node.js research agent that routes queries between free and paid (x402) search sources. It analyzes query type, freshness needs, topic niche-ness, and free result quality to decide whether paying for search is worth the cost.

## Quick Start

```bash
git clone https://github.com/ucsandman/budget-aware-research-agent.git
cd budget-aware-research-agent
cp .env.example .env
# Edit .env with your API keys (at minimum, set BRAVE_API_KEY or OPENAI_API_KEY)

# Ask a question (dry run — no payments)
node research.mjs "What is x402?"

# Enable paid search (requires AgentCash wallet)
node research.mjs --live "Solana TPS in the last 24 hours"

# Set a budget cap
node research.mjs --live --budget 0.10 "DeFi protocols on Base by TVL"

# Flag as needing fresh data
node research.mjs --live --current "Latest agent framework releases"

# Run tests
npm test
```

## Architecture

```
                        ┌─────────────┐
                        │  research   │  CLI wrapper
                        │   .mjs      │
                        └──────┬──────┘
                               │
                    ┌──────────▼──────────┐
                    │  run-prototype.mjs   │  Main orchestrator
                    └──┬───┬───┬───┬───┬──┘
                       │   │   │   │   │
          ┌────────────┘   │   │   │   └────────────┐
          ▼                ▼   │   ▼                ▼
  ┌───────────────┐  ┌────────┐│┌──────────┐  ┌──────────┐
  │free-research  │  │query-  │││synthesize│  │  cost-   │
  │   .mjs        │  │rewrite │││  .mjs    │  │ tracker  │
  │               │  │ .mjs   │││          │  │  .mjs    │
  │ Brave API     │  └────────┘│└──────────┘  └──────────┘
  │ DuckDuckGo    │            │  LLM synth
  │ Crossref      │   ┌───────▼────────┐
  │ DefiLlama     │   │provider-       │
  └───────────────┘   │discovery.mjs   │
                      │                │
                      │ 402 Index API  │
                      │ x402 payments  │
                      └────────────────┘
```

### How Routing Works

1. **Free pass** — Searches Brave (or DuckDuckGo fallback), enriches top results, scores quality
2. **Decision** — Evaluates query shape (conceptual? time-sensitive? niche?) against free result quality
3. **Escalate or stay** — If estimated value gain >= 0.30 threshold, routes to paid x402 provider
4. **Synthesize** — LLM combines all sources into a coherent answer

**Stays free when:**
- Query is conceptual ("What is X?") with 2+ decent free results
- Query asks for strategic reasoning (better served by LLM than search)
- Budget < $0.01
- Scope is too vague for paid to help

**Escalates to paid when:**
- Query needs fresh data (--current, "last N days")
- Topic is niche (DeFi, specific chains, market research)
- Free search returned thin or stale results
- Estimated value gain exceeds threshold

### Provider Discovery

The agent queries [402 Index](https://402index.io) at runtime to find the cheapest healthy x402 provider for each query category (search, enrichment, social, etc.). Falls back to a default provider if the index is unavailable.

## Configuration

Set in `.env`:

| Variable | Required | Description |
|---|---|---|
| `BRAVE_API_KEY` | Recommended | Brave Search API key (much better than DDG scraping) |
| `OPENAI_API_KEY` | One of these | OpenAI key for gpt-4o-mini synthesis |
| `GEMINI_API_KEY` | One of these | Google Gemini key (cheapest synthesis option) |
| `AGNTLY_API_KEY` | Optional | Agntly marketplace integration |
| `AGNTLY_BASE_URL` | Optional | Agntly API base URL |

At minimum, set `BRAVE_API_KEY` and one LLM key (`OPENAI_API_KEY` or `GEMINI_API_KEY`).

For paid search, you'll also need an [AgentCash](https://agentcash.dev) wallet (`npx agentcash@latest onboard`).

## CLI Reference

### Main Commands

```bash
node research.mjs [options] "your question"
```

| Flag | Description |
|---|---|
| `--live` | Enable paid search (default: dry run) |
| `--budget <USD>` | Max spend per query (default: 0.25) |
| `--current` | Flag query as needing fresh results |
| `--deep` | Flag query as needing depth |
| `--json` | Output full JSON instead of answer |
| `--no-log` | Don't write to run log |

### Tools

```bash
node cost-tracker.mjs summary          # Cost breakdown
node cost-tracker.mjs tail 10          # Recent queries
node history-search.mjs "defi"         # Search past queries
node retry-handler.mjs list            # Failed queries
node batch.mjs --file queries.txt      # Batch mode
node compare.mjs "your question"       # Free vs paid side-by-side
node dashboard.mjs                     # Generate HTML dashboard
```

### Agntly Marketplace Server

```bash
node server/agntly-server.mjs          # Full server (uses subprocess)
node server/agntly-server-simple.mjs   # Mock server (for testing)
node server/agntly-setup.mjs register  # Register on marketplace
```

## Cost Profile

| Path | Cost |
|---|---|
| Free (Brave/DDG + LLM synthesis) | $0 |
| Paid dry run | $0 |
| Paid live (x402 search + LLM) | ~$0.005/query |

Default budget: $0.25/query. Actual spend is typically much lower.

## Eval Framework

```bash
node eval/run-eval.mjs                 # Dry run eval (10 queries)
node eval/run-eval.mjs --live          # Live eval (spends real USDC)
node eval/run-eval.mjs --ids conceptual_01,current_01  # Subset
```

Current routing accuracy: 78% (7/9 correct routing decisions).

## Project Structure

```
├── research.mjs                 # CLI entry point
├── run-prototype.mjs            # Main orchestrator + routing logic
├── free-research.mjs            # Free search (Brave, DuckDuckGo)
├── structured-free-providers.mjs # Crossref, DefiLlama integration
├── free-provider-registry.mjs   # Intent-based provider matching
├── provider-discovery.mjs       # 402 Index provider discovery
├── query-rewrite.mjs            # Query sharpening for paid search
├── synthesize.mjs               # LLM answer synthesis
├── cost-tracker.mjs             # JSONL cost ledger
├── batch.mjs                    # Batch query runner
├── compare.mjs                  # Free vs paid comparison
├── dashboard.mjs                # HTML dashboard generator
├── history-search.mjs           # Query history search
├── retry-handler.mjs            # Failure detection + retry
├── lib/
│   └── agentcash-fetch.mjs      # x402 payment wrapper
├── server/
│   ├── agntly-server.mjs        # Agntly marketplace HTTP server
│   ├── agntly-server-simple.mjs # Mock server for testing
│   └── agntly-setup.mjs         # Marketplace registration
├── eval/
│   ├── run-eval.mjs             # Eval runner
│   └── eval-queries.json        # Test query suite
├── fixtures/                    # Benchmark data
└── test/
    └── routing.test.mjs         # Routing decision tests
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Run tests (`npm test`)
4. Commit with a descriptive message
5. Open a PR

Keep it zero-dependency (Node built-ins only). Match existing code style.

## License

MIT — see [LICENSE](LICENSE).

## Support

If my tools save you time, you can support my work here:

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub%20Sponsors-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ucsandman)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/wes_sander)
