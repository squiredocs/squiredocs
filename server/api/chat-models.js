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

const DEFAULT_MODEL_KEY = 'claude-opus';

// pricing: cents per 1M tokens (from official Anthropic/Google pricing)
// contextWindow: model input limit in tokens (used for dynamic tool result sizing)
const MODEL_DEFS = [
  { key: 'claude-haiku',       provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',              pricing: { input: 100, output: 500 },  contextWindow: 200_000 },
  { key: 'claude-sonnet',      provider: 'anthropic', modelId: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6',             pricing: { input: 300, output: 1500 }, contextWindow: 200_000 },
  // Sonnet 5 has an introductory discount ($2/$10 per 1M through 2026-08-31); we
  // record standard $3/$15 list pricing so metering stays correct after it lapses.
  { key: 'claude-sonnet-5',    provider: 'anthropic', modelId: 'claude-sonnet-5',           label: 'Claude Sonnet 5',               pricing: { input: 300, output: 1500 }, contextWindow: 200_000 },
  { key: 'claude-opus',        provider: 'anthropic', modelId: 'claude-opus-4-8',            label: 'Claude Opus 4.8',               pricing: { input: 500, output: 2500 }, contextWindow: 200_000 },
  { key: 'gemini-2.5-flash',   provider: 'google',    modelId: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash',              pricing: { input:  30, output: 250 },  contextWindow: 1_048_576 },
  { key: 'gemini-2.5-pro',     provider: 'google',    modelId: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro',                pricing: { input: 125, output: 1000 }, contextWindow: 1_048_576 },
  { key: 'gemini-3-flash',     provider: 'google',    modelId: 'gemini-3-flash-preview',     label: 'Gemini 3 Flash (Preview)',       pricing: { input:  50, output: 300 },  contextWindow: 1_048_576 },
  { key: 'gemini-3.1-pro',     provider: 'google',    modelId: 'gemini-3.1-pro-preview',     label: 'Gemini 3.1 Pro (Preview)',       pricing: { input: 200, output: 1200 }, contextWindow: 1_048_576 },
  { key: 'gemini-3.5-flash',   provider: 'google',    modelId: 'gemini-3.5-flash',           label: 'Gemini 3.5 Flash',              pricing: { input: 150, output: 900 },  contextWindow: 1_048_576 },
  // OpenAI models. There is no shared server OpenAI key, so these only run when
  // a user supplies their own (selectable in Settings once an OpenAI key is
  // stored; isByokActive enforces the key at request time). pricing in cents per
  // 1M tokens, from the official API pricing page
  // (developers.openai.com/api/docs/pricing, June 2026). Reasoning (o-series /
  // *-pro) models are intentionally omitted.
  { key: 'gpt-5.5',            provider: 'openai',    modelId: 'gpt-5.5',                    label: 'GPT-5.5',                       pricing: { input: 500, output: 3000 }, contextWindow: 1_000_000 },
  { key: 'gpt-5.4',            provider: 'openai',    modelId: 'gpt-5.4',                    label: 'GPT-5.4',                       pricing: { input: 250, output: 1500 }, contextWindow: 1_050_000 },
  { key: 'gpt-5.4-mini',       provider: 'openai',    modelId: 'gpt-5.4-mini',               label: 'GPT-5.4 mini',                  pricing: { input:  75, output:  450 }, contextWindow:   400_000 },
  // z.ai (Zhipu) GLM models. Like OpenAI, there is no shared server z.ai key, so
  // these only run via BYOK (selectable in Settings once a z.ai key is stored;
  // isByokActive enforces the key at request time). z.ai speaks the OpenAI wire
  // format but only the chat-completions API, not the Responses API — see the
  // provider's createModel hook in ai-providers.js. pricing in cents per 1M
  // tokens, from z.ai's published API pricing (July 2026).
  { key: 'glm-4.6',            provider: 'zai',       modelId: 'glm-4.6',                    label: 'GLM-4.6',                       pricing: { input:  60, output:  220 }, contextWindow:   200_000 },
  { key: 'glm-4.7',            provider: 'zai',       modelId: 'glm-4.7',                    label: 'GLM-4.7',                       pricing: { input:  60, output:  220 }, contextWindow:   200_000 },
  { key: 'glm-5',              provider: 'zai',       modelId: 'glm-5',                      label: 'GLM-5',                         pricing: { input: 100, output:  320 }, contextWindow:   200_000 },
  { key: 'glm-5.2',            provider: 'zai',       modelId: 'glm-5.2',                    label: 'GLM-5.2',                       pricing: { input: 140, output:  440 }, contextWindow: 1_000_000 },
  // OpenRouter — an OpenAI-compatible gateway, BYOK-only. Model ids are namespaced
  // (`z-ai/glm-*`); like z.ai it only implements chat-completions, so the provider's
  // createModel hook forces the chat model. These reach the same GLM models as the
  // direct `zai` provider but bill through the user's OpenRouter account, so they're
  // separate model keys the user selects by which key they hold. pricing in cents per
  // 1M tokens and context windows are read straight from OpenRouter's models API
  // (openrouter.ai/api/v1/models, July 2026).
  { key: 'or-glm-4.6',         provider: 'openrouter', modelId: 'z-ai/glm-4.6',              label: 'GLM-4.6',                       pricing: { input:  43, output:  174 }, contextWindow:   202_752 },
  { key: 'or-glm-4.7',         provider: 'openrouter', modelId: 'z-ai/glm-4.7',              label: 'GLM-4.7',                       pricing: { input:  40, output:  175 }, contextWindow:   202_752 },
  { key: 'or-glm-5',           provider: 'openrouter', modelId: 'z-ai/glm-5',                label: 'GLM-5',                         pricing: { input:  60, output:  192 }, contextWindow:   202_752 },
  { key: 'or-glm-5.2',         provider: 'openrouter', modelId: 'z-ai/glm-5.2',              label: 'GLM-5.2',                       pricing: { input:  93, output:  300 }, contextWindow: 1_048_576 },
];

// Vision support. Anthropic/Google/OpenAI models all accept image input; the
// GLM text models (z.ai + OpenRouter) do NOT — sending an image makes the
// provider reject the whole request (z.ai/OpenRouter: 404 "No endpoints found
// that support image input"). We gate image attachments on this both in the UI
// (via getAvailableModels) and server-side (a pre-flight in chat.js) so a
// text-only model fails honestly instead of as a generic "crash". A `def` may
// set `supportsImages` explicitly to override (e.g. a future GLM-V); otherwise
// it's derived from the provider.
const VISION_PROVIDERS = new Set(['anthropic', 'google', 'openai']);
for (const def of MODEL_DEFS) {
  if (def.supportsImages === undefined) {
    def.supportsImages = VISION_PROVIDERS.has(def.provider);
  }
}

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
  const model = instantiateModel(def.provider, provider, def.modelId);
  return { model, def, provider };
}

/**
 * Build an AI SDK model instance from a provider factory + model id, honoring the
 * provider's optional `createModel` hook. Most providers use the callable
 * shorthand `provider(modelId)`; z.ai overrides this to force the
 * chat-completions API (see ai-providers.js), since its OpenAI-compatible
 * endpoint doesn't implement the Responses API the shorthand targets.
 */
function instantiateModel(providerName, provider, modelId) {
  const cfg = getProviderConfig(providerName);
  return cfg.createModel ? cfg.createModel(provider, modelId) : provider(modelId);
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
  const model = instantiateModel(def.provider, provider, def.modelId);
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
 * Return a copy of UI `messages` with `reasoning` parts removed from assistant
 * turns. Used for providers whose SDK echoes prior reasoning back into the request
 * (see stripReasoningFromHistory): @ai-sdk/openai-compatible serializes assistant
 * reasoning parts as `reasoning_content`, so replaying history would feed GLM its
 * own earlier chain-of-thought — unnecessary context that some reasoning APIs also
 * reject. The reasoning is still streamed live to the UI and persisted; we only
 * drop it from what we SEND on subsequent turns. The final answer text carries the
 * conclusions forward, so nothing meaningful is lost.
 *
 * The input array and its parts are not mutated; assistant turns left empty by the
 * strip (reasoning-only turns) are dropped, matching stripProviderExecutedTools.
 */
function stripReasoningParts(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) {
      out.push(m);
      continue;
    }
    const parts = m.parts.filter((p) => p?.type !== 'reasoning');
    if (parts.length === m.parts.length) {
      out.push(m);
    } else if (parts.length > 0) {
      out.push({ ...m, parts });
    }
    // else: assistant turn was reasoning-only — drop it
  }
  return out;
}

/**
 * Get the list of models for the settings UI. The client groups these by
 * provider and gates selection on whether the user has stored that provider's
 * key (see SettingsPage); request-time enforcement lives in isByokActive.
 * @returns {Array} Models with key, label, provider, modelId.
 */
function getAvailableModels() {
  return MODEL_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    provider: def.provider,
    modelId: def.modelId,
    supportsImages: def.supportsImages,
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
 * Model for search-chunk contextual preambles (feature 018, plan D6): an
 * inexpensive large-context model for batched "situate this chunk in its
 * document" generation. Same lazy provider path as compaction.
 */
function getContextualizerModel() {
  return getProvider('google')('gemini-2.5-flash');
}

/**
 * Model for live summaries of an in-progress "thinking" block (the chat UI
 * polls for these while a model reasons). Claude Haiku — fast and cheap, and
 * called without thinking config so it answers immediately.
 */
function getThinkingSummaryModel() {
  return getProvider('anthropic')('claude-haiku-4-5-20251001');
}

/**
 * Resolve the shared-assistant default model KEY (not a model instance), in
 * order of preference:
 *  1. The admin-selected default stored in app_settings (passed in by the caller).
 *  2. The AI_CHAT_MODEL env var (per-deployment override).
 *  3. DEFAULT_MODEL_KEY code constant.
 * @param {string} [storedKey] The admin-selected key from app_settings (may be null).
 * @returns {string} The resolved model key.
 */
function resolveSharedDefaultKey(storedKey) {
  return storedKey || process.env.AI_CHAT_MODEL || DEFAULT_MODEL_KEY;
}

/**
 * Resolve the model to use for a chat request, in order of preference:
 *  1. BYOK — when enabled, the user's selected model + decrypted key. If BYOK is
 *     enabled but the model/key cannot be resolved, this returns a discriminated
 *     `{ error: 'byok_misconfigured', provider? }` signal — it does NOT silently
 *     fall back to the shared server key (feature 012, FR-019). A silent fallback
 *     would bill the operator's key while the request is still flagged BYOK,
 *     bypassing credit metering.
 *  2. Shared default (non-BYOK only) — the admin-selected model (sharedDefaultKey),
 *     else AI_CHAT_MODEL, else DEFAULT_MODEL_KEY (see resolveSharedDefaultKey).
 *  3. DEFAULT_MODEL_KEY as a final fallback if the resolved shared key is unknown.
 *
 * @param {object}   opts
 * @param {boolean}  opts.isByok       Whether BYOK is enabled/intended for this user.
 * @param {object}   [opts.byokSettings] Raw BYOK settings row (may be null).
 * @param {function} opts.decryptKey   Decrypts a stored BYOK key ciphertext.
 * @param {string}   [opts.sharedDefaultKey] Admin-selected shared default model key.
 * @returns {{ model, def, provider } | { error: 'byok_misconfigured', provider: string|null } | null}
 *   Resolved model; the misconfig signal when BYOK is on but unresolvable; or null
 *   if no shared model is configured at all (genuine server misconfiguration).
 */
function resolveChatModel({ isByok, byokSettings, decryptKey, sharedDefaultKey }) {
  if (isByok && byokSettings) {
    const def = MODEL_DEFS.find((d) => d.key === byokSettings.byok_model_key);
    if (def) {
      const encryptedKey = byokSettings[getProviderConfig(def.provider).keyColumn];
      if (encryptedKey) {
        try {
          const resolved = resolveModelWithKey(byokSettings.byok_model_key, decryptKey(encryptedKey));
          if (resolved) return resolved;
        } catch (e) {
          // decryption or model instantiation failed → misconfigured (below).
          console.error('[Chat API] BYOK key/model failed to resolve:', e.message);
        }
      }
    }
    // BYOK is on but unresolvable (unknown model, missing/undecryptable key):
    // reject loudly, never fall back to the shared key. Carry the provider when
    // we know it so the client can name it.
    return { error: 'byok_misconfigured', provider: def ? def.provider : null };
  }

  const modelKey = resolveSharedDefaultKey(sharedDefaultKey);
  const resolved = resolveModel(modelKey);
  if (resolved) return resolved;

  console.error(`[Chat API] Unknown model key "${modelKey}", falling back to "${DEFAULT_MODEL_KEY}"`);
  return resolveModel(DEFAULT_MODEL_KEY);
}

module.exports = { resolveModel, resolveModelWithKey, resolveChatModel, resolveSharedDefaultKey, getAvailableModels, getCompactionModel, getContextualizerModel, getThinkingSummaryModel, getProvider, buildProviderOptions, tagLastMessageWithCache, stripProviderExecutedTools, stripReasoningParts, DEFAULT_MODEL_KEY, MODEL_DEFS };
