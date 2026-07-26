/**
 * Feature 035 — per-user chat model override: the resolution seam.
 *
 * Pure unit tests (no DB, no provider calls) over the precedence chain:
 *
 *   active BYOK choice → users.chat_model_override → admin shared default
 *   → AI_CHAT_MODEL → DEFAULT_MODEL_KEY
 *
 * The expensive invariants live here, not in the admin API: BYOK wins outright,
 * `byok_misconfigured` never falls back to the override or the shared key, a
 * stale override never fails a turn, and omitting the new parameter reproduces
 * today's behavior exactly.
 *
 * Env-var save/restore + console.warn spy pattern follows the neighbouring
 * chat-models.test.js (feature 026).
 */

const {
  resolveUserChatModelKey,
  resolveSharedDefaultKey,
  resolveChatModel,
  isSharedEligible,
  DEFAULT_MODEL_KEY,
} = require('../chat-models');

// Two anthropic keys — always eligible in these tests (ANTHROPIC_API_KEY is set
// in beforeEach) and distinct from the terminal DEFAULT_MODEL_KEY fallback, so a
// passing assertion can't be an accident of the fallback chain.
const PIN = 'claude-haiku';
const SHARED = 'claude-sonnet';
// A gateway key whose eligibility is controlled by OPENROUTER_API_KEY.
const GATEWAY_PIN = 'or-glm-4.7';

let savedAnthropic, savedOR, savedEnvOverride;
beforeEach(() => {
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  savedOR = process.env.OPENROUTER_API_KEY;
  savedEnvOverride = process.env.AI_CHAT_MODEL;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; // claude-* entries eligible
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_CHAT_MODEL;
});
afterEach(() => {
  const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('ANTHROPIC_API_KEY', savedAnthropic);
  restore('OPENROUTER_API_KEY', savedOR);
  restore('AI_CHAT_MODEL', savedEnvOverride);
});

