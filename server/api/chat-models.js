/**
 * Chat model registry
 *
 * Maps model keys to AI SDK provider instances. The active model is
 * selected via the AI_CHAT_MODEL environment variable (falls back to
 * DEFAULT_MODEL_KEY).
 *
 * Providers are lazy-loaded on first use so we don't pull in heavy
 * dependencies at startup.
 */

const DEFAULT_MODEL_KEY = 'gemini-3-flash';

// pricing: cents per 1M tokens (from official Anthropic/Google pricing)
const MODEL_DEFS = [
  { key: 'claude-haiku',     provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', pricing: { input: 100, output: 500 } },
  { key: 'gemini-2.5-flash', provider: 'google',    modelId: 'gemini-2.5-flash',          pricing: { input:  30, output: 250 } },
  { key: 'gemini-2.5-pro',   provider: 'google',    modelId: 'gemini-2.5-pro',            pricing: { input: 125, output: 1000 } },
  { key: 'gemini-3-flash',   provider: 'google',    modelId: 'gemini-3-flash-preview',    pricing: { input:  50, output: 300 } },
  { key: 'gemini-3-pro',     provider: 'google',    modelId: 'gemini-3-pro-preview',      pricing: { input: 200, output: 1200 } },
];

// Cached provider factory functions, keyed by provider name
const _providers = {};

function getProvider(providerName) {
  if (!_providers[providerName]) {
    if (providerName === 'anthropic') {
      _providers[providerName] = require('@ai-sdk/anthropic').anthropic;
    } else if (providerName === 'google') {
      _providers[providerName] = require('@ai-sdk/google').google;
    } else {
      throw new Error(`Unknown provider: ${providerName}`);
    }
  }
  return _providers[providerName];
}

/**
 * Resolve a model key to an AI SDK model instance and its definition.
 * Returns { model, def, provider } or null if the key is unknown.
 */
function resolveModel(key) {
  const def = MODEL_DEFS.find((d) => d.key === key);
  if (!def) return null;

  const provider = getProvider(def.provider);
  const model = provider(def.modelId);
  return { model, def, provider };
}

module.exports = { resolveModel, DEFAULT_MODEL_KEY, MODEL_DEFS };
