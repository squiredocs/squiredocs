/**
 * Feature 026 — OpenRouter-backed shared default models.
 *
 * Covers the model-registry / resolution seams that are NOT owned by feature 025's
 * fenced chat.js / chat-store.js:
 *   - FR-005/D4 (+ U2): a stored (or AI_CHAT_MODEL) shared default whose provider
 *     lost its server key degrades to the built-in default instead of instantiating
 *     an unauthenticated shared client; the BYOK path is untouched.
 *   - FR-007: shared (non-BYOK) usage on a gateway entry is priced from that entry's
 *     registry pricing (the metering seam; the is_byok skip gate itself lives in the
 *     fenced chat.js and is covered by the existing chat suites).
 *   - FR-008: a BYOK OpenRouter turn resolves via the USER's key, never the shared
 *     key, even though a shared key now exists; a broken BYOK ref fails loudly.
 *   - FR-003/D5: every gateway entry ships text-only and rides the honest image path.
 */

// chat.js is imported READ-ONLY for its transcript image helper (FR-003). Mock its
// heavy import-time deps the same way the existing chat-attachments suite does.
jest.mock('../../s3-images', () => ({
  isEnabled: () => false,
  putObject: jest.fn(async () => {}),
  getObject: jest.fn(async (key) => Buffer.from('BYTES::' + key)),
  getSignedGetUrl: jest.fn(async (key) => `https://s3.example/signed/${key}`),
  cspImageSources: () => [],
}));
jest.mock('../../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'test-user' }; next(); },
}));

const {
  resolveSharedDefaultKey,
  resolveChatModel,
  getAvailableModels,
  MODEL_DEFS,
  DEFAULT_MODEL_KEY,
} = require('../chat-models');
const aiUsage = require('../../ai-usage');
const { computeCostCents } = aiUsage;
const { createPool, createTestUser, cleanupTestUser } = require('../../__tests__/helpers/db');

const GATEWAY_KEYS = ['or-kimi-k3', 'or-qwen3.7-max', 'or-qwen3.7-plus', 'or-minimax-m3',
  'or-glm-4.6', 'or-glm-4.7', 'or-glm-5', 'or-glm-5.2'];

// Save/restore the env keys these tests toggle.
let savedOR, savedAnthropic, savedEnvOverride;
beforeEach(() => {
  savedOR = process.env.OPENROUTER_API_KEY;
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  savedEnvOverride = process.env.AI_CHAT_MODEL;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; // claude-opus (terminal default) is eligible
  delete process.env.AI_CHAT_MODEL;
});
afterEach(() => {
  const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('OPENROUTER_API_KEY', savedOR);
  restore('ANTHROPIC_API_KEY', savedAnthropic);
  restore('AI_CHAT_MODEL', savedEnvOverride);
});

describe('026 FR-005/D4 — resolveSharedDefaultKey eligibility guard', () => {
  test('an eligible stored gateway default is used when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(resolveSharedDefaultKey('or-kimi-k3')).toBe('or-kimi-k3');
  });

  test('a stored gateway default degrades to the built-in default when the key is removed', () => {
    delete process.env.OPENROUTER_API_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSharedDefaultKey('or-kimi-k3')).toBe(DEFAULT_MODEL_KEY);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('an unknown stored key (removed in a later release) degrades with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSharedDefaultKey('ghost-model')).toBe(DEFAULT_MODEL_KEY);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('U2: an ineligible AI_CHAT_MODEL override also degrades to the built-in default', () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_CHAT_MODEL = 'or-kimi-k3'; // gateway key, provider now ineligible
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSharedDefaultKey(null)).toBe(DEFAULT_MODEL_KEY);
    warn.mockRestore();
  });

  test('an eligible AI_CHAT_MODEL override is honored when no stored key', () => {
    process.env.AI_CHAT_MODEL = 'claude-sonnet';
    expect(resolveSharedDefaultKey(null)).toBe('claude-sonnet');
  });
});

describe('026 FR-005 — resolveChatModel degradation (serving path)', () => {
  test('non-BYOK: a stored gateway default with the key removed serves the fallback, never an openrouter client', () => {
    delete process.env.OPENROUTER_API_KEY;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveChatModel({
      isByok: false,
      byokSettings: null,
      decryptKey: () => { throw new Error('decrypt must not be called on the shared path'); },
      sharedDefaultKey: 'or-kimi-k3',
    });
    expect(resolved).toBeTruthy();
    expect(resolved.error).toBeUndefined();
    // Degraded to the built-in Anthropic default — no unauthenticated openrouter client.
    expect(resolved.def.provider).not.toBe('openrouter');
    expect(resolved.def.key).toBe(DEFAULT_MODEL_KEY);
    console.warn.mockRestore();
  });

  test('non-BYOK: an eligible gateway default resolves the gateway model', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const resolved = resolveChatModel({
      isByok: false, byokSettings: null, decryptKey: () => 'x', sharedDefaultKey: 'or-kimi-k3',
    });
    expect(resolved.def.key).toBe('or-kimi-k3');
    expect(resolved.def.provider).toBe('openrouter');
  });

  test('FR-005 does NOT touch the BYOK path — an unresolvable BYOK turn still fails loudly', () => {
    delete process.env.OPENROUTER_API_KEY;
    const resolved = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'or-kimi-k3', byok_openrouter_key: null }, // no key stored
      decryptKey: (ct) => ct,
      sharedDefaultKey: 'or-kimi-k3',
    });
    expect(resolved).toEqual({ error: 'byok_misconfigured', provider: 'openrouter' });
  });
});

