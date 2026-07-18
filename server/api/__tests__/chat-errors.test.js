/**
 * Chat error taxonomy orchestrator (feature 012).
 *
 * classify(err, ctx) is the single server-side classification point. These tests
 * pin the code/status/notification decisions per the D2 status map and the US5
 * notification-ownership contract, including the BYOK-vs-shared billing split (D3).
 */
const {
  classify, buildErrorPayload, CODES, STATUS_BY_CODE, FATAL_CODES, DEFAULT_MESSAGES,
} = require('../chat-errors');

// Provider error fixtures reused across cases.
const billing = (statusCode, message) => Object.assign(new Error(message), { statusCode, data: { error: { message } } });

describe('chat-errors classify()', () => {
  describe('app-level pre-flight conditions', () => {
    test('usage limit → app_usage_limit 402, admin credit email, no operator page', () => {
      const s = classify(null, { isUsageLimit: true });
      expect(s).toMatchObject({ code: CODES.APP_USAGE_LIMIT, status: 402, notifyAdminCredit: true, notifyOperator: false });
    });

    test('byok misconfigured → byok_misconfigured 400, provider carried, no page', () => {
      const s = classify(null, { isByokMisconfigured: true, providerId: 'openai' });
      expect(s).toMatchObject({ code: CODES.BYOK_MISCONFIGURED, status: 400, provider: 'openai', notifyOperator: false });
    });

    test('rate limited → rate_limited 429, no page', () => {
      const s = classify(null, { isRateLimited: true });
      expect(s).toMatchObject({ code: CODES.RATE_LIMITED, status: 429, notifyOperator: false });
    });

    test('image on a text-only model → model_no_image_support 400, provider carried, no page', () => {
      const s = classify(null, { isImageUnsupported: true, providerId: 'openrouter' });
      expect(s).toMatchObject({ code: CODES.MODEL_NO_IMAGE_SUPPORT, status: 400, provider: 'openrouter', notifyOperator: false });
      // A model that can't see images is a user-fixable, honest failure — the
      // payload must not leak into the operator-page path.
      expect(s.notifyAdminCredit).toBe(false);
    });

    test('usage limit wins over a provider signal', () => {
      const s = classify(billing(400, 'credit balance is too low'), { isUsageLimit: true, isByok: false, providerId: 'anthropic' });
      expect(s.code).toBe(CODES.APP_USAGE_LIMIT);
    });
  });

  describe('BYOK billing / key errors', () => {
    test('BYOK out of funds → byok_insufficient_credits 402, provider, NO operator page (FR-020)', () => {
      const s = classify(billing(400, 'credit balance is too low'), { isByok: true, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.BYOK_INSUFFICIENT_CREDITS, status: 402, provider: 'anthropic', notifyOperator: false, notifyAdminCredit: false });
    });

    test('BYOK invalid key → byok_invalid_key 400 (never 401/403), NO operator page', () => {
      const s = classify(billing(401, 'invalid x-api-key'), { isByok: true, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.BYOK_INVALID_KEY, status: 400, notifyOperator: false });
      expect(s.status).not.toBe(401);
      expect(s.status).not.toBe(403);
    });
  });

  describe('shared-server-key exhaustion (D3)', () => {
    test('shared key out of funds → user sees provider_overloaded 429, operator paged with true cause (FR-022)', () => {
      const s = classify(billing(400, 'credit balance is too low'), { isByok: false, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.PROVIDER_OVERLOADED, status: 429, provider: 'anthropic', notifyOperator: true });
      expect(s.trueCause).toMatch(/out of funds|billing|shared server key/i);
      // The user payload must NOT leak the billing cause.
      expect(buildErrorPayload(s).error).not.toMatch(/credit balance/i);
    });

    test('shared key rejected as invalid → internal 500 + operator page (server misconfig)', () => {
      const s = classify(billing(401, 'invalid x-api-key'), { isByok: false, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.INTERNAL, status: 500, notifyOperator: true });
    });
  });

  describe('provider overload (any key)', () => {
    test('overloaded → provider_overloaded 429, no page', () => {
      const s = classify(billing(529, 'Overloaded'), { isByok: true, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.PROVIDER_OVERLOADED, status: 429, notifyOperator: false });
    });
  });

  describe('internal fallback', () => {
    test('unclassifiable → internal 500 + operator page (FR-023)', () => {
      const s = classify(new Error('socket hang up'), { isByok: false, providerId: 'anthropic' });
      expect(s).toMatchObject({ code: CODES.INTERNAL, status: 500, notifyOperator: true });
    });

    test('no provider id and no app flags → internal', () => {
      const s = classify(new Error('boom'), {});
      expect(s.code).toBe(CODES.INTERNAL);
    });
  });

  describe('invariants', () => {
    test('a classified non-internal failure is never 500 (FR-006)', () => {
      const cases = [
        classify(null, { isUsageLimit: true }),
        classify(null, { isByokMisconfigured: true, providerId: 'openai' }),
        classify(null, { isRateLimited: true }),
        classify(billing(400, 'credit balance is too low'), { isByok: true, providerId: 'anthropic' }),
        classify(billing(401, 'invalid x-api-key'), { isByok: true, providerId: 'anthropic' }),
        classify(billing(529, 'Overloaded'), { isByok: true, providerId: 'anthropic' }),
      ];
      for (const s of cases) {
        expect(s.code).not.toBe(CODES.INTERNAL);
        expect(s.status).not.toBe(500);
      }
    });

    test('status map matches D2 exactly', () => {
      expect(STATUS_BY_CODE).toEqual({
        app_usage_limit: 402,
        byok_insufficient_credits: 402,
        byok_invalid_key: 400,
        byok_misconfigured: 400,
        rate_limited: 429,
        provider_overloaded: 429,
        model_no_image_support: 400,
        internal: 500,
      });
    });

    test('FATAL_CODES = every code except internal', () => {
      expect(FATAL_CODES.has(CODES.INTERNAL)).toBe(false);
      for (const code of Object.values(CODES)) {
        if (code !== CODES.INTERNAL) expect(FATAL_CODES.has(code)).toBe(true);
      }
    });
  });

  describe('buildErrorPayload', () => {
    test('omits provider when absent; always carries honest error + code', () => {
      expect(buildErrorPayload({ code: CODES.RATE_LIMITED })).toEqual({
        error: DEFAULT_MESSAGES.rate_limited, code: 'rate_limited',
      });
    });
    test('includes provider when present', () => {
      expect(buildErrorPayload({ code: CODES.BYOK_INVALID_KEY, provider: 'openai' })).toEqual({
        error: DEFAULT_MESSAGES.byok_invalid_key, code: 'byok_invalid_key', provider: 'openai',
      });
    });
    test('unknown code coerces to internal', () => {
      expect(buildErrorPayload({ code: 'bogus' }).code).toBe('internal');
    });
    test('never leaks raw provider text (FR-009)', () => {
      const payload = buildErrorPayload({ code: CODES.BYOK_INSUFFICIENT_CREDITS, provider: 'anthropic' });
      expect(payload.error).not.toMatch(/console\.anthropic|credit balance is too low/i);
    });
  });
});
