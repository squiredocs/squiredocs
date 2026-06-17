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

    test('resolves BYOK-only models', () => {
      const result = resolveModelWithKey('claude-opus', 'sk-ant-test-key');
      expect(result).not.toBeNull();
      expect(result.def.byokOnly).toBe(true);
    });
  });

  describe('resolveChatModel', () => {
    const decryptKey = (ciphertext) => `decrypted:${ciphertext}`;

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
    test('returns all models', () => {
      const models = getAvailableModels({});
      expect(models.length).toBe(MODEL_DEFS.length);
    });

    test('marks non-BYOK models as available without keys', () => {
      const models = getAvailableModels({});
      const freeModels = models.filter(m => !m.byokOnly);
      for (const m of freeModels) {
        expect(m.available).toBe(true);
      }
    });

    test('marks BYOK-only models as unavailable without keys', () => {
      const models = getAvailableModels({});
      const byokModels = models.filter(m => m.byokOnly);
      expect(byokModels.length).toBeGreaterThan(0);
      for (const m of byokModels) {
        expect(m.available).toBe(false);
      }
    });

    test('marks Anthropic BYOK models available with Anthropic key', () => {
      const models = getAvailableModels({ anthropic: true });
      const anthropicByok = models.filter(m => m.byokOnly && m.provider === 'anthropic');
      for (const m of anthropicByok) {
        expect(m.available).toBe(true);
      }
      // Google BYOK should still be unavailable
      const googleByok = models.filter(m => m.byokOnly && m.provider === 'google');
      for (const m of googleByok) {
        expect(m.available).toBe(false);
      }
    });

    test('includes label for each model', () => {
      const models = getAvailableModels({});
      for (const m of models) {
        expect(m.label).toBeDefined();
        expect(typeof m.label).toBe('string');
      }
    });
  });
});
