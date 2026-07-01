/**
 * Tests for provider-specific streamText options:
 * - buildProviderOptions: anthropic prompt caching vs google thinking config
 * - tagLastMessageWithCache: adds an ephemeral cache breakpoint to the last
 *   message without mutating the input array.
 */
const { buildProviderOptions, tagLastMessageWithCache } = require('../api/chat-models');

describe('buildProviderOptions', () => {
  test('returns anthropic cacheControl + adaptive thinking for non-haiku models', () => {
    const opts = buildProviderOptions({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
    expect(opts).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral', ttl: '5m' },
        sendReasoning: true,
        thinking: { type: 'adaptive' },
        effort: 'low',
      },
    });
    expect(opts.google).toBeUndefined();
  });

  test('uses enabled+budget thinking for claude haiku (rejects adaptive)', () => {
    const opts = buildProviderOptions({ provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' });
    expect(opts.anthropic.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
    expect(opts.anthropic.effort).toBeUndefined();
    expect(opts.anthropic.cacheControl).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test('returns google thinking config for google provider', () => {
    const opts = buildProviderOptions({ provider: 'google' });
    expect(opts).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    });
    expect(opts.anthropic).toBeUndefined();
  });

  test('returns openai reasoning options (effort + summary) for openai provider', () => {
    const opts = buildProviderOptions({ provider: 'openai', modelId: 'gpt-5.4-mini' });
    expect(opts).toEqual({ openai: { reasoningEffort: 'low', reasoningSummary: 'auto' } });
    expect(opts.anthropic).toBeUndefined();
  });

  test('returns undefined for z.ai provider (GLM models send no extra options)', () => {
    expect(buildProviderOptions({ provider: 'zai', modelId: 'glm-4.6' })).toBeUndefined();
  });

  test('returns undefined for OpenRouter provider (gateway models send no extra options)', () => {
    expect(buildProviderOptions({ provider: 'openrouter', modelId: 'z-ai/glm-5.2' })).toBeUndefined();
  });

  test('returns undefined for unknown or missing provider', () => {
    expect(buildProviderOptions({ provider: 'totally-unknown' })).toBeUndefined();
    expect(buildProviderOptions(undefined)).toBeUndefined();
  });
});

describe('tagLastMessageWithCache', () => {
  const makeMessages = () => [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: [{ type: 'text', text: 'three' }] },
  ];

  test('tags only the last message with an ephemeral cache breakpoint', () => {
    const out = tagLastMessageWithCache(makeMessages());
    expect(out[out.length - 1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
    });
    expect(out[0].providerOptions).toBeUndefined();
    expect(out[1].providerOptions).toBeUndefined();
  });

  test('does not mutate the input array or its messages', () => {
    const input = makeMessages();
    const snapshot = JSON.parse(JSON.stringify(input));
    tagLastMessageWithCache(input);
    expect(input).toEqual(snapshot);
    expect(input[input.length - 1].providerOptions).toBeUndefined();
  });

  test('preserves existing providerOptions on the last message', () => {
    const input = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], providerOptions: { foo: { bar: 1 } } },
    ];
    const out = tagLastMessageWithCache(input);
    expect(out[0].providerOptions.foo).toEqual({ bar: 1 });
    expect(out[0].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test('returns the input unchanged when empty', () => {
    expect(tagLastMessageWithCache([])).toEqual([]);
  });
});
