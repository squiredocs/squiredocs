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
        maxTokens: 4096,
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

module.exports = { PROVIDERS, getProviderConfig, listProviders, ANTHROPIC_CACHE_CONTROL };
