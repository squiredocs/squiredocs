/**
 * AI provider registry — the single source of truth for per-provider BYOK and
 * model-dispatch behavior.
 *
 * Each provider's quirks (which DB column stores its key, how to validate a key,
 * which AI SDK factory to use, what `providerOptions` to send, how to build its
 * web-search tool, and which streaming capabilities it has) used to live as
 * hardcoded `if (provider === 'anthropic') … else if (provider === 'google')`
 * branches scattered across chat-models, byok-settings, chat-tools, and chat.
 * They now live here, so adding a provider is (mostly) one entry.
 *
 * SDKs are lazy-`require`d inside the factories so we don't pull heavy deps in at
 * startup, and so a provider whose SDK isn't installed yet never breaks load.
 */

// Ephemeral prompt-caching breakpoint applied to Anthropic requests. The '5m'
// TTL is deliberate — it keeps the cheaper 1.25x cache-write multiplier (a 1h
// TTL would be 2x). If this TTL ever changes, CACHE_WRITE_MULTIPLIER in
// ai-usage.js must change to match. Exported so chat-models.tagLastMessageWithCache
// shares the exact same breakpoint.
const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral', ttl: '5m' };

// ---------------------------------------------------------------------------
// Key validation — lightweight, auth-only requests. Return null on success or a
// human-readable error string on failure.
// ---------------------------------------------------------------------------

async function validateAnthropicKey(apiKey) {
  // Count tokens is the cheapest Anthropic endpoint — no model invocation.
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (res.status === 401) return 'Invalid Anthropic API key';
  if (res.status === 403) return 'Anthropic API key does not have permission';
  if (!res.ok) return `Anthropic API returned status ${res.status}`;
  return null;
}

async function validateGoogleKey(apiKey) {
  // List models is a free, auth-only endpoint.
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`
  );
  if (res.status === 400 || res.status === 403) return 'Invalid Google API key';
  if (!res.ok) return `Google API returned status ${res.status}`;
  return null;
}

async function validateOpenAIKey(apiKey) {
  // List models is a free, auth-only endpoint.
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) return 'Invalid OpenAI API key';
  if (res.status === 403) return 'OpenAI API key does not have permission';
  if (!res.ok) return `OpenAI API returned status ${res.status}`;
  return null;
}

// z.ai exposes an OpenAI-compatible API. Base URL for its general (paas) endpoint;
// used both by the client factory and key validation below.
const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

async function validateZaiKey(apiKey) {
  // z.ai's OpenAI-compatible list-models is a free, auth-only endpoint (verified
  // live: the route exists and auth is checked before anything else — a bad key
  // returns 401, not 404).
  const res = await fetch(`${ZAI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) return 'Invalid z.ai API key';
  if (res.status === 403) return 'z.ai API key does not have permission';
  if (!res.ok) return `z.ai API returned status ${res.status}`;
  return null;
}

// z.ai/OpenRouter clients use @ai-sdk/openai-compatible rather than @ai-sdk/openai
// for two reasons: (1) its callable shorthand targets the chat-completions API by
// default (neither backend implements the Responses API the @ai-sdk/openai
// shorthand assumes), so no per-provider createModel hook is needed; and (2) it
// parses GLM's reasoning stream (z.ai's `reasoning_content` and OpenRouter's
// `reasoning` delta fields) into AI SDK reasoning parts, which @ai-sdk/openai drops
// — that's what surfaces GLM "thinking" blocks in the chat UI.
function createZaiClient(apiKey) {
  return require('@ai-sdk/openai-compatible').createOpenAICompatible({
    name: 'zai', apiKey, baseURL: ZAI_BASE_URL,
  });
}

// OpenRouter is an OpenAI-compatible gateway (base URL for its v1 API). Reused by
// the client factory and key validation below.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// OpenRouter's optional app-attribution headers.
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://squiredocs.com', 'X-Title': 'Squire Docs' };

function createOpenRouterClient(apiKey) {
  const compat = require('@ai-sdk/openai-compatible');
  const provider = compat.createOpenAICompatible({
    name: 'openrouter', apiKey, baseURL: OPENROUTER_BASE_URL, headers: OPENROUTER_HEADERS,
  });
  // The web-search sub-call (buildOpenRouterWebSearch) needs OpenRouter's
  // `url_citation` annotations mapped to `sources`, which @ai-sdk/openai does but
  // @ai-sdk/openai-compatible does not. Stash a dedicated @ai-sdk/openai client
  // built from the same key/base URL for that one call.
  provider.webSearchClient = require('@ai-sdk/openai').createOpenAI({
    apiKey, baseURL: OPENROUTER_BASE_URL, headers: OPENROUTER_HEADERS,
  });
  return provider;
}

