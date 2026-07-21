/**
 * Chat models BYOK tests
 * Tests resolveModelWithKey and getAvailableModels.
 */
const { resolveModelWithKey, resolveChatModel, resolveSharedDefaultKey, getAvailableModels, DEFAULT_MODEL_KEY, MODEL_DEFS } = require('../api/chat-models');

describe('chat-models BYOK', () => {
  describe('resolveModelWithKey', () => {
    test('returns null for unknown model key', () => {
      expect(resolveModelWithKey('nonexistent', 'some-key')).toBeNull();
    });

    test('resolves an Anthropic model with a custom key', () => {
      const result = resolveModelWithKey('claude-haiku', 'sk-ant-test-key');
      expect(result).not.toBeNull();
      expect(result.def.key).toBe('claude-haiku');
      expect(result.def.provider).toBe('anthropic');
      expect(result.model).toBeDefined();
      expect(result.provider).toBeDefined();
    });

    test('resolves a Google model with a custom key', () => {
      const result = resolveModelWithKey('gemini-2.5-flash', 'AIza-test-key');
      expect(result).not.toBeNull();
      expect(result.def.key).toBe('gemini-2.5-flash');
      expect(result.def.provider).toBe('google');
      expect(result.model).toBeDefined();
    });

    test('resolves an Anthropic model with a custom key (opus)', () => {
      const result = resolveModelWithKey('claude-opus', 'sk-ant-test-key');
      expect(result).not.toBeNull();
      expect(result.def.key).toBe('claude-opus');
      expect(result.def.provider).toBe('anthropic');
    });

    test('resolves a z.ai GLM model via the openai-compatible chat model', () => {
      // z.ai speaks the OpenAI chat-completions wire format; we use
      // @ai-sdk/openai-compatible (its callable targets chat-completions and it
      // parses GLM reasoning), so the model is an OpenAICompatible chat model.
      const result = resolveModelWithKey('glm-4.6', 'zai-test-key');
      expect(result).not.toBeNull();
      expect(result.def.provider).toBe('zai');
      expect(result.model.constructor.name).toContain('Compatible');
      expect(result.model.modelId).toBe('glm-4.6');
    });

    test('resolves an OpenRouter GLM model via openai-compatible with its namespaced id', () => {
      // OpenRouter is also an OpenAI-compatible gateway; the model id is
      // namespaced (`z-ai/glm-5.2`). The provider also carries a dedicated
      // @ai-sdk/openai webSearchClient for the :online search sub-call.
      const result = resolveModelWithKey('or-glm-5.2', 'sk-or-test-key');
      expect(result).not.toBeNull();
      expect(result.def.provider).toBe('openrouter');
      expect(result.model.constructor.name).toContain('Compatible');
      expect(result.model.modelId).toBe('z-ai/glm-5.2');
      expect(typeof result.provider.webSearchClient.chat).toBe('function');
    });

    test('GLM models emit the same LanguageModel spec version streamText requires', () => {
      // Regression guard: @ai-sdk/openai-compatible@3.x jumped to spec v4, which
      // the installed `ai` rejects at streamText() ("Unsupported model version").
      // Unit tests here never call streamText, so pin GLM's spec to the version
      // the known-good @ai-sdk/openai provider emits — both must be accepted by
      // the same `ai`, so a future openai-compatible bump can't silently break it.
      const referenceSpec = require('@ai-sdk/openai')
        .createOpenAI({ apiKey: 'x' }).chat('gpt-5.4').specificationVersion;
      for (const key of ['glm-4.6', 'or-glm-5.2']) {
        expect(resolveModelWithKey(key, 'k').model.specificationVersion).toBe(referenceSpec);
      }
    });
  });

  describe('resolveChatModel', () => {
    const decryptKey = (ciphertext) => `decrypted:${ciphertext}`;

    // Feature 026 FR-005/D4: a shared default is only usable when its provider has
    // a configured server key (else resolution degrades to the built-in default).
    // The anthropic shared defaults exercised below need ANTHROPIC_API_KEY present.
    let savedAnthropicKey;
    beforeEach(() => { savedAnthropicKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; });
    afterEach(() => { if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropicKey; });

    // These tests exercise the DEFAULT_MODEL_KEY fallback, so neutralize any
    // ambient AI_CHAT_MODEL (e.g. from a developer .env) that would otherwise
    // take precedence in resolveChatModel.
    let savedChatModel;
    beforeEach(() => {
      savedChatModel = process.env.AI_CHAT_MODEL;
      delete process.env.AI_CHAT_MODEL;
    });
    afterEach(() => {
      if (savedChatModel === undefined) delete process.env.AI_CHAT_MODEL;
      else process.env.AI_CHAT_MODEL = savedChatModel;
    });

    test('uses the BYOK model + decrypted key when BYOK is active', () => {
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'claude-opus', byok_anthropic_key: 'enc-key' },
        decryptKey,
      });
      expect(result.def.key).toBe('claude-opus');
      expect(result.def.provider).toBe('anthropic');
    });

    // Feature 012 (FR-019): BYOK enabled but unresolvable must NOT silently fall
    // back to the shared server key (which would bill the operator, unmetered).
    // It returns a discriminated misconfig signal instead.
    test('BYOK enabled with an unknown model key → byok_misconfigured (no shared fallback)', () => {
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'bogus-model', byok_anthropic_key: 'enc-key' },
        decryptKey,
      });
      expect(result).toEqual({ error: 'byok_misconfigured', provider: null });
    });

    test('BYOK enabled with a known model but no stored key → byok_misconfigured, provider carried', () => {
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'gpt-5.5', byok_openai_key: null },
        decryptKey,
      });
      expect(result).toEqual({ error: 'byok_misconfigured', provider: 'openai' });
    });

    test('BYOK enabled but the key fails to decrypt → byok_misconfigured (no shared fallback)', () => {
      const throwingDecrypt = () => { throw new Error('bad ciphertext'); };
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'claude-opus', byok_anthropic_key: 'corrupt' },
        decryptKey: throwingDecrypt,
      });
      expect(result).toEqual({ error: 'byok_misconfigured', provider: 'anthropic' });
    });

    test('uses the server default when BYOK is inactive', () => {
      const result = resolveChatModel({ isByok: false, byokSettings: null, decryptKey });
      expect(result.def.key).toBe(DEFAULT_MODEL_KEY);
    });

    test('uses the admin-selected shared default when provided', () => {
      const result = resolveChatModel({
        isByok: false, byokSettings: null, decryptKey,
        sharedDefaultKey: 'claude-sonnet',
      });
      expect(result.def.key).toBe('claude-sonnet');
    });

    test('admin shared default takes precedence over AI_CHAT_MODEL', () => {
      process.env.AI_CHAT_MODEL = 'claude-haiku';
      const result = resolveChatModel({
        isByok: false, byokSettings: null, decryptKey,
        sharedDefaultKey: 'claude-sonnet',
      });
      expect(result.def.key).toBe('claude-sonnet');
    });

    test('BYOK still wins over the admin shared default', () => {
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'claude-opus', byok_anthropic_key: 'enc-key' },
        decryptKey,
        sharedDefaultKey: 'claude-sonnet',
      });
      expect(result.def.key).toBe('claude-opus');
    });

    test('falls back to DEFAULT_MODEL_KEY when the shared default key is unknown', () => {
      const result = resolveChatModel({
        isByok: false, byokSettings: null, decryptKey,
        sharedDefaultKey: 'bogus-model',
      });
      expect(result.def.key).toBe(DEFAULT_MODEL_KEY);
    });
  });

  describe('resolveSharedDefaultKey', () => {
    // Feature 026 FR-005/D4: each candidate (stored key, then AI_CHAT_MODEL) must be
    // shared-eligible — a known entry whose provider has a server key — to be used.
    // These precedence tests use anthropic models, so ANTHROPIC_API_KEY must be set;
    // the ineligible-degradation behavior is covered in chat-models.test.js (026).
    let savedChatModel, savedAnthropicKey;
    beforeEach(() => {
      savedChatModel = process.env.AI_CHAT_MODEL;
      savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.AI_CHAT_MODEL;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    });
    afterEach(() => {
      if (savedChatModel === undefined) delete process.env.AI_CHAT_MODEL;
      else process.env.AI_CHAT_MODEL = savedChatModel;
      if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    });

    test('prefers the stored key', () => {
      process.env.AI_CHAT_MODEL = 'claude-haiku';
      expect(resolveSharedDefaultKey('claude-sonnet')).toBe('claude-sonnet');
    });

    test('falls back to AI_CHAT_MODEL when no stored key', () => {
      process.env.AI_CHAT_MODEL = 'claude-haiku';
      expect(resolveSharedDefaultKey(null)).toBe('claude-haiku');
    });

    test('falls back to DEFAULT_MODEL_KEY when nothing is set', () => {
      expect(resolveSharedDefaultKey(null)).toBe(DEFAULT_MODEL_KEY);
    });
  });

  describe('getAvailableModels', () => {
    test('returns every model', () => {
      const models = getAvailableModels();
      expect(models.length).toBe(MODEL_DEFS.length);
    });

    test('exposes key, label, provider, and modelId for each model', () => {
      const models = getAvailableModels();
      for (const m of models) {
        expect(typeof m.key).toBe('string');
        expect(typeof m.label).toBe('string');
        expect(typeof m.provider).toBe('string');
        expect(typeof m.modelId).toBe('string');
      }
    });
  });
});
