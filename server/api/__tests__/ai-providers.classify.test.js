/**
 * Per-provider error classification (feature 012, FR-003).
 *
 * Each provider's classifyError maps its own upstream failure shapes to a
 * taxonomy signal ('insufficient_credits' | 'invalid_key' | 'overloaded' | null).
 * These are pure functions — no network, no model instantiation.
 */
const { classifyProviderError, PROVIDERS } = require('../ai-providers');

// An AI SDK-style error carrying a numeric statusCode + a provider body.
function sdkError({ statusCode, type, message, code } = {}) {
  const err = new Error(message || 'provider error');
  if (statusCode != null) err.statusCode = statusCode;
  err.data = { error: { message, type, code } };
  return err;
}

describe('classifyProviderError', () => {
  test('unknown provider → null', () => {
    expect(classifyProviderError('nope', sdkError({ statusCode: 500 }))).toBeNull();
  });

  test('every registered provider exposes a classifyError', () => {
    for (const cfg of Object.values(PROVIDERS)) {
      expect(typeof cfg.classifyError).toBe('function');
    }
  });

  describe('anthropic', () => {
    test('400 "credit balance is too low" → insufficient_credits', () => {
      expect(classifyProviderError('anthropic', sdkError({
        statusCode: 400, type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      }))).toBe('insufficient_credits');
    });
    test('401 authentication → invalid_key', () => {
      expect(classifyProviderError('anthropic', sdkError({
        statusCode: 401, type: 'authentication_error', message: 'invalid x-api-key',
      }))).toBe('invalid_key');
    });
    test('529 overloaded → overloaded', () => {
      expect(classifyProviderError('anthropic', sdkError({
        statusCode: 529, type: 'overloaded_error', message: 'Overloaded',
      }))).toBe('overloaded');
    });
    test('429 rate limit → overloaded', () => {
      expect(classifyProviderError('anthropic', sdkError({ statusCode: 429, type: 'rate_limit_error' }))).toBe('overloaded');
    });
    test('unrelated 400 → null', () => {
      expect(classifyProviderError('anthropic', sdkError({ statusCode: 400, message: 'messages: at least one message is required' }))).toBeNull();
    });
  });

  describe('openai', () => {
    test('insufficient_quota (429) → insufficient_credits', () => {
      expect(classifyProviderError('openai', sdkError({
        statusCode: 429, code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      }))).toBe('insufficient_credits');
    });
    test('401 invalid_api_key → invalid_key', () => {
      expect(classifyProviderError('openai', sdkError({ statusCode: 401, code: 'invalid_api_key', message: 'Incorrect API key provided' }))).toBe('invalid_key');
    });
    test('plain 429 rate limit → overloaded', () => {
      expect(classifyProviderError('openai', sdkError({ statusCode: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached' }))).toBe('overloaded');
    });
  });

  describe('google', () => {
    test('RESOURCE_EXHAUSTED → insufficient_credits', () => {
      expect(classifyProviderError('google', sdkError({
        statusCode: 429, message: 'Resource has been exhausted (e.g. check quota).', code: 'RESOURCE_EXHAUSTED',
      }))).toBe('insufficient_credits');
    });
    test('API_KEY_INVALID (400) → invalid_key', () => {
      expect(classifyProviderError('google', sdkError({ statusCode: 400, message: 'API key not valid', code: 'API_KEY_INVALID' }))).toBe('invalid_key');
    });
    test('503 UNAVAILABLE → overloaded', () => {
      expect(classifyProviderError('google', sdkError({ statusCode: 503, message: 'The model is overloaded. Please try again later.' }))).toBe('overloaded');
    });
  });

  describe('zai', () => {
    test('insufficient balance → insufficient_credits', () => {
      expect(classifyProviderError('zai', sdkError({ statusCode: 429, message: 'Insufficient balance or no resource package.' }))).toBe('insufficient_credits');
    });
    test('401 → invalid_key', () => {
      expect(classifyProviderError('zai', sdkError({ statusCode: 401, message: 'Invalid API key' }))).toBe('invalid_key');
    });
    test('503 → overloaded', () => {
      expect(classifyProviderError('zai', sdkError({ statusCode: 503, message: 'service unavailable' }))).toBe('overloaded');
    });
  });

  describe('openrouter', () => {
    test('402 negative credits → insufficient_credits', () => {
      expect(classifyProviderError('openrouter', sdkError({ statusCode: 402, message: 'This request requires more credits, or fewer max_tokens.' }))).toBe('insufficient_credits');
    });
    test('401 → invalid_key', () => {
      expect(classifyProviderError('openrouter', sdkError({ statusCode: 401, message: 'No auth credentials found' }))).toBe('invalid_key');
    });
    test('429 → overloaded', () => {
      expect(classifyProviderError('openrouter', sdkError({ statusCode: 429, message: 'rate limit exceeded' }))).toBe('overloaded');
    });
  });

  test('an unrecognized error shape → null (→ internal upstream)', () => {
    expect(classifyProviderError('anthropic', new Error('socket hang up'))).toBeNull();
    expect(classifyProviderError('openai', {})).toBeNull();
  });
});