describe('035 FR-002 — resolveUserChatModelKey precedence', () => {
  test('an eligible override beats the admin shared default', () => {
    expect(resolveUserChatModelKey(PIN, SHARED)).toBe(PIN);
  });

  test('no override (null) resolves the shared-default chain', () => {
    expect(resolveUserChatModelKey(null, SHARED)).toBe(resolveSharedDefaultKey(SHARED));
    expect(resolveUserChatModelKey(null, SHARED)).toBe(SHARED);
  });

  test('no override (undefined) resolves the shared-default chain', () => {
    expect(resolveUserChatModelKey(undefined, SHARED)).toBe(SHARED);
  });

  test('an empty-string override is treated as no override', () => {
    expect(resolveUserChatModelKey('', SHARED)).toBe(SHARED);
  });

  test('no override and no shared default falls through to the built-in default', () => {
    expect(resolveUserChatModelKey(null, null)).toBe(DEFAULT_MODEL_KEY);
  });

  test('an override equal to the current shared default is still honored (pinned, not a no-op)', () => {
    // Spec Edge Cases: pinning the current default means the user will NOT follow
    // future shared-default changes until the pin is cleared. Proven by the pair.
    expect(resolveUserChatModelKey(SHARED, SHARED)).toBe(SHARED);
    expect(resolveUserChatModelKey(SHARED, PIN)).toBe(SHARED);
  });

  test('a falsy override emits no new warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resolveUserChatModelKey(null, SHARED);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('an eligible override emits no warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resolveUserChatModelKey(PIN, SHARED);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('035 — resolveChatModel consumes the override on the shared path', () => {
  const sharedArgs = {
    isByok: false,
    byokSettings: null,
    decryptKey: () => { throw new Error('decrypt must not be called on the shared path'); },
  };

  test('an eligible override selects that model for the turn', () => {
    const resolved = resolveChatModel({ ...sharedArgs, sharedDefaultKey: SHARED, userOverrideKey: PIN });
    expect(resolved.error).toBeUndefined();
    expect(resolved.def.key).toBe(PIN);
  });

  test('a null override serves the shared default', () => {
    const resolved = resolveChatModel({ ...sharedArgs, sharedDefaultKey: SHARED, userOverrideKey: null });
    expect(resolved.def.key).toBe(SHARED);
  });

  test('regression: omitting userOverrideKey reproduces today\'s resolution exactly', () => {
    const withParam = resolveChatModel({ ...sharedArgs, sharedDefaultKey: SHARED, userOverrideKey: undefined });
    const without = resolveChatModel({ ...sharedArgs, sharedDefaultKey: SHARED });
    expect(without.def.key).toBe(resolveSharedDefaultKey(SHARED));
    expect(without.def.key).toBe(withParam.def.key);
    expect(without.def.provider).toBe(withParam.def.provider);
  });
});

describe('035 FR-004/US2 — the shared default stays dynamic (no snapshot)', () => {
  test('with no override, changing the shared default changes the next resolution', () => {
    expect(resolveUserChatModelKey(null, SHARED)).toBe(SHARED);
    expect(resolveUserChatModelKey(null, PIN)).toBe(PIN);
    expect(resolveUserChatModelKey(null, 'claude-opus-5')).toBe('claude-opus-5');
  });

  test('with an override set, changing the shared default does not move the user', () => {
    expect(resolveUserChatModelKey(PIN, SHARED)).toBe(PIN);
    expect(resolveUserChatModelKey(PIN, 'claude-opus-5')).toBe(PIN);
  });

  test('SC-003: after clearing, the user gets the CURRENT shared default, not the one in force when pinned', () => {
    const defaultWhenPinned = SHARED;
    expect(resolveUserChatModelKey(PIN, defaultWhenPinned)).toBe(PIN);

    // Admin changes the shared default while the pin is in force …
    const newDefault = 'claude-opus-5';
    expect(resolveUserChatModelKey(PIN, newDefault)).toBe(PIN);

    // … then clears the pin: the very next turn runs on the NEW default.
    expect(resolveUserChatModelKey(null, newDefault)).toBe(newDefault);
    expect(resolveUserChatModelKey(null, newDefault)).not.toBe(defaultWhenPinned);
  });

  test('with no override, the resolution follows the env/built-in fallbacks too', () => {
    process.env.AI_CHAT_MODEL = PIN;
    expect(resolveUserChatModelKey(null, null)).toBe(PIN);
    delete process.env.AI_CHAT_MODEL;
    expect(resolveUserChatModelKey(null, null)).toBe(DEFAULT_MODEL_KEY);
  });
});

describe('035 FR-006/US3-3 — a stale override degrades quietly, never fails a turn', () => {
  test('a known override whose provider lost its shared key falls back with exactly one warning', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(resolveUserChatModelKey(GATEWAY_PIN, SHARED)).toBe(GATEWAY_PIN); // eligible now

    delete process.env.OPENROUTER_API_KEY; // key withdrawn from the deployment
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUserChatModelKey(GATEWAY_PIN, SHARED)).toBe(SHARED);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(GATEWAY_PIN);
    warn.mockRestore();
  });

  test('an unknown override key (removed in a later release) falls back with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUserChatModelKey('ghost-model', SHARED)).toBe(SHARED);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ghost-model');
    warn.mockRestore();
  });

  test('RBD-2: eligibility is re-evaluated per call — restoring the provider key resumes the override', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUserChatModelKey(GATEWAY_PIN, SHARED)).toBe(SHARED); // ineligible
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(resolveUserChatModelKey(GATEWAY_PIN, SHARED)).toBe(GATEWAY_PIN); // resumes, no admin action
    warn.mockRestore();
  });

  test('SC-004: a stale override still resolves a usable model on the serving path — never null, never a throw', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const stale of ['ghost-model', GATEWAY_PIN, 'gpt-5.6-sol' /* known, BYOK-only provider */]) {
      const resolved = resolveChatModel({
        isByok: false,
        byokSettings: null,
        decryptKey: () => { throw new Error('decrypt must not be called on the shared path'); },
        sharedDefaultKey: SHARED,
        userOverrideKey: stale,
      });
      expect(resolved).toBeTruthy();
      expect(resolved.error).toBeUndefined();
      expect(resolved.def.key).toBe(SHARED);
    }
    warn.mockRestore();
  });

  test('a known key whose provider has NO shared key at all (BYOK-only) is ineligible as an override', () => {
    // openai/zai carry serverKeyEnv: null — they can never back a shared-key turn.
    expect(isSharedEligible('gpt-5.6-sol')).toBe(false);
    expect(isSharedEligible('glm-5.2')).toBe(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUserChatModelKey('gpt-5.6-sol', SHARED)).toBe(SHARED);
    warn.mockRestore();
  });
});

