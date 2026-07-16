/**
 * Client chat error map + parseChatError (feature 012).
 *
 * The structured `code` is the sole discriminator (FR-013/SC-007): every code
 * resolves a distinct, actionable message; provider names come only from the
 * payload; unknown/absent codes fall back to internal.
 */
import { describe, it, expect } from 'vitest';
import {
  MESSAGES, PROVIDER_LABELS, FATAL_CODES, RETRYABLE_CODES, parseChatError,
} from '../chatErrorMessages';

const ALL_CODES = [
  'app_usage_limit', 'byok_insufficient_credits', 'byok_invalid_key',
  'byok_misconfigured', 'rate_limited', 'provider_overloaded', 'internal',
];

describe('MESSAGES map', () => {
  it('has a distinct, non-empty message + action for every code', () => {
    const seen = new Set();
    for (const code of ALL_CODES) {
      const entry = MESSAGES[code];
      expect(entry).toBeTruthy();
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.action).toBeTruthy();
      expect(seen.has(entry.text)).toBe(false);
      seen.add(entry.text);
    }
  });
});

describe('FATAL_CODES / RETRYABLE_CODES', () => {
  it('fatal = everything except internal', () => {
    expect(FATAL_CODES.has('internal')).toBe(false);
    for (const c of ALL_CODES.filter((c) => c !== 'internal')) {
      expect(FATAL_CODES.has(c)).toBe(true);
    }
  });
  it('retryable = internal + provider_overloaded only', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual(['internal', 'provider_overloaded']);
  });
});

describe('parseChatError', () => {
  it('parses a transport Error whose message is a JSON body + status (D8)', () => {
    const err = Object.assign(new Error(JSON.stringify({ error: 'nope', code: 'byok_invalid_key', provider: 'openai' })), { status: 400 });
    const parsed = parseChatError(err);
    expect(parsed).toMatchObject({ code: 'byok_invalid_key', provider: 'openai', status: 400 });
    expect(parsed.text).toContain('OpenAI');
  });

  it('parses an SSE-style structured payload object', () => {
    const parsed = parseChatError({ code: 'byok_insufficient_credits', provider: 'anthropic', error: 'x' });
    expect(parsed.code).toBe('byok_insufficient_credits');
    expect(parsed.text).toContain('Anthropic');
    expect(parsed.text).toContain('console');
  });

  it('interpolates every provider label from the payload, not client inference', () => {
    for (const [id, label] of Object.entries(PROVIDER_LABELS)) {
      const parsed = parseChatError({ code: 'byok_invalid_key', provider: id });
      expect(parsed.text).toContain(label);
    }
  });

  it('unknown provider ⇒ "your provider"', () => {
    const parsed = parseChatError({ code: 'byok_insufficient_credits', provider: 'mystery' });
    expect(parsed.text).toContain('your provider');
  });

  it('unknown code ⇒ internal fallback, showing the payload error text (FR-013)', () => {
    const parsed = parseChatError({ code: 'brand_new_code', error: 'honest server text' });
    expect(parsed.code).toBe('internal');
    expect(parsed.text).toBe('honest server text');
  });

  it('a payload with no code ⇒ internal fallback', () => {
    const parsed = parseChatError({ error: 'something' });
    expect(parsed.code).toBe('internal');
    expect(parsed.text).toBe('something');
  });

  it('a genuine internal code (no fallback) uses the friendly map copy', () => {
    const parsed = parseChatError({ code: 'internal', error: 'Internal server error' });
    expect(parsed.code).toBe('internal');
    expect(parsed.text).toBe(MESSAGES.internal.text);
  });

  it('a non-JSON transport message ⇒ internal fallback with the generic copy, NOT the raw body (L6)', () => {
    // A bare non-JSON body (e.g. a proxy "Bad Gateway") is not display text —
    // showing it leaks infrastructure noise into the chat banner.
    const parsed = parseChatError(new Error('Bad Gateway'));
    expect(parsed.code).toBe('internal');
    expect(parsed.text).toBe(MESSAGES.internal.text);
  });

  it('a raw HTML proxy error body ⇒ internal fallback with the generic copy, never the HTML (L6)', () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>';
    // Both as a transport Error and as a bare string body.
    expect(parseChatError(new Error(html)).text).toBe(MESSAGES.internal.text);
    expect(parseChatError(html).text).toBe(MESSAGES.internal.text);
    expect(parseChatError(html).code).toBe('internal');
  });

  it('a genuinely structured JSON transport body still shows its server error text (L6)', () => {
    // The complement to the HTML case: a real JSON body with an unknown code still
    // surfaces the honest server string on the internal fallback (FR-013).
    const err = new Error(JSON.stringify({ code: 'brand_new_code', error: 'honest server text' }));
    expect(parseChatError(err).text).toBe('honest server text');
  });

  it('never derives a code from free text (no substring matching)', () => {
    // A message that literally contains "usage limit" but no structured code
    // must NOT resolve to app_usage_limit.
    const parsed = parseChatError(new Error('the AI usage limit reached message'));
    expect(parsed.code).toBe('internal');
  });

  it('reads status when present on the error', () => {
    expect(parseChatError(Object.assign(new Error('{}'), { status: 402 })).status).toBe(402);
    expect(parseChatError({ code: 'internal' }).status).toBeUndefined();
  });
});
