/**
 * Chat models BYOK tests
 * Tests resolveModelWithKey and getAvailableModels.
 */
const { resolveModelWithKey, resolveChatModel, getAvailableModels, DEFAULT_MODEL_KEY, MODEL_DEFS } = require('../api/chat-models');

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
