/**
 * Tests for provider-specific streamText options:
 * - buildProviderOptions: anthropic prompt caching vs google thinking config
 * - tagLastMessageWithCache: adds an ephemeral cache breakpoint to the last
 *   message without mutating the input array.
 */
const { buildProviderOptions, tagLastMessageWithCache } = require('../api/chat-models');

describe('buildProviderOptions', () => {
  test('returns anthropic ephemeral cacheControl for anthropic provider', () => {
    const opts = buildProviderOptions({ provider: 'anthropic' });
    expect(opts).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
    });
    expect(opts.google).toBeUndefined();
  });

  test('returns google thinking config for google provider', () => {
    const opts = buildProviderOptions({ provider: 'google' });
    expect(opts).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    });
    expect(opts.anthropic).toBeUndefined();
  });

  test('returns undefined for unknown or missing provider', () => {
    expect(buildProviderOptions({ provider: 'openai' })).toBeUndefined();
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
