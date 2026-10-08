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

const { PROVIDERS, getProviderConfig, hasServerKey, ANTHROPIC_CACHE_CONTROL } = require('./ai-providers');
const { stripUiOnlyDiffFields } = require('../mcp/diff-utils');

// Sonnet 5.5 since 2026-10-01 (was claude-opus / Opus 4.8): Sam's call, $2/$10 against
// $5/$25. An admin selection in app_settings or AI_CHAT_MODEL still takes precedence.
const DEFAULT_MODEL_KEY = 'claude-sonnet-5-5';

// pricing: cents per 1M tokens (from official Anthropic/Google pricing)
// contextWindow: model input limit in tokens (used for dynamic tool result sizing)
// cacheReadMultiplier (optional): cache-read price as a fraction of base input, for
//   models that deviate from the standard 0.1x (see computeCostCents in ai-usage.js)
// preservedThinking (optional): the model rejects replayed thinking blocks once the
//   earlier history has changed (see shouldStripReasoningFromHistory below)
const MODEL_DEFS = [
  { key: 'claude-haiku',       provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',              pricing: { input: 100, output: 500 },  contextWindow: 200_000 },
  // Claude 4.6 and later carry the full 1M-token context window at standard pricing
  // (no long-context surcharge), so Sonnet 4.6 / Sonnet 5 / Opus 4.8 are 1M, not 200k.
  { key: 'claude-sonnet',      provider: 'anthropic', modelId: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6',             pricing: { input: 300, output: 1500 }, contextWindow: 1_000_000 },
  // Sonnet 5's $2/$10 launch price became its standard price: the increase to $3/$15
  // scheduled for 2026-09-01 was cancelled (pricing page, verified 2026-10-01).
  { key: 'claude-sonnet-5',    provider: 'anthropic', modelId: 'claude-sonnet-5',           label: 'Claude Sonnet 5',               pricing: { input: 200, output: 1000 }, contextWindow: 1_000_000 },
  { key: 'claude-opus',        provider: 'anthropic', modelId: 'claude-opus-4-8',            label: 'Claude Opus 4.8',               pricing: { input: 500, output: 2500 }, contextWindow: 1_000_000 },
  // Claude 5 family (pricing + limits from platform.claude.com/docs/en/about-claude/pricing
  // and .../models/overview, verified 2026-07-26): Opus 5 $5/$25 per 1M, Fable 5 $10/$50
  // per 1M; both ship a 1M-token context window at standard pricing and 128k max output,
  // and both accept image input (vision is derived from the anthropic provider below).
  { key: 'claude-opus-5',      provider: 'anthropic', modelId: 'claude-opus-5',              label: 'Claude Opus 5',                 pricing: { input: 500, output: 2500 }, contextWindow: 1_000_000 },
  { key: 'claude-fable-5',     provider: 'anthropic', modelId: 'claude-fable-5',             label: 'Claude Fable 5',                pricing: { input: 1000, output: 5000 }, contextWindow: 1_000_000 },
  // Current Claude generation, added 2026-10-01 (pricing + limits from
  // platform.claude.com/docs/en/about-claude/pricing and .../models/overview): Sonnet 5.5
  // $2/$10, Opus 5.5 $4/$20 (cheaper than Opus 5), Fable 5.1 $10/$50; all 1M context,
  // 128k max output, image input. Their predecessors stay listed: all are still active,
  // and removing an entry would break any user whose byok_model_key names it.
  //   - Cache reads are discounted more deeply than the standard 0.1x on Opus 5.5
  //     (0.05x) and Fable 5.1 (0.025x), hence cacheReadMultiplier.
  //   - All three bind thinking blocks to the exact conversation that produced them
  //     (preservedThinking). Thinking is always on and forced tool_choice is rejected;
  //     the chat path only ever sends adaptive thinking and toolChoice 'none'.
  //   - They need @ai-sdk/anthropic >= 3.0.127: older versions don't know the ids and
  //     silently cap max_tokens at 4096 (thinking counts against it).
  { key: 'claude-sonnet-5-5',  provider: 'anthropic', modelId: 'claude-sonnet-5-5',          label: 'Claude Sonnet 5.5',             pricing: { input: 200, output: 1000 }, contextWindow: 1_000_000, preservedThinking: true },
  { key: 'claude-opus-5-5',    provider: 'anthropic', modelId: 'claude-opus-5-5',            label: 'Claude Opus 5.5',               pricing: { input: 400, output: 2000 }, contextWindow: 1_000_000, cacheReadMultiplier: 0.05, preservedThinking: true },
  { key: 'claude-fable-5-1',   provider: 'anthropic', modelId: 'claude-fable-5-1',           label: 'Claude Fable 5.1',              pricing: { input: 1000, output: 5000 }, contextWindow: 1_000_000, cacheReadMultiplier: 0.025, preservedThinking: true },
  { key: 'gemini-2.5-flash',   provider: 'google',    modelId: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash',              pricing: { input:  30, output: 250 },  contextWindow: 1_048_576 },
  { key: 'gemini-2.5-pro',     provider: 'google',    modelId: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro',                pricing: { input: 125, output: 1000 }, contextWindow: 1_048_576 },
  { key: 'gemini-3-flash',     provider: 'google',    modelId: 'gemini-3-flash-preview',     label: 'Gemini 3 Flash (Preview)',       pricing: { input:  50, output: 300 },  contextWindow: 1_048_576 },
  { key: 'gemini-3.1-pro',     provider: 'google',    modelId: 'gemini-3.1-pro-preview',     label: 'Gemini 3.1 Pro (Preview)',       pricing: { input: 200, output: 1200 }, contextWindow: 1_048_576 },
  { key: 'gemini-3.5-flash',   provider: 'google',    modelId: 'gemini-3.5-flash',           label: 'Gemini 3.5 Flash',              pricing: { input: 150, output: 900 },  contextWindow: 1_048_576 },
  // Current-generation Gemini, verified 2026-07-26 against ai.google.dev/gemini-api/
  // docs/pricing (paid-tier standard rates) and the per-model spec pages under
  // ai.google.dev/gemini-api/docs/models/<id>. Both declare Function calling +
  // Thinking, take text/image/video/audio/PDF input, and carry a 1,048,576-token
  // input limit (65,536 output).
  //   gemini-3.6-flash      $1.50 / $7.50 per 1M — the newest stable Flash
  //   gemini-3.5-flash-lite $0.30 / $2.50 per 1M — cheapest current-gen tier
  // Google is in VISION_PROVIDERS, so both accept image attachments.
  // Google's own pricing/models pages still list every Gemini entry above as live;
  // the models page's shut-down list (2.0 Flash / 2.0 Flash-Lite / Gemini 3 Pro
  // Preview / Gemini 3.1 Flash-Lite Preview) names nothing this registry uses, so
  // nothing is removed here.
  { key: 'gemini-3.5-flash-lite', provider: 'google', modelId: 'gemini-3.5-flash-lite',      label: 'Gemini 3.5 Flash-Lite',         pricing: { input:  30, output: 250 },  contextWindow: 1_048_576 },
  { key: 'gemini-3.6-flash',   provider: 'google',    modelId: 'gemini-3.6-flash',           label: 'Gemini 3.6 Flash',              pricing: { input: 150, output: 750 },  contextWindow: 1_048_576 },
  // Gemini 3.8 Flash (stable, 2026-09) — the newest Flash, added 2026-10-01 off the
  // same two pages: same limits and capabilities as 3.6 (thinking levels low/medium/
  // high). Google is running 3.6/3.7/3.8 Flash at a promotional $0.75/$3.75 through
  // 2026-12-31; we record the $1.50/$7.50 list price that applies from 2027-01-01 so
  // metering needs no follow-up edit (it over-meters shared usage until then).
  // 3.7 Flash is skipped: same price, superseded by 3.8 three weeks after release.
  { key: 'gemini-3.8-flash',   provider: 'google',    modelId: 'gemini-3.8-flash',           label: 'Gemini 3.8 Flash',              pricing: { input: 150, output: 750 },  contextWindow: 1_048_576 },
  // OpenAI models. There is no shared server OpenAI key, so these only run when
  // a user supplies their own (selectable in Settings once an OpenAI key is
  // stored; isByokActive enforces the key at request time). pricing in cents per
  // 1M tokens, from the official API pricing page
  // (developers.openai.com/api/docs/pricing). Reasoning (o-series / *-pro) models
  // are intentionally omitted.
  //
  // GPT-5.6 (Sol / Terra / Luna) added 2026-07-26 — the current frontier family,
  // verified off developers.openai.com/api/docs/pricing plus each model's page
  // under /api/docs/models/<id>: all three take text+image input, support function
  // calling, and carry a 1,050,000-token context window (128k max output). They
  // accept reasoningEffort 'low', so the provider-level buildProviderOptions in
  // ai-providers.js needs no per-model handling. The `gpt-5.6` alias routes to
  // gpt-5.6-sol; we pin explicit ids so metering can't drift when the alias moves.
  // GPT-5.5 / GPT-5.4 / GPT-5.4 mini are all still listed on the pricing page and
  // absent from /api/docs/deprecations, so they stay (removing an entry would break
  // any user whose byok_model_key names it). Their prices re-verified unchanged;
  // gpt-5.5's context window is corrected below to the documented 1,050,000.
  //
  // GPT-6 added 2026-10-01, verified off the same pages: Astra (top tier), GPT-6.1 Sol
  // (the current Sol; supersedes gpt-6-sol at the same price, so gpt-6-sol is skipped)
  // and Luna (efficiency tier). All take text+image, 1,050,000-token context, 128k max
  // output, and accept reasoningEffort 'low'. They need @ai-sdk/openai >= 3.0.124:
  // older versions only treat `gpt-5*` ids as reasoning models and would drop the
  // reasoning options. The same check found GPT-5.6 repriced since July (Sol $5/$30 →
  // $4/$20, Terra $2.50/$15 → $2/$12, Luna $1/$6 → $0.20/$1.20), corrected below.
  // Prompts over 272k tokens bill at a higher long-context rate that is not modelled.
  { key: 'gpt-6-astra',        provider: 'openai',    modelId: 'gpt-6-astra',                label: 'GPT-6 Astra',                   pricing: { input: 1000, output: 5000 }, contextWindow: 1_050_000 },
  { key: 'gpt-6.1-sol',        provider: 'openai',    modelId: 'gpt-6.1-sol',                label: 'GPT-6.1 Sol',                   pricing: { input: 200, output: 1000 }, contextWindow: 1_050_000 },
  { key: 'gpt-6-luna',         provider: 'openai',    modelId: 'gpt-6-luna',                 label: 'GPT-6 Luna',                    pricing: { input:  10, output:   50 }, contextWindow: 1_050_000 },
  { key: 'gpt-5.6-sol',        provider: 'openai',    modelId: 'gpt-5.6-sol',                label: 'GPT-5.6 Sol',                   pricing: { input: 400, output: 2000 }, contextWindow: 1_050_000 },
  { key: 'gpt-5.6-terra',      provider: 'openai',    modelId: 'gpt-5.6-terra',              label: 'GPT-5.6 Terra',                 pricing: { input: 200, output: 1200 }, contextWindow: 1_050_000 },
  { key: 'gpt-5.6-luna',       provider: 'openai',    modelId: 'gpt-5.6-luna',               label: 'GPT-5.6 Luna',                  pricing: { input:  20, output:  120 }, contextWindow: 1_050_000 },
  { key: 'gpt-5.5',            provider: 'openai',    modelId: 'gpt-5.5',                    label: 'GPT-5.5',                       pricing: { input: 500, output: 3000 }, contextWindow: 1_050_000 },
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
  // GLM-5.3 (2026-08), added 2026-10-01 off docs.z.ai: 1M context, 128k max output,
  // function calling, reasoning always on (we send no thinking config, so nothing to
  // adapt). 5.3 is the flagship at 5.2's price; 5.3-Flash is the cheap tier. Flash
  // also accepts image/video input, but zai is not in VISION_PROVIDERS, so it ships
  // text-only like the rest until a live image round-trip is verified.
  { key: 'glm-5.3',            provider: 'zai',       modelId: 'glm-5.3',                    label: 'GLM-5.3',                       pricing: { input: 140, output:  440 }, contextWindow: 1_000_000 },
  { key: 'glm-5.3-flash',      provider: 'zai',       modelId: 'glm-5.3-flash',              label: 'GLM-5.3 Flash',                 pricing: { input:  15, output:   50 }, contextWindow: 1_000_000 },
  // OpenRouter — an OpenAI-compatible gateway. Model ids are namespaced
  // (`z-ai/glm-*`, `moonshotai/*`, `qwen/*`, `minimax/*`, `deepseek/*`, `xiaomi/*`,
  // `tencent/*`, `x-ai/*`, `meta-llama/*`); like z.ai it only implements chat-completions, so
  // the provider's createModel hook forces the chat model. When OPENROUTER_API_KEY is
  // set these become eligible as the shared assistant default (feature 026); a BYOK
  // user can also select them, billed to their own OpenRouter account. pricing (cents
  // per 1M tokens = catalog USD/token × 10^8) and context windows are read straight
  // from OpenRouter's models API (openrouter.ai/api/v1/models). Entries added through
  // 2026-07-26 carry that day's snapshot (coordinated refresh; every entry re-verified
  // off one catalog fetch).
  //
  // Pricing caveat found 2026-10-01: for a model served by many hosts, the catalog's
  // headline price is now the CHEAPEST host, not what a routed request costs (Kimi K3
  // reads 36.5/1000 while Moonshot's own endpoint, and most hosts, charge 300/1500;
  // GLM-5.3 reads 22/339 against z.ai's 140/440). Re-reading the July entries off the
  // headline would under-meter the shared key, so they are deliberately NOT repriced
  // here. Entries added 2026-10-01 record the model author's own endpoint price from
  // openrouter.ai/api/v1/models/<id>/endpoints, which is at or above what almost every
  // host charges. Do not "refresh" either set from the headline price.
  //
  // Every model below must support tool calling (`tools` in the catalog's
  // supported_parameters) — the assistant drives its whole document workflow through
  // tools, so a non-tool model is useless here regardless of how it benchmarks.
  //
  // Vision: openrouter is not in VISION_PROVIDERS, so every entry below is text-only
  // and rides the honest model_no_image_support gate. The catalog declares `image`
  // input on kimi-k3 / qwen3.7-plus / minimax-m3, but with no funded shared key to
  // verify a live image round-trip (feature 026 D5/C1, fail-closed), they ship
  // text-only. Flip supportsImages:true per entry only after the go-live round-trip.
  // The families added below are text-only in the catalog itself, so for them
  // supportsImages:false is the honest declaration and not a deferred verification.
  //
  // Reasoning: several of these (DeepSeek V4, Hy3, MiMo) stream a chain of thought.
  // That needs no per-model handling — openrouter already declares
  // stripReasoningFromHistory at the PROVIDER level (ai-providers.js), so reasoning
  // is dropped from outgoing history for every gateway entry, and
  // buildProviderOptions sends no reasoning config, leaving each model on its own
  // default effort. Keep it that way: a model that would need NEW normalization code
  // does not belong in this list.
  { key: 'or-kimi-k3',         provider: 'openrouter', modelId: 'moonshotai/kimi-k3',        label: 'Kimi K3',                       pricing: { input: 300,    output: 1500 },   contextWindow: 1_048_576 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  // Kimi K2 series (Sam's ask, 2026-07-21): the current-generation K2 line.
  // Older snapshots (kimi-k2, kimi-k2-0905) are deliberately omitted as superseded.
  { key: 'or-kimi-k2.7-code',  provider: 'openrouter', modelId: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code',                pricing: { input:  78,    output:  350 },   contextWindow:   262_144 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-kimi-k2.6',       provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6',      label: 'Kimi K2.6',                     pricing: { input:  64.6,  output:  272 },   contextWindow:   262_144 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-kimi-k2.5',       provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5',      label: 'Kimi K2.5',                     pricing: { input:  57,    output:  285 },   contextWindow:   262_144 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-kimi-k2-thinking', provider: 'openrouter', modelId: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking',           pricing: { input:  60,    output:  250 },   contextWindow:   262_144 }, // text-only per catalog
  // Qwen3.8 (added 2026-10-01): Alibaba is the only host, so the price is unambiguous.
  // Max is published only as a dated snapshot id. Flash is the cheap tier.
  { key: 'or-qwen3.8-max',     provider: 'openrouter', modelId: 'qwen/qwen3.8-max-0902',     label: 'Qwen3.8 Max',                   pricing: { input: 200,    output:  600 },   contextWindow: 1_000_000 }, // TODO(go-live): catalog lists image (and video) input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-qwen3.8-flash',   provider: 'openrouter', modelId: 'qwen/qwen3.8-flash',        label: 'Qwen3.8 Flash',                 pricing: { input:  15,    output:   47 },   contextWindow: 1_000_000 }, // TODO(go-live): catalog lists image (and video) input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-qwen3.7-max',     provider: 'openrouter', modelId: 'qwen/qwen3.7-max',          label: 'Qwen3.7 Max',                   pricing: { input: 147.5,  output: 442.5 },  contextWindow: 1_000_000 }, // text-only per catalog
  { key: 'or-qwen3.7-plus',    provider: 'openrouter', modelId: 'qwen/qwen3.7-plus',         label: 'Qwen3.7 Plus',                  pricing: { input:  32,    output:  128 },   contextWindow: 1_000_000 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-minimax-m3',      provider: 'openrouter', modelId: 'minimax/minimax-m3',        label: 'MiniMax M3',                    pricing: { input:  30,    output:  120 },   contextWindow: 1_048_576 }, // TODO(go-live): catalog lists image (and video) input — verify a live image round-trip through the gateway before enabling vision
  { key: 'or-glm-4.6',         provider: 'openrouter', modelId: 'z-ai/glm-4.6',              label: 'GLM-4.6',                       pricing: { input:  50,    output:  200 },   contextWindow:   204_800 },
  { key: 'or-glm-4.7',         provider: 'openrouter', modelId: 'z-ai/glm-4.7',              label: 'GLM-4.7',                       pricing: { input:  40,    output:  175 },   contextWindow:   204_800 },
  { key: 'or-glm-5',           provider: 'openrouter', modelId: 'z-ai/glm-5',                label: 'GLM-5',                         pricing: { input:  95,    output:  255 },   contextWindow:   204_800 },
  { key: 'or-glm-5.2',         provider: 'openrouter', modelId: 'z-ai/glm-5.2',              label: 'GLM-5.2',                       pricing: { input:  71.96, output:  226.16 }, contextWindow: 1_048_576 },
  // GLM-5.3 (added 2026-10-01), priced at z.ai's own endpoint (see the caveat above).
  { key: 'or-glm-5.3',         provider: 'openrouter', modelId: 'z-ai/glm-5.3',              label: 'GLM-5.3',                       pricing: { input: 140,    output:  440 },   contextWindow: 1_048_576 }, // text-only per catalog
  { key: 'or-glm-5.3-flash',   provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash',        label: 'GLM-5.3 Flash',                 pricing: { input:  15,    output:   50 },   contextWindow: 1_048_576 }, // TODO(go-live): catalog lists image (and video) input — verify a live image round-trip through the gateway before enabling vision
  // Families added 2026-07-26 to broaden the gateway lineup beyond Moonshot/Qwen/
  // MiniMax/z.ai. Chosen off OpenRouter's live token-volume rankings (DeepSeek V4
  // Flash, Hy3 and MiMo V2.5 were all top-5 by 30-day tokens at authoring time) plus
  // price-per-capability; all are current, non-deprecated, tool-calling endpoints.
  //
  // DeepSeek V4 (2026-04-24): 1M-token context, text-only. Pro is the frontier
  // reasoning/coding tier; Flash is the efficiency tier and the better default for
  // ordinary tool-driven document work at ~1/3 the price.
  { key: 'or-deepseek-v4-pro', provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro',  label: 'DeepSeek V4 Pro',               pricing: { input:  43.5,  output:   87 },   contextWindow: 1_048_576 },
  { key: 'or-deepseek-v4-flash', provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash',          pricing: { input:  14,    output:   28 },   contextWindow: 1_048_576 },
  // DeepSeek V4.1 Flash (2026-09-10, added 2026-10-01): the V4 Flash successor, priced
  // at DeepSeek's own endpoint. There is no V4.1 Pro yet.
  { key: 'or-deepseek-v4.1-flash', provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash',    pricing: { input:  15,    output:   60 },   contextWindow: 1_048_576 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  // Xiaomi's flagship, strong on agentic/long-horizon work. The sibling
  // `xiaomi/mimo-v2.5` is omnimodal; we take the text-only Pro so the text-only
  // declaration below is the model's own nature rather than a gateway limitation.
  { key: 'or-mimo-v2.5-pro',   provider: 'openrouter', modelId: 'xiaomi/mimo-v2.5-pro',      label: 'MiMo-V2.5-Pro',                 pricing: { input:  43.5,  output:   87 },   contextWindow: 1_050_000 },
  // MiMo-V2.6-Pro (2026-09-21, added 2026-10-01): same price as V2.5-Pro. Unlike its
  // predecessor the Pro is now omnimodal, so text-only here is a deferred verification.
  { key: 'or-mimo-v2.6-pro',   provider: 'openrouter', modelId: 'xiaomi/mimo-v2.6-pro',      label: 'MiMo-V2.6-Pro',                 pricing: { input:  43.5,  output:   87 },   contextWindow: 1_050_000 }, // TODO(go-live): catalog lists image (and video/audio) input — verify a live image round-trip through the gateway before enabling vision
  // Tencent's agentic MoE (295B total / 21B active). Cheapest input of the capable
  // tier here. Labelled with its vendor since the bare product name isn't
  // self-identifying the way Kimi/Qwen/GLM are.
  { key: 'or-hy3',             provider: 'openrouter', modelId: 'tencent/hy3',               label: 'Tencent Hy3',                   pricing: { input:  13.2,  output:   52.8 }, contextWindow:   262_144 },
  // Grok 4.7 (xAI, 2026-09-21, added 2026-10-01): a frontier lab reachable only through
  // the gateway. xAI is the only host, so the catalog price is the real price.
  // Meta's Muse Spark 1.3 was evaluated alongside it and left out: OpenRouter answers
  // 403 until the account owner completes an 18+ attestation in their OpenRouter
  // preferences, so it would fail for the shared key and for any BYOK user by default.
  { key: 'or-grok-4.7',        provider: 'openrouter', modelId: 'x-ai/grok-4.7',             label: 'Grok 4.7',                      pricing: { input: 200,    output:  600 },   contextWindow:   500_000 }, // TODO(go-live): catalog lists image input — verify a live image round-trip through the gateway before enabling vision
  // Deliberately minimal tier. Llama 3.1 8B is a 2024-era small model — weak by
  // current standards, and that is the point: it is the floor option for accounts an
  // admin wants to keep functional but cheap (see the per-user model override). It is
  // kept in the list because it still WORKS end to end — native tool calling, ordinary
  // streaming, and one of the most widely served, most reliable endpoints on the
  // gateway. Do not swap it for something cheaper that can't hold a tool call.
  { key: 'or-llama-3.1-8b',    provider: 'openrouter', modelId: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B Instruct',  pricing: { input:   5,    output:    8 },   contextWindow:   131_072 },
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
 * Whether prior-turn reasoning must be dropped from what we SEND for this model.
 * Two independent causes:
 *   - the provider echoes reasoning back as request content (`stripReasoningFromHistory`
 *     capability — z.ai / OpenRouter, see stripReasoningParts);
 *   - the model binds each thinking block to the exact conversation that produced it
 *     (`preservedThinking` — Claude Sonnet 5.5 / Opus 5.5 / Fable 5.1). chat.js
 *     rewrites replayed history on every turn (provider-executed search results,
 *     UI-only diff data, deduplicated reads, the staleness note), so a replayed block
 *     no longer matches its conversation, and Anthropic accounts created on or after
 *     2026-08-31 reject the whole request with a 400. Dropping prior-turn thinking is
 *     Anthropic's documented recovery; thinking produced within the current turn is
 *     untouched (the AI SDK replays it unmodified across that turn's tool steps).
 */
function shouldStripReasoningFromHistory(def) {
  if (!def) return false;
  return !!(PROVIDERS[def.provider]?.capabilities?.stripReasoningFromHistory || def.preservedThinking);
}

/**
 * Return a copy of UI `messages` with UI-only word-emphasis data removed from
 * replayed tool outputs (feature 039, seam (c) of FR-012 / FR-014).
 *
 * A `modify` result's `diff.inlineSegments` is what the browser uses to draw
 * emphasized spans inside changed rows. Once that turn is history, replaying it
 * re-sends all of it to the model on EVERY subsequent turn, where it is useless
 * — the model already has `diff.lines`.
 *
 * Differences from its two siblings above:
 *   - MC-3: it never drops a part or a message, it only shrinks an output.
 *   - MC-4: it is UNCONDITIONAL, not capability-gated. Reasoning and
 *     provider-executed tools are stripped only for providers that mishandle
 *     them; this data is useless to every model.
 *   - MC-5: only `modelInputMessages` is rewritten. `validatedMessages` — the
 *     persisted history and what the UI renders — keeps the segments.
 *
 * The input array and its parts are not mutated.
 */
function stripUiOnlyDiffParts(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.parts)) return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (!p || typeof p !== 'object' || p.output === undefined) return p;
      const stripped = stripUiOnlyDiffFields(p.output);
      if (stripped === p.output) return p;
      changed = true;
      return { ...p, output: stripped };
    });
    return changed ? { ...m, parts } : m;
  });
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
function getThinkingSummaryModels() {
  // Ordered fallback chain, filtered to providers that actually hold a shared
  // server key. Key presence isn't funding (an unfunded key still fails at the
  // provider), so the endpoint additionally fails over at runtime — a broken
  // first choice must never blank the label while another funded key exists.
  const candidates = [
    { id: 'anthropic:claude-haiku-4-5', provider: 'anthropic', make: () => getProvider('anthropic')('claude-haiku-4-5-20251001') },
    { id: 'google:gemini-2.5-flash', provider: 'google', make: () => getProvider('google')('gemini-2.5-flash') },
    { id: 'openrouter:z-ai/glm-4.7', provider: 'openrouter', make: () => getProvider('openrouter')('z-ai/glm-4.7') },
  ];
  return candidates
    .filter((c) => hasServerKey(c.provider))
    .map((c) => ({ id: c.id, model: c.make() }));
}

/**
 * Whether a model key can back the shared (non-BYOK) default: it must name a known
 * registry entry whose provider has a configured shared server key. This is the
 * same derived eligibility the admin picker and save-time validation use, applied
 * at resolution time so a stored (or env-override) key whose provider lost its
 * server key never instantiates an unauthenticated shared client (feature 026 FR-005).
 * @param {string} [key]
 * @returns {boolean}
 */
function isSharedEligible(key) {
  if (!key) return false;
  const def = MODEL_DEFS.find((d) => d.key === key);
  return !!(def && hasServerKey(def.provider));
}

/**
 * Resolve the shared-assistant default model KEY (not a model instance), in
 * order of preference:
 *  1. The admin-selected default stored in app_settings (passed in by the caller).
 *  2. The AI_CHAT_MODEL env var (per-deployment override).
 *  3. DEFAULT_MODEL_KEY code constant (the always-load-bearing terminal fallback).
 *
 * Each candidate must be shared-eligible (known registry entry whose provider has a
 * server key) to be used; an ineligible candidate — e.g. a stored gateway default
 * after OPENROUTER_API_KEY is removed (the feature's rollback path), or an unknown
 * key left by a later release — is skipped with a logged warning so the deployment
 * degrades gracefully instead of failing every shared turn at the provider
 * (feature 026 FR-005/D4). After that come the per-provider fallbacks
 * (SHARED_FALLBACK_KEYS, led by DEFAULT_MODEL_KEY, claude-sonnet-5-5), so an instance
 * with only an OpenRouter or Gemini server key still resolves a usable model. With no
 * server key at all, DEFAULT_MODEL_KEY is returned unvalidated; the chat path turns
 * that into `assistant_not_configured` (see resolveChatModel).
 *
 * @param {string} [storedKey] The admin-selected key from app_settings (may be null).
 * @returns {string} The resolved model key.
 */
function resolveSharedDefaultKey(storedKey) {
  if (storedKey) {
    if (isSharedEligible(storedKey)) return storedKey;
    console.warn(
      `[Chat] Stored shared default "${storedKey}" is ineligible (unknown model, or its `
      + `provider has no shared server key); falling back to env/built-in default.`
    );
  }
  const envKey = process.env.AI_CHAT_MODEL;
  if (envKey) {
    if (isSharedEligible(envKey)) return envKey;
    console.warn(
      `[Chat] AI_CHAT_MODEL override "${envKey}" is ineligible (unknown model, or its `
      + `provider has no shared server key); falling back to built-in default.`
    );
  }
  // DEFAULT_MODEL_KEY is the deployment default whenever its provider holds a server
  // key (the hosted service always does, so this is a no-op there). A self-hosted
  // instance may configure only OPENROUTER_API_KEY or only the Gemini key: walk the
  // per-provider fallbacks, then any shared-eligible registry entry, so that instance
  // still gets a working assistant. With no server key at all, DEFAULT_MODEL_KEY is
  // still returned (callers that serve a turn check isSharedEligible on the result;
  // see resolveChatModel → assistant_not_configured).
  const fallback = SHARED_FALLBACK_KEYS.find(isSharedEligible)
    || MODEL_DEFS.find((d) => hasServerKey(d.provider))?.key;
  return fallback || DEFAULT_MODEL_KEY;
}

/**
 * Preferred shared default per provider, in order, used when nothing is stored or
 * set in AI_CHAT_MODEL. DEFAULT_MODEL_KEY comes first, so a deployment with an
 * Anthropic server key resolves exactly as before. OpenRouter precedes Google
 * because the self-host .env lists it as an assistant key, while the Gemini key is
 * often set only for semantic search.
 */
const SHARED_FALLBACK_KEYS = [DEFAULT_MODEL_KEY, 'or-kimi-k3', 'gemini-3.5-flash'];

/**
 * Whether ANY model can back the shared (non-BYOK) assistant on this deployment:
 * true exactly when some registry provider holds a shared server key. False on a
 * self-hosted instance started without ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or
 * GOOGLE_GENERATIVE_AI_API_KEY; there, only a user's own BYOK key can run the
 * assistant.
 * @returns {boolean}
 */
function hasUsableSharedModel() {
  return MODEL_DEFS.some((d) => hasServerKey(d.provider));
}

/**
 * Resolve the model KEY for a shared-key (non-BYOK) turn, honoring an admin-set
 * per-user override (feature 035):
 *   1. users.chat_model_override — when it is shared-eligible.
 *   2. resolveSharedDefaultKey(sharedDefaultKey) — the existing chain
 *      (app_settings → AI_CHAT_MODEL → DEFAULT_MODEL_KEY).
 *
 * An override that is unknown or currently ineligible (its provider lost its shared
 * server key) is SKIPPED with a warning and the turn proceeds on the shared default —
 * a stale override never fails a chat (FR-006). The stored value is deliberately NOT
 * cleared here: eligibility is re-evaluated every turn, so a temporarily-withdrawn
 * provider key resumes the override automatically once restored (RBD-2).
 *
 * @param {string} [overrideKey]      users.chat_model_override (may be null/undefined).
 * @param {string} [sharedDefaultKey] Admin-selected shared default from app_settings.
 * @returns {string} The resolved model key.
 */
function resolveUserChatModelKey(overrideKey, sharedDefaultKey) {
  if (overrideKey) {
    if (isSharedEligible(overrideKey)) return overrideKey;
    console.warn(
      `[Chat] Per-user chat model override "${overrideKey}" is ineligible (unknown model, or `
      + `its provider has no shared server key); falling back to the shared default. The stored `
      + `value is kept — it resumes if the model/key comes back.`
    );
  }
  return resolveSharedDefaultKey(sharedDefaultKey);
}

/**
 * Resolve the model to use for a chat request, in order of preference:
 *  1. BYOK — when enabled, the user's selected model + decrypted key. If BYOK is
 *     enabled but the model/key cannot be resolved, this returns a discriminated
 *     `{ error: 'byok_misconfigured', provider? }` signal — it does NOT silently
 *     fall back to the shared server key (feature 012, FR-019). A silent fallback
 *     would bill the operator's key while the request is still flagged BYOK,
 *     bypassing credit metering.
 *  2. Per-user override (non-BYOK only) — the admin-set users.chat_model_override,
 *     when it is still shared-eligible (feature 035; see resolveUserChatModelKey).
 *  3. Shared default (non-BYOK only) — the admin-selected model (sharedDefaultKey),
 *     else AI_CHAT_MODEL, else DEFAULT_MODEL_KEY (see resolveSharedDefaultKey).
 *  4. DEFAULT_MODEL_KEY as a final fallback if the resolved shared key is unknown.
 *  5. Non-BYOK with no shared-eligible model (no provider server key at all):
 *     `{ error: 'assistant_not_configured' }`, before any client is built.
 *
 * @param {object}   opts
 * @param {boolean}  opts.isByok       Whether BYOK is enabled/intended for this user.
 * @param {object}   [opts.byokSettings] Raw BYOK settings row (may be null).
 * @param {function} opts.decryptKey   Decrypts a stored BYOK key ciphertext.
 * @param {string}   [opts.sharedDefaultKey] Admin-selected shared default model key.
 * @param {string}   [opts.userOverrideKey] Admin-set per-user pin (users.chat_model_override).
 *   OPTIONAL: omitting it reproduces the pre-035 resolution exactly, and it is consumed
 *   only on the shared-key path — the BYOK branch below never reads it, which is what
 *   makes "BYOK wins" and "byok_misconfigured never falls back" structural (FR-003).
 * @returns {{ model, def, provider } | { error: 'byok_misconfigured', provider: string|null } | { error: 'assistant_not_configured' } | null}
 *   Resolved model; the misconfig signal when BYOK is on but unresolvable; the
 *   not-configured signal when BYOK is off and no provider holds a shared server key;
 *   or null if the shared model cannot be instantiated at all.
 */
function resolveChatModel({ isByok, byokSettings, decryptKey, sharedDefaultKey, userOverrideKey }) {
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

  const modelKey = resolveUserChatModelKey(userOverrideKey, sharedDefaultKey);
  // No shared server key can back this turn (a self-hosted instance started without
  // any assistant key, and the user has no BYOK key). Reject before instantiating a
  // client: calling the provider without a key only fails later as `internal`.
  if (!isSharedEligible(modelKey)) return { error: 'assistant_not_configured' };
  const resolved = resolveModel(modelKey);
  if (resolved) return resolved;

  console.error(`[Chat API] Unknown model key "${modelKey}", falling back to "${DEFAULT_MODEL_KEY}"`);
  return resolveModel(DEFAULT_MODEL_KEY);
}

// isSharedEligible is exported so the admin write-time validation and this
// module's resolution-time fallback are literally the same predicate (035 FR-005).
module.exports = { resolveModel, resolveModelWithKey, resolveChatModel, resolveSharedDefaultKey, resolveUserChatModelKey, isSharedEligible, hasUsableSharedModel, getAvailableModels, getCompactionModel, getContextualizerModel, getThinkingSummaryModels, getProvider, buildProviderOptions, tagLastMessageWithCache, stripProviderExecutedTools, stripReasoningParts, shouldStripReasoningFromHistory, stripUiOnlyDiffParts, DEFAULT_MODEL_KEY, MODEL_DEFS };