describe('026 FR-008 — BYOK OpenRouter turns route through the user key, never the shared key', () => {
  test('a BYOK openrouter turn resolves the user-selected gateway model even though a shared key exists', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-SHARED'; // shared key present
    const resolved = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'or-qwen3.7-plus', byok_openrouter_key: 'sk-or-USER' },
      decryptKey: (ct) => ct, // identity: returns the user's key
      // A DIFFERENT shared default — if the BYOK branch were skipped, we'd get this instead.
      sharedDefaultKey: 'claude-opus',
    });
    expect(resolved.error).toBeUndefined();
    // The BYOK model was resolved (proving the shared default 'claude-opus' path was NOT taken,
    // hence the shared OPENROUTER key was never used to build this client).
    expect(resolved.def.key).toBe('or-qwen3.7-plus');
    expect(resolved.def.provider).toBe('openrouter');
  });

  test('a broken BYOK ref returns byok_misconfigured with NO fallback to the shared key', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-SHARED';
    const resolved = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'or-kimi-k3', byok_openrouter_key: null },
      decryptKey: (ct) => ct,
      sharedDefaultKey: 'claude-opus',
    });
    expect(resolved).toEqual({ error: 'byok_misconfigured', provider: 'openrouter' });
  });
});

describe('026 FR-007 — shared gateway usage is priced from the entry registry pricing', () => {
  test('computeCostCents prices gateway entries from their registry pricing (not the fallback)', () => {
    // 1M input + 1M output → input + output cents. Values are the 2026-07-21 snapshot.
    expect(computeCostCents('or-kimi-k3', 1_000_000, 1_000_000)).toBe(300 + 1500);
    expect(computeCostCents('or-qwen3.7-plus', 1_000_000, 1_000_000)).toBe(32 + 128);
    // FR-009 refresh: or-glm-5 moved 60/192 → 95/255; the new pricing is what's charged.
    expect(computeCostCents('or-glm-5', 1_000_000, 1_000_000)).toBe(95 + 255);
  });

  test('each gateway entry has a positive input/output price (metering never divides by an undefined rate)', () => {
    for (const key of GATEWAY_KEYS) {
      const def = MODEL_DEFS.find((d) => d.key === key);
      expect(def).toBeTruthy();
      expect(def.pricing.input).toBeGreaterThan(0);
      expect(def.pricing.output).toBeGreaterThan(0);
    }
  });

  describe('metering persists a correctly-priced row (DB)', () => {
    let pool, userId;
    beforeAll(async () => {
      pool = createPool();
      aiUsage.init(pool);
      userId = await createTestUser(pool, `metering-026-${Date.now()}@example.com`);
    });
    afterAll(async () => {
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [userId]);
      await cleanupTestUser(pool, userId);
      await pool.end();
    });

    test('a shared (non-BYOK) gateway turn writes exactly one usage row at the entry pricing', async () => {
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [userId]);
      const cost = computeCostCents('or-kimi-k3', 1_000_000, 1_000_000); // 1800
      await aiUsage.recordUsage(userId, {
        modelKey: 'or-kimi-k3', inputTokens: 1_000_000, outputTokens: 1_000_000,
        costCents: cost, isByok: false,
      });
      const { rows } = await pool.query(
        'SELECT model_key, cost_cents, is_byok FROM ai_usage_log WHERE user_id = $1', [userId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].model_key).toBe('or-kimi-k3');
      expect(rows[0].cost_cents).toBe(cost);
      expect(rows[0].is_byok).toBe(false);
    });
  });
});

describe('026 FR-003/D5 — every gateway entry ships text-only and rides the honest image path', () => {
  test('all openrouter entries derive supportsImages === false (openrouter not in VISION_PROVIDERS)', () => {
    const models = getAvailableModels();
    const gateway = models.filter((m) => m.provider === 'openrouter');
    expect(gateway.length).toBeGreaterThanOrEqual(GATEWAY_KEYS.length);
    for (const m of gateway) expect(m.supportsImages).toBe(false);
  });

  test('a transcript with historical image parts is handled by replaceUnsupportedImageParts without crashing', () => {
    // The text-only honest path (chat.js helper, imported read-only): image parts in
    // prior turns become placeholders rather than crashing a text-only gateway model.
    const chat = require('../chat');
    const messages = [
      { role: 'user', parts: [
        { type: 'text', text: 'look at this' },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
      ] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ];
    const out = chat.replaceUnsupportedImageParts(messages);
    expect(Array.isArray(out)).toBe(true);
    // No image parts survive to be sent to a text-only model.
    const stillHasImage = out.some((m) => (m.parts || []).some(
      (p) => p.type === 'file' && String(p.mediaType || '').startsWith('image/')));
    expect(stillHasImage).toBe(false);
    // The image was swapped for an honest placeholder note, not dropped silently.
    expect(JSON.stringify(out)).toMatch(/can't view images/);
  });
});
