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

const { PROVIDERS, getProviderConfig, ANTHROPIC_CACHE_CONTROL } = require('./ai-providers');

const DEFAULT_MODEL_KEY = 'claude-sonnet';

// pricing: cents per 1M tokens (from official Anthropic/Google pricing)
// contextWindow: model input limit in tokens (used for dynamic tool result sizing)
// byokOnly models are only available when the user has provided their own API key
const MODEL_DEFS = [
  { key: 'claude-haiku',       provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',              pricing: { input: 100, output: 500 },  contextWindow: 200_000 },
  { key: 'claude-sonnet',      provider: 'anthropic', modelId: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6',             pricing: { input: 300, output: 1500 }, contextWindow: 200_000 },
  { key: 'claude-opus',        provider: 'anthropic', modelId: 'claude-opus-4-8',            label: 'Claude Opus 4.8',               pricing: { input: 500, output: 2500 }, contextWindow: 200_000, byokOnly: true },
  { key: 'gemini-2.5-flash',   provider: 'google',    modelId: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash',              pricing: { input:  30, output: 250 },  contextWindow: 1_048_576 },
  { key: 'gemini-2.5-pro',     provider: 'google',    modelId: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro',                pricing: { input: 125, output: 1000 }, contextWindow: 1_048_576 },
  { key: 'gemini-3-flash',     provider: 'google',    modelId: 'gemini-3-flash-preview',     label: 'Gemini 3 Flash (Preview)',       pricing: { input:  50, output: 300 },  contextWindow: 1_048_576 },
  { key: 'gemini-3.1-pro',     provider: 'google',    modelId: 'gemini-3.1-pro-preview',     label: 'Gemini 3.1 Pro (Preview)',       pricing: { input: 200, output: 1200 }, contextWindow: 1_048_576 },
  { key: 'gemini-3.5-flash',   provider: 'google',    modelId: 'gemini-3.5-flash',           label: 'Gemini 3.5 Flash',              pricing: { input: 150, output: 900 },  contextWindow: 1_048_576 },
  // OpenAI (BYOK only — no server pool key). pricing in cents per 1M tokens,
  // from the official API pricing page (developers.openai.com/api/docs/pricing,
  // June 2026). Reasoning (o-series / *-pro) models are intentionally omitted.
  { key: 'gpt-5.5',            provider: 'openai',    modelId: 'gpt-5.5',                    label: 'GPT-5.5',                       pricing: { input: 500, output: 3000 }, contextWindow: 1_000_000, byokOnly: true },
  { key: 'gpt-5.4',            provider: 'openai',    modelId: 'gpt-5.4',                    label: 'GPT-5.4',                       pricing: { input: 250, output: 1500 }, contextWindow: 1_050_000, byokOnly: true },
  { key: 'gpt-5.4-mini',       provider: 'openai',    modelId: 'gpt-5.4-mini',               label: 'GPT-5.4 mini',                  pricing: { input:  75, output:  450 }, contextWindow:   400_000, byokOnly: true },
];

// Cached default provider clients (server-pool key from env), keyed by provider.
const _providers = {};

function getProvider(providerName) {
  if (!_providers[providerName]) {
    _providers[providerName] = getProviderConfig(providerName).defaultClient();
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

  const provider = getProviderConfig(def.provider).createClient(apiKey);
  const model = provider(def.modelId);
  return { model, def, provider };
}

/**
 * Build the provider-specific `providerOptions` for a streamText call by
 * delegating to the provider registry (e.g. anthropic ephemeral prompt caching,
 * google thinking config). Returns undefined for providers that need no options
 * or that aren't registered. Pure + exported so the provider-gating logic is
 * unit-testable without spinning up a model.
 */
function buildProviderOptions(def) {
  if (!def) return undefined;
  const cfg = PROVIDERS[def.provider];
  return cfg ? cfg.buildProviderOptions(def) : undefined;
}

/**
 * Return a copy of `messages` whose LAST message carries an ephemeral Anthropic
 * cache breakpoint, so the conversation-history prefix is cached (on top of the
 * tools+system prefix cached via buildProviderOptions). Anthropic reads the
 * longest matching cached prefix, so re-tagging the current last message on each
 * call effectively moves the breakpoint forward as the conversation grows.
 *
 * The last message is CLONED (not mutated) so callers can pass an array that is
 * also persisted/streamed elsewhere without leaking providerOptions into it.
 * Returns the input unchanged when empty.
 */
function tagLastMessageWithCache(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const tagged = {
    ...last,
    providerOptions: {
      ...(last.providerOptions || {}),
      anthropic: {
        ...(last.providerOptions?.anthropic || {}),
        cacheControl: ANTHROPIC_CACHE_CONTROL,
      },
    },
  };
  return [...messages.slice(0, -1), tagged];
}

/**
 * Return a copy of UI `messages` with provider-executed tool parts (e.g.
 * Anthropic's server-side `webSearch`) removed from assistant turns.
 *
 * Why: when a provider-executed web search ran in the SAME assistant step as a
 * client tool call, persisting and replaying that turn makes the AI SDK emit an
 * assistant message where the client `tool_use` blocks are no longer the trailing
 * blocks (the inline `web_search_tool_result` sits after them). Anthropic requires
 * each `tool_use` to be immediately resolvable by the next message and rejects the
 * whole request with a 400 (`tool_use ids ... without tool_result blocks`), which
 * the UI surfaces as a dead spinner / "swallowed" message. The assistant's own
 * text already summarized the search, so dropping these blocks from what we SEND
 * costs no real context. Gemini's web search is a normal client tool (not
 * provider-executed), so this is a no-op on that path.
 *
 * The input array and its parts are not mutated; assistant turns left empty by the
 * strip are dropped (the AI SDK requires every message to have at least one part).
 */
function stripProviderExecutedTools(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) {
      out.push(m);
      continue;
    }
    const parts = m.parts.filter(
      (p) => !(typeof p?.type === 'string' && p.type.startsWith('tool-') && p.providerExecuted),
    );
    if (parts.length === m.parts.length) {
      out.push(m);
    } else if (parts.length > 0) {
      out.push({ ...m, parts });
    }
    // else: assistant turn is now empty — drop it
  }
  return out;
}

/**
 * Get the list of available models for the settings UI.
 * @param {Object<string, boolean>} hasKeyByProvider - Map of provider id → whether
 *   the user has a stored key for it (e.g. { anthropic: true, google: false }).
 * @returns {Array} Models with availability info
 */
function getAvailableModels(hasKeyByProvider = {}) {
  return MODEL_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    provider: def.provider,
    modelId: def.modelId,
    byokOnly: !!def.byokOnly,
    available: !def.byokOnly || !!hasKeyByProvider[def.provider],
  }));
}

