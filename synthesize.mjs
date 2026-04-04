/**
 * Answer Synthesis for Budget-Aware Research Agent
 *
 * Takes free findings + optional paid findings and produces a coherent
 * synthesized answer using a lightweight LLM call via OpenClaw's model.
 *
 * Falls back to mechanical concatenation if the LLM call fails.
 */

import { spawnSync } from 'node:child_process';

const MAX_CONTEXT_CHARS = 6000;

function buildSourceContext(freeFindings, paidFindings) {
  const sources = [];

  for (const f of (paidFindings || [])) {
    sources.push({
      type: 'paid',
      title: f.source || f.title || 'Untitled',
      url: f.url || '',
      text: f.summary || f.snippet || ''
    });
  }

  for (const f of (freeFindings || [])) {
    sources.push({
      type: 'free',
      title: f.title || f.source || 'Untitled',
      url: f.url || f.link || '',
      text: f.snippet || f.summary || ''
    });
  }

  let context = '';
  for (const s of sources) {
    const block = `[${s.type.toUpperCase()}] ${s.title}\nURL: ${s.url}\n${s.text}\n\n`;
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
  }
  return { context, sourceCount: sources.length };
}

function buildPrompt(query, sourceContext) {
  return `You are a research synthesis engine. Given the user's question and gathered sources, produce a clear, direct answer. Be specific and cite sources by name when relevant. Do not hedge excessively. If the sources are thin, say so honestly.

Question: ${query}

Sources:
${sourceContext}

Write a concise answer (3-8 sentences). No preamble, no "Based on my research" openings. Just answer the question.`;
}

/**
 * Synthesize an answer using gemini-flash-lite for speed and cost.
 * Falls back to mechanical summary if unavailable.
 */
export function synthesizeAnswer(query, freeFindings, paidFindings) {
  const { context, sourceCount } = buildSourceContext(freeFindings, paidFindings);

  if (sourceCount === 0) {
    return {
      answer: 'No sources were found for this query.',
      method: 'no-sources',
      sourceCount: 0
    };
  }

  const prompt = buildPrompt(query, context);

  // Try LLM synthesis via direct API calls. Cheapest first.
  const providers = [];

  // Gemini (cheapest)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    providers.push({
      name: 'gemini-flash-lite',
      script: `
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiKey}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 512, temperature: 0.3 } }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await r.json();
        const t = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!t) throw new Error(JSON.stringify(j?.error?.message || 'empty'));
        process.stdout.write(t);
      `
    });
  }

  // OpenAI (gpt-4o-mini, cheap)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.push({
      name: 'openai-gpt4o-mini',
      script: `
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${openaiKey}' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: PROMPT }], max_tokens: 512, temperature: 0.3 }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await r.json();
        const t = j?.choices?.[0]?.message?.content || '';
        if (!t) throw new Error(JSON.stringify(j?.error?.message || 'empty'));
        process.stdout.write(t);
      `
    });
  }

  for (const provider of providers) {
    try {
      const fullScript = `const PROMPT = ${JSON.stringify(prompt)};\n${provider.script}`;
      const result = spawnSync('node', ['--input-type=module', '-e', fullScript], {
        encoding: 'utf8',
        timeout: 20000,
        shell: false,
        windowsHide: true
      });

      if (result.status === 0 && result.stdout?.trim().length > 20) {
        return {
          answer: result.stdout.trim(),
          method: `llm-${provider.name}`,
          sourceCount
        };
      }
    } catch {
      // try next
    }
  }

  // Fallback: mechanical concatenation
  const findings = [...(paidFindings || []), ...(freeFindings || [])];
  const lines = findings.slice(0, 5).map((f, i) => {
    const title = f.title || f.source || 'Untitled';
    const text = f.snippet || f.summary || '';
    return `${i + 1}. ${title}: ${text}`;
  });

  return {
    answer: lines.join(' '),
    method: 'mechanical-fallback',
    sourceCount
  };
}