async function validateOpenRouterKey(apiKey) {
  // NOTE: OpenRouter's /models is PUBLIC (returns 200 without auth), so it can't
  // validate a key. /key is the auth-only endpoint — it returns the key's own
  // metadata (limits, usage) and 401s on a missing/invalid key (verified live).
  const res = await fetch(`${OPENROUTER_BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) return 'Invalid OpenRouter API key';
  if (res.status === 403) return 'OpenRouter API key does not have permission';
  if (!res.ok) return `OpenRouter API returned status ${res.status}`;
  return null;
}

// ---------------------------------------------------------------------------
// Web-search tool builders. Return an AI SDK tool definition, or null if the
// provider has no web search. The universal webFetch tool is added separately in
// chat-tools.js.
// ---------------------------------------------------------------------------

function buildAnthropicWebSearch(provider) {
  // Anthropic's server-side (provider-executed) web search.
  return provider.tools.webSearch_20250305();
}

function buildGoogleWebSearch(provider) {
  // Gemini can't combine googleSearch with function tools in one request, so we
  // wrap it as a function tool that makes a separate generateText call.
  const { tool, generateText, jsonSchema } = require('ai');
  const searchModel = provider('gemini-2.5-flash');
  return tool({
    description: 'Search the web for current information using Google Search. Returns a grounded summary of search results. You MUST provide a query.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to look up on the web' },
      },
      required: ['query'],
    }),
    execute: async (args) => {
      const query = args.query || (typeof args === 'string' ? args : JSON.stringify(args));
      console.log('[Chat API] webSearch query:', query);
      const searchResult = await generateText({
        model: searchModel,
        // AI SDK v6 renamed maxTokens → maxOutputTokens; the old name was silently
        // ignored here, leaving the grounded summary unbounded.
        maxOutputTokens: 2048,
        tools: { googleSearch: provider.tools.googleSearch({}) },
        system: 'You are a web research assistant. Answer questions using only information found in Google Search results. Always include specific details such as names, locations, and descriptions. For every fact you include, cite the exact source URL from the search results.',
        prompt: query,
      });

      const text = searchResult.text || '';
      const sources = searchResult.sources || [];
      console.log('[Chat API] webSearch result: text=%d chars, sources=%d, finishReason=%s',
        text.length, sources.length, searchResult.finishReason);
      if (!text && sources.length === 0) return 'No results found.';
      if (sources.length === 0) return text;

      const result = { text, citations: {} };
      result.citations.sources = sources.map((s, i) => ({
        index: i,
        url: s.url,
        title: s.title || undefined,
      }));

      const gm = searchResult.providerMetadata?.google?.groundingMetadata;
      if (gm?.groundingSupports) {
        result.citations.supports = gm.groundingSupports.map(sup => ({
          text: sup.segment?.text || sup.segment_text || undefined,
          sourceIndices: sup.groundingChunkIndices || sup.supportChunkIndices || [],
        }));
      }

      return result;
    },
  });
}

function buildOpenAIWebSearch(provider) {
  // OpenAI's provider-executed web search (Responses API). Prefer the GA tool,
  // fall back to the preview name on older SDK versions.
  const tools = provider.tools || {};
  const make = tools.webSearch || tools.webSearchPreview;
  return make ? make({}) : null;
}

function buildZaiWebSearch() {
  // z.ai's OpenAI-compatible chat API has no provider-executed web search we wire
  // up; GLM models still get the universal webFetch tool from chat-tools.js.
  return null;
}

// Model used for OpenRouter's web-search sub-call. The `:online` suffix is
// OpenRouter's web plugin. We deliberately do NOT use a GLM model here: the sub-
// call only has to summarize+cite search results (not reason about the user's
// task), and GLM inference via OpenRouter is high-latency. Routing the search
// synthesis through fast, low-latency Gemini Flash keeps web search snappy even
// when the user's main model is GLM — mirroring how the native Gemini path uses a
// fixed fast model regardless of the chosen model.
const OPENROUTER_SEARCH_MODEL = 'google/gemini-2.5-flash:online';

function buildOpenRouterWebSearch(provider) {
  // OpenRouter has no provider-executed web search that composes with function
  // tools in one request, so — like the Gemini path — we expose search as a
  // function tool that makes a SEPARATE generateText call against an `:online`
  // model. OpenRouter runs the web plugin, injects results, and returns
  // `url_citation` annotations, which @ai-sdk/openai surfaces as `sources`.
  //
  // The main GLM client is @ai-sdk/openai-compatible (for reasoning parsing), but
  // that provider does NOT map annotations to `sources`, so we use the dedicated
  // @ai-sdk/openai `webSearchClient` attached in createOpenRouterClient. `.chat()`
  // forces chat-completions; the callable fallback covers an unexpected shape.
  const { tool, generateText, jsonSchema } = require('ai');
  const client = provider.webSearchClient || provider;
  const searchModel = typeof client.chat === 'function'
    ? client.chat(OPENROUTER_SEARCH_MODEL)
    : client(OPENROUTER_SEARCH_MODEL);
  return tool({
    description: 'Search the web for current information. Returns a grounded summary of search results with source URLs. You MUST provide a query.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to look up on the web' },
      },
      required: ['query'],
    }),
    execute: async (args) => {
      const query = args.query || (typeof args === 'string' ? args : JSON.stringify(args));
      console.log('[Chat API] webSearch (openrouter) query:', query);
      const searchResult = await generateText({
        model: searchModel,
        // NOTE: AI SDK v6 renamed maxTokens → maxOutputTokens; the old name is
        // silently ignored (leaving generation effectively unbounded). Bounding
        // the grounded summary is the main latency lever for this nested call.
        maxOutputTokens: 2048,
        system: 'You are a web research assistant. Answer questions using only information found in web search results. Always include specific details such as names, locations, and descriptions. For every fact you include, cite the exact source URL from the search results.',
        prompt: query,
      });

      const text = searchResult.text || '';
      const sources = searchResult.sources || [];
      console.log('[Chat API] webSearch (openrouter) result: text=%d chars, sources=%d, finishReason=%s',
        text.length, sources.length, searchResult.finishReason);
      if (!text && sources.length === 0) return 'No results found.';
      if (sources.length === 0) return text;

      return {
        text,
        citations: {
          sources: sources.map((s, i) => ({
            index: i,
            url: s.url,
            title: s.title || undefined,
          })),
        },
      };
    },
  });
}

/**
 * Per-model Anthropic extended-thinking options. The thinking form is
 * model-specific (verified live against @ai-sdk/anthropic@3.0.64):
 *   - claude-haiku-4-5  → only `{ type: 'enabled', budgetTokens }` (rejects adaptive)
 *   - claude-opus-4-8   → only `{ type: 'adaptive' }` + top-level effort (rejects enabled)
 *   - claude-sonnet-4-6 → supports both
 * Default non-haiku models to adaptive (the modern form); haiku gets a modest budget.
 */
function anthropicThinking(modelId) {
  if (/haiku/.test(modelId || '')) {
    return { thinking: { type: 'enabled', budgetTokens: 2048 } };
  }
  return { thinking: { type: 'adaptive' }, effort: 'low' };
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyColumn: 'byok_anthropic_key',
    keyPlaceholder: 'sk-ant-...',
    keyMask: 'sk-ant-••••••',
    // Env var holding the shared server key (used by defaultClient). Presence of
    // this key is what makes the provider's models eligible as a shared default
    // (see hasServerKey). null → BYOK-only, never a shared default.
    serverKeyEnv: 'ANTHROPIC_API_KEY',
    defaultClient: () => require('@ai-sdk/anthropic').anthropic,
    createClient: (apiKey) => require('@ai-sdk/anthropic').createAnthropic({ apiKey }),
    validateKey: validateAnthropicKey,
    // Extended thinking on all Claude models (incl. the shared default assistant),
    // using the per-model thinking form (see anthropicThinking). sendReasoning
    // surfaces reasoning summaries to the client; cacheControl stays for caching.
    buildProviderOptions: (def) => ({
      anthropic: {
        cacheControl: ANTHROPIC_CACHE_CONTROL,
        sendReasoning: true,
        ...anthropicThinking(def?.modelId),
      },
    }),
    buildWebSearch: buildAnthropicWebSearch,
    capabilities: { promptCache: true, providerExecutedWebSearch: true },
  },
  google: {
    id: 'google',
    label: 'Gemini',
    keyColumn: 'byok_google_key',
    keyPlaceholder: 'AIza...',
    keyMask: 'AIza••••••',
    serverKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    defaultClient: () => require('@ai-sdk/google').google,
    createClient: (apiKey) => require('@ai-sdk/google').createGoogleGenerativeAI({ apiKey }),
    validateKey: validateGoogleKey,
    buildProviderOptions: () => ({ google: { thinkingConfig: { includeThoughts: true } } }),
    buildWebSearch: buildGoogleWebSearch,
    // Gemini can hit INVALID_ARGUMENT when thought signatures from earlier turns are
    // lost in persistence; chat.js retries once without reasoning options when this is set.
    capabilities: { promptCache: false, providerExecutedWebSearch: false, retryWithoutReasoningOnInvalidArgument: true },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyColumn: 'byok_openai_key',
    keyPlaceholder: 'sk-...',
    keyMask: 'sk-••••••',
    // No shared server OpenAI key — GPT-5.x run only via BYOK, so they can never
    // be selected as the shared-assistant default.
    serverKeyEnv: null,
    defaultClient: () => require('@ai-sdk/openai').openai,
    createClient: (apiKey) => require('@ai-sdk/openai').createOpenAI({ apiKey }),
    validateKey: validateOpenAIKey,
    // GPT-5.x are reasoning models. Surface reasoning summaries to the client and
    // keep effort 'low' to bound agentic-loop cost/latency ('minimal' is rejected by
    // gpt-5.4-mini; 'low' is supported across the family). BYOK-only — cost is on the
    // user's key. Bump to 'medium'/'high' per model here later if desired.
    buildProviderOptions: () => ({ openai: { reasoningEffort: 'low', reasoningSummary: 'auto' } }),
    buildWebSearch: buildOpenAIWebSearch,
    // OpenAI's web search runs server-side (provider-executed), so the same
    // history-stripping the Anthropic path uses applies here too.
    capabilities: { promptCache: false, providerExecutedWebSearch: true },
  },
  zai: {
    id: 'zai',
    label: 'z.ai',
    keyColumn: 'byok_zai_key',
    keyPlaceholder: 'z.ai API key',
    keyMask: '••••••',
    // No shared server z.ai key — GLM models run only via BYOK, so they can never
    // be selected as the shared-assistant default. The default (no-BYOK) client is
    // therefore never used to serve a shared default; it exists only for symmetry.
    serverKeyEnv: null,
    // openai-compatible client (see createZaiClient): chat-completions by default
    // and parses GLM `reasoning_content` into UI reasoning parts.
    defaultClient: () => createZaiClient(process.env.ZAI_API_KEY),
    createClient: (apiKey) => createZaiClient(apiKey),
    validateKey: validateZaiKey,
    // GLM models work out of the box over the chat-completions API; we send no
    // provider-specific options (OpenAI reasoning options don't map to z.ai).
    buildProviderOptions: () => undefined,
    buildWebSearch: buildZaiWebSearch,
    // GLM reasoning is streamed to the UI, but openai-compatible echoes it back as
    // `reasoning_content` in assistant history — strip it from outgoing requests so
    // z.ai isn't fed its own prior chain-of-thought (see stripReasoningFromHistory
    // handling in chat.js).
    capabilities: { promptCache: false, providerExecutedWebSearch: false, stripReasoningFromHistory: true },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyColumn: 'byok_openrouter_key',
    keyPlaceholder: 'sk-or-v1-...',
    keyMask: 'sk-or-••••••',
    // No shared server OpenRouter key — models run only via BYOK (cost is on the
    // user's OpenRouter account), so they can never be the shared-assistant default.
    serverKeyEnv: null,
    // openai-compatible client (see createOpenRouterClient): chat-completions by
    // default and parses OpenRouter's `reasoning` deltas into UI reasoning parts.
    // The default (no-BYOK) client is never used to serve a shared default.
    defaultClient: () => createOpenRouterClient(process.env.OPENROUTER_API_KEY),
    createClient: (apiKey) => createOpenRouterClient(apiKey),
    validateKey: validateOpenRouterKey,
    buildProviderOptions: () => undefined,
    // Web search via OpenRouter's `:online` web plugin, wrapped as a function tool
    // (a separate generateText sub-call) — same shape as the Gemini path, so it's a
    // normal client tool and needs no provider-executed history stripping.
    buildWebSearch: buildOpenRouterWebSearch,
    // GLM reasoning streams to the UI but is echoed back as `reasoning_content` in
    // assistant history by openai-compatible — strip it from outgoing requests.
    capabilities: { promptCache: false, providerExecutedWebSearch: false, stripReasoningFromHistory: true },
  },
};

/** Get a provider config by id. Throws on unknown provider. */
function getProviderConfig(id) {
  const cfg = PROVIDERS[id];
  if (!cfg) throw new Error(`Unknown provider: ${id}`);
  return cfg;
}

/** All provider configs, in declaration order. */
function listProviders() {
  return Object.values(PROVIDERS);
}

/**
 * Whether this deployment has a shared server key for the given provider. Only
 * providers with a server key can back the shared-assistant default model (BYOK
 * models run on the user's own key and are excluded). Unknown provider → false.
 */
function hasServerKey(id) {
  const cfg = PROVIDERS[id];
  return !!(cfg && cfg.serverKeyEnv && process.env[cfg.serverKeyEnv]);
}

module.exports = { PROVIDERS, getProviderConfig, listProviders, hasServerKey, ANTHROPIC_CACHE_CONTROL };
