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
  });

  describe('resolveChatModel', () => {
    const decryptKey = (ciphertext) => `decrypted:${ciphertext}`;

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

    test('falls back to the server default when the BYOK model key is unknown (no throw)', () => {
      // Regression: the old inline resolver dereferenced an undefined def for an
      // unknown BYOK key and threw. It must fall through to the default instead.
      const result = resolveChatModel({
        isByok: true,
        byokSettings: { byok_model_key: 'bogus-model', byok_anthropic_key: 'enc-key' },
        decryptKey,
      });
      expect(result).not.toBeNull();
      expect(result.def.key).toBe(DEFAULT_MODEL_KEY);
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
    let savedChatModel;
    beforeEach(() => {
      savedChatModel = process.env.AI_CHAT_MODEL;
      delete process.env.AI_CHAT_MODEL;
    });
    afterEach(() => {
      if (savedChatModel === undefined) delete process.env.AI_CHAT_MODEL;
      else process.env.AI_CHAT_MODEL = savedChatModel;
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
