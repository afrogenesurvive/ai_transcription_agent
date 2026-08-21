/**
 * estimateCost — provider-aware per-1M-token cost estimation (USD).
 *
 * Used by agent-runner/index.js when writing the per-job usage.json `costs`
 * block. DeepSeek uses a flat rate (input $0.25 / output $1.00 per 1M tokens);
 * OpenAI and Anthropic use model-matched tables (falling back to a sensible
 * default rate per provider when the model isn't in the table). Ollama/local
 * and unknown providers return $0 (estimated: false).
 *
 * Rates are approximate public list prices (USD / 1M tokens) and are for
 * reference/telemetry only — DS-mon is the authoritative cost aggregator.
 */

const PRICING = {
  deepseek: { input: 0.25, output: 1.0 },
  openai: {
    models: {
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
      "gpt-4o": { input: 2.5, output: 10.0 },
      "gpt-4.1": { input: 2.0, output: 8.0 },
      "gpt-4": { input: 30.0, output: 60.0 },
      "o1": { input: 15.0, output: 60.0 },
      "o3": { input: 2.0, output: 8.0 },
      "o4": { input: 1.1, output: 4.4 },
    },
    // Fallback for unknown OpenAI models (gpt-4o-class pricing).
    default: { input: 2.5, output: 10.0 },
  },
  anthropic: {
    models: {
      "claude-3-5-haiku": { input: 0.8, output: 4.0 },
      "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
      "claude-3-7-sonnet": { input: 3.0, output: 15.0 },
      "claude-sonnet-4": { input: 3.0, output: 15.0 },
      "claude-opus-4": { input: 15.0, output: 75.0 },
      "claude-opus": { input: 15.0, output: 75.0 },
      "claude-haiku": { input: 1.0, output: 5.0 },
      "claude-sonnet": { input: 3.0, output: 15.0 },
    },
    // Fallback for unknown Anthropic models (sonnet-class pricing).
    default: { input: 3.0, output: 15.0 },
  },
};

/**
 * Estimate per-job cost for a provider/model.
 *
 * @param {string} provider - "deepseek" | "openai" | "anthropic" | "ollama"
 * @param {string} model - model name from the LLM call
 * @param {number} promptTokens - total prompt (input) tokens
 * @param {number} completionTokens - total completion (output) tokens
 * @returns {{ inputCost: number, outputCost: number, totalCost: number, estimated: boolean }}
 */
export function estimateCost(provider, model, promptTokens, completionTokens) {
  const key = (provider || "").toLowerCase();
  const p = PRICING[key];
  if (!p) {
    // Unknown / local (ollama) providers — no cost to track.
    return { inputCost: 0, outputCost: 0, totalCost: 0, estimated: false };
  }

  let rates = p;
  if (p.models) {
    const m = (model || "").toLowerCase();
    const matched = Object.keys(p.models).find((k) => m.includes(k));
    rates = matched ? p.models[matched] : p.default;
  }

  const inputCost = ((promptTokens || 0) / 1_000_000) * rates.input;
  const outputCost = ((completionTokens || 0) / 1_000_000) * rates.output;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    estimated: true,
  };
}