describe('035 FR-003/SC-006 — BYOK invariants under a stored override', () => {
  test('(a) an active-BYOK user with a stored override runs on THEIR key and model — the override is dormant', () => {
    const resolved = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'claude-sonnet-5', byok_anthropic_key: 'ciphertext' },
      decryptKey: (ct) => `user-key-from:${ct}`,
      sharedDefaultKey: SHARED,
      // A perfectly valid, eligible override — it must have no effect at all.
      userOverrideKey: PIN,
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.def.key).toBe('claude-sonnet-5');
    expect(resolved.def.key).not.toBe(PIN);
    expect(resolved.def.key).not.toBe(SHARED);
  });

  test('(b) byok_misconfigured NEVER falls back to the override or the shared default', () => {
    // BYOK on, key missing → the loud error, even though BOTH a valid override and
    // a valid shared default exist. A fallback here would bill the operator's key.
    const missingKey = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'claude-sonnet-5', byok_anthropic_key: null },
      decryptKey: (ct) => ct,
      sharedDefaultKey: SHARED,
      userOverrideKey: PIN,
    });
    expect(missingKey).toEqual({ error: 'byok_misconfigured', provider: 'anthropic' });

    // BYOK on, unknown model → same, with no provider to name.
    const unknownModel = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'ghost-model', byok_anthropic_key: 'ciphertext' },
      decryptKey: (ct) => ct,
      sharedDefaultKey: SHARED,
      userOverrideKey: PIN,
    });
    expect(unknownModel).toEqual({ error: 'byok_misconfigured', provider: null });

    // BYOK on, key fails to decrypt → same.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const badKey = resolveChatModel({
      isByok: true,
      byokSettings: { byok_model_key: 'claude-sonnet-5', byok_anthropic_key: 'corrupt' },
      decryptKey: () => { throw new Error('bad ciphertext'); },
      sharedDefaultKey: SHARED,
      userOverrideKey: PIN,
    });
    expect(badKey).toEqual({ error: 'byok_misconfigured', provider: 'anthropic' });
    console.error.mockRestore();
  });

  test('(b) the misconfiguration error is identical with and without a stored override (SC-006)', () => {
    const args = {
      isByok: true,
      byokSettings: { byok_model_key: 'claude-sonnet-5', byok_anthropic_key: null },
      decryptKey: (ct) => ct,
      sharedDefaultKey: SHARED,
    };
    expect(resolveChatModel({ ...args, userOverrideKey: PIN }))
      .toEqual(resolveChatModel(args));
  });

  test('US3-4: once BYOK is off, the dormant override takes effect on the next turn', () => {
    const resolved = resolveChatModel({
      isByok: false,
      byokSettings: { byok_enabled: false, byok_model_key: 'claude-sonnet-5', byok_anthropic_key: 'ciphertext' },
      decryptKey: () => { throw new Error('decrypt must not be called on the shared path'); },
      sharedDefaultKey: SHARED,
      userOverrideKey: PIN,
    });
    expect(resolved.def.key).toBe(PIN);
  });
});