/**
 * Return a model instance suitable for compaction (fast, cheap summarization).
 * Uses the cached Google provider so it shares the same lazy-load path.
 */
function getCompactionModel() {
  return getProvider('google')('gemini-2.5-flash');
}

/**
 * Resolve the model to use for a chat request, in order of preference:
 *  1. BYOK — when active, the user's selected model + decrypted key. An unknown
 *     or invalid BYOK model key falls through to the server default rather than
 *     throwing (the old inline version dereferenced an undefined def).
 *  2. Server default — AI_CHAT_MODEL (or DEFAULT_MODEL_KEY when unset).
 *  3. DEFAULT_MODEL_KEY as a final fallback if AI_CHAT_MODEL is unknown.
 *
 * @param {object}   opts
 * @param {boolean}  opts.isByok       Whether BYOK is active for this user.
 * @param {object}   [opts.byokSettings] Raw BYOK settings row (may be null).
 * @param {function} opts.decryptKey   Decrypts a stored BYOK key ciphertext.
 * @returns {{ model, def, provider } | null} Resolved model, or null if nothing resolves.
 */
function resolveChatModel({ isByok, byokSettings, decryptKey }) {
  if (isByok && byokSettings) {
    const def = MODEL_DEFS.find((d) => d.key === byokSettings.byok_model_key);
    if (def) {
      const encryptedKey = byokSettings[getProviderConfig(def.provider).keyColumn];
      const resolved = resolveModelWithKey(byokSettings.byok_model_key, decryptKey(encryptedKey));
      if (resolved) return resolved;
    }
  }

  const modelKey = process.env.AI_CHAT_MODEL || DEFAULT_MODEL_KEY;
  const resolved = resolveModel(modelKey);
  if (resolved) return resolved;

  console.error(`[Chat API] Unknown model key "${modelKey}", falling back to "${DEFAULT_MODEL_KEY}"`);
  return resolveModel(DEFAULT_MODEL_KEY);
}

module.exports = { resolveModel, resolveModelWithKey, resolveChatModel, getAvailableModels, getCompactionModel, getProvider, buildProviderOptions, tagLastMessageWithCache, stripProviderExecutedTools, DEFAULT_MODEL_KEY, MODEL_DEFS };
