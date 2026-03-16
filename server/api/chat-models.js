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
// contextWindow: model input limit in tokens (used for dynamic tool result sizing)
// byokOnly models are only available when the user has provided their own API key
const MODEL_DEFS = [
  { key: 'claude-haiku',       provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',              pricing: { input: 100, output: 500 },  contextWindow: 200_000 },
  { key: 'claude-sonnet',      provider: 'anthropic', modelId: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6',             pricing: { input: 300, output: 1500 }, contextWindow: 200_000, byokOnly: true },
  { key: 'claude-opus',        provider: 'anthropic', modelId: 'claude-opus-4-6',            label: 'Claude Opus 4.6',               pricing: { input: 1500, output: 7500 }, contextWindow: 200_000, byokOnly: true },
  { key: 'gemini-2.5-flash',   provider: 'google',    modelId: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash',              pricing: { input:  30, output: 250 },  contextWindow: 1_048_576 },
  { key: 'gemini-2.5-pro',     provider: 'google',    modelId: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro',                pricing: { input: 125, output: 1000 }, contextWindow: 1_048_576 },
  { key: 'gemini-3-flash',     provider: 'google',    modelId: 'gemini-3-flash-preview',     label: 'Gemini 3 Flash (Preview)',       pricing: { input:  50, output: 300 },  contextWindow: 1_048_576 },
  { key: 'gemini-3.1-pro',     provider: 'google',    modelId: 'gemini-3.1-pro-preview',     label: 'Gemini 3.1 Pro (Preview)',       pricing: { input: 200, output: 1200 }, contextWindow: 1_048_576 },
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

/**
 * Resolve a model key using a user-provided API key (BYOK).
 * Creates a fresh provider instance with the given key.
 * Returns { model, def, provider } or null if the key is unknown.
 */
function resolveModelWithKey(key, apiKey) {
  const def = MODEL_DEFS.find((d) => d.key === key);
  if (!def) return null;

  let provider;
  if (def.provider === 'anthropic') {
    provider = require('@ai-sdk/anthropic').createAnthropic({ apiKey });
  } else if (def.provider === 'google') {
    provider = require('@ai-sdk/google').createGoogleGenerativeAI({ apiKey });
  } else {
    throw new Error(`Unknown provider: ${def.provider}`);
  }

  const model = provider(def.modelId);
  return { model, def, provider };
}

/**
 * Get the list of available models for the settings UI.
 * @param {boolean} hasAnthropicKey - Whether the user has an Anthropic API key
 * @param {boolean} hasGoogleKey - Whether the user has a Google API key
 * @returns {Array} Models with availability info
 */
function getAvailableModels(hasAnthropicKey, hasGoogleKey) {
  return MODEL_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    provider: def.provider,
    modelId: def.modelId,
    byokOnly: !!def.byokOnly,
    available: !def.byokOnly ||
      (def.provider === 'anthropic' && hasAnthropicKey) ||
      (def.provider === 'google' && hasGoogleKey),
  }));
}

/**
 * Return a model instance suitable for compaction (fast, cheap summarization).
 * Uses the cached Google provider so it shares the same lazy-load path.
 */
function getCompactionModel() {
  return getProvider('google')('gemini-2.5-flash');
}

module.exports = { resolveModel, resolveModelWithKey, getAvailableModels, getCompactionModel, getProvider, DEFAULT_MODEL_KEY, MODEL_DEFS };
