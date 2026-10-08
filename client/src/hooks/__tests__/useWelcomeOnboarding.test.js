/**
 * Welcome onboarding gate: the hidden kickoff is sent only when the assistant can
 * answer. With no usable key (self-hosted, no server key, no BYOK) the panel opens
 * on its setup state instead (self-host v1.0.0 first-user finding).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let mockByok = { loading: false, assistantUnavailable: false };
vi.mock('../../contexts/ByokContext', () => ({
  useByok: () => mockByok,
}));

const { useWelcomeOnboarding } = await import('../useWelcomeOnboarding');

const route = { view: 'editor', docGuid: 'abc-123' };

describe('useWelcomeOnboarding', () => {
  let openPanel;
  let sendWelcomeMessage;

  beforeEach(() => {
    openPanel = vi.fn();
    sendWelcomeMessage = vi.fn();
    mockByok = { loading: false, assistantUnavailable: false };
    // The test setup replaces window.location with a plain object, so set the
    // query directly and watch replaceState for the flag being stripped.
    window.location.search = '?welcome=1';
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    delete window.location.search;
    vi.restoreAllMocks();
  });

  const stripped = () => expect(window.history.replaceState).toHaveBeenCalledWith({}, '', '/d/abc-123');

  const run = () => renderHook(() => useWelcomeOnboarding({ route, openPanel, sendWelcomeMessage }));

  it('opens the panel and sends the kickoff when the assistant is available', () => {
    run();
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(sendWelcomeMessage).toHaveBeenCalledTimes(1);
    stripped();
  });

  it('opens the panel on its setup state and sends NO kickoff when no key is usable', () => {
    mockByok = { loading: false, assistantUnavailable: true };
    run();
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
    stripped();
  });

  it('waits for the BYOK settings before deciding', () => {
    mockByok = { loading: true, assistantUnavailable: false };
    const { rerender } = run();
    expect(openPanel).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();

    mockByok = { loading: false, assistantUnavailable: true };
    rerender();
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('does nothing without the welcome flag', () => {
    window.location.search = '';
    run();
    expect(openPanel).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });
});
