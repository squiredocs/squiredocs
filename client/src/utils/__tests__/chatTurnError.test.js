/**
 * Pure-derivation tests for the durable turn-error helpers (feature 025, T025).
 *
 * Covers the trailing-turn keying rule and its consequences by construction:
 * interrupted-partial keeps its banner, older stamps are inert, legacy
 * transcripts derive null, unknown codes are passed through (floored to
 * `internal` at render — D6), and `stampFailure` is additive and targets the
 * last USER message (not messages[length-1]).
 */
import { describe, it, expect } from 'vitest';
import { deriveTurnError, hasPartialReply, stampFailure } from '../chatTurnError';

const user = (text, metadata) => ({ role: 'user', parts: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) });
const assistant = (text) => ({ role: 'assistant', parts: text ? [{ type: 'text', text }] : [] });
const stamp = (code, provider, at) => ({ failure: { code, ...(provider ? { provider } : {}), ...(at ? { at } : {}) } });

describe('deriveTurnError', () => {
  it('returns null for a legacy transcript with no failure metadata (FR-016)', () => {
    expect(deriveTurnError([user('hi'), assistant('there')])).toBeNull();
  });

  it('returns null for an empty transcript / no user message', () => {
    expect(deriveTurnError([])).toBeNull();
    expect(deriveTurnError(undefined)).toBeNull();
    expect(deriveTurnError([assistant('orphan')])).toBeNull();
  });

  it('returns the record when the last user message carries a failure stamp', () => {
    const msgs = [user('hi', stamp('app_usage_limit', 'anthropic', '2026-07-21T00:00:00.000Z'))];
    expect(deriveTurnError(msgs)).toEqual({ code: 'app_usage_limit', provider: 'anthropic' });
  });

  it('drops the `at` field and defaults provider to null', () => {
    expect(deriveTurnError([user('hi', stamp('internal'))])).toEqual({ code: 'internal', provider: null });
  });

  it('keeps the banner for an interrupted partial (stamped user, assistant partial after)', () => {
    const msgs = [user('hi', stamp('provider_overloaded', 'anthropic')), assistant('partial…')];
    // Trailing message is an assistant with content, yet the stamp on the last
    // USER message must still yield a banner (US5) — position is not the discriminator.
    expect(deriveTurnError(msgs)).toEqual({ code: 'provider_overloaded', provider: 'anthropic' });
  });

  it('neutralizes when a genuine reply makes an unstamped user turn the last one', () => {
    const msgs = [user('hi', stamp('internal')), assistant('answer'), user('again'), assistant('ok')];
    expect(deriveTurnError(msgs)).toBeNull();
  });

  it('treats an older stamp deeper in the transcript as inert', () => {
    const msgs = [user('one', stamp('rate_limited')), assistant('a'), user('two'), assistant('b')];
    expect(deriveTurnError(msgs)).toBeNull();
  });

  it('passes an unknown/future code through (floored to internal at render, D6)', () => {
    expect(deriveTurnError([user('hi', stamp('some_future_code'))])).toEqual({ code: 'some_future_code', provider: null });
  });
});

describe('hasPartialReply', () => {
  it('is true when an assistant message with content follows the last user message', () => {
    expect(hasPartialReply([user('hi', stamp('internal')), assistant('partial…')])).toBe(true);
  });

  it('is false for a plain failed turn (nothing after the user message)', () => {
    expect(hasPartialReply([user('hi', stamp('internal'))])).toBe(false);
  });

  it('is false when the trailing assistant message is an empty placeholder', () => {
    expect(hasPartialReply([user('hi', stamp('internal')), assistant('')])).toBe(false);
  });

  it('is false when there is no user message', () => {
    expect(hasPartialReply([assistant('orphan')])).toBe(false);
  });
});

describe('stampFailure', () => {
  it('applies the record to the last USER message, not messages[length-1]', () => {
    const msgs = [user('hi'), assistant('partial…')];
    const out = stampFailure(msgs, { code: 'provider_overloaded', provider: 'anthropic', at: 'T' });
    expect(out[0].metadata.failure).toEqual({ code: 'provider_overloaded', provider: 'anthropic', at: 'T' });
    expect(out[1].metadata).toBeUndefined(); // the assistant partial is untouched
  });

  it('is additive — preserves sibling metadata (refs / kind)', () => {
    const msgs = [user('hi', { refs: [{ text: 'q' }], kind: 'welcome-kickoff' })];
    const out = stampFailure(msgs, { code: 'internal' });
    expect(out[0].metadata.refs).toEqual([{ text: 'q' }]);
    expect(out[0].metadata.kind).toBe('welcome-kickoff');
    expect(out[0].metadata.failure).toEqual({ code: 'internal' });
  });

  it('omits provider/at when not provided', () => {
    const out = stampFailure([user('hi')], { code: 'internal' });
    expect(out[0].metadata.failure).toEqual({ code: 'internal' });
  });

  it('does not mutate the input array or messages', () => {
    const msgs = [user('hi')];
    const out = stampFailure(msgs, { code: 'internal' });
    expect(msgs[0].metadata).toBeUndefined();
    expect(out).not.toBe(msgs);
  });

  it('is a no-op when there is no user message to stamp (FR-006)', () => {
    const msgs = [assistant('orphan')];
    expect(stampFailure(msgs, { code: 'internal' })).toBe(msgs);
  });
});
