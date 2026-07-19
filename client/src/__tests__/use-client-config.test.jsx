/**
 * Feature 021 (DR-2) — kill-switch client plumbing.
 *
 * useClientConfig fetches /api/client-config once after auth and publishes
 * the flag on globalThis.__SQUIRE_COLLAB_HARDENING__. Fetch failure leaves
 * the global UNSET — the patched binding treats anything but the explicit
 * boolean false as hardened (fail-safe default ON).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useClientConfig from '../hooks/useClientConfig';
import { useAuth } from '../contexts/AuthContext';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('useClientConfig (021 kill-switch plumbing)', () => {
  beforeEach(() => {
    delete globalThis.__SQUIRE_COLLAB_HARDENING__;
  });

  afterEach(() => {
    delete globalThis.__SQUIRE_COLLAB_HARDENING__;
    vi.clearAllMocks();
  });

  it('sets the global from a successful fetch (true)', async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: { collabBindingHardening: true } }) };
    useAuth.mockReturnValue({ api, isAuthenticated: true });

    renderHook(() => useClientConfig());

    await waitFor(() => {
      expect(globalThis.__SQUIRE_COLLAB_HARDENING__).toBe(true);
    });
    expect(api.get).toHaveBeenCalledWith('/api/client-config');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('sets the global to false when the kill-switch is engaged', async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: { collabBindingHardening: false } }) };
    useAuth.mockReturnValue({ api, isAuthenticated: true });

    renderHook(() => useClientConfig());

    await waitFor(() => {
      expect(globalThis.__SQUIRE_COLLAB_HARDENING__).toBe(false);
    });
  });

  it('leaves the global unset on fetch failure (fail-safe ON)', async () => {
    const api = { get: vi.fn().mockRejectedValue(new Error('network down')) };
    useAuth.mockReturnValue({ api, isAuthenticated: true });

    renderHook(() => useClientConfig());

    await waitFor(() => {
      expect(api.get).toHaveBeenCalled();
    });
    // Give the rejected promise chain a tick to (not) write the global.
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.__SQUIRE_COLLAB_HARDENING__).toBeUndefined();
  });

  it('leaves the global unset on a malformed response (fail-safe ON)', async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: { collabBindingHardening: 'nope' } }) };
    useAuth.mockReturnValue({ api, isAuthenticated: true });

    renderHook(() => useClientConfig());

    await waitFor(() => {
      expect(api.get).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.__SQUIRE_COLLAB_HARDENING__).toBeUndefined();
  });

  it('does not fetch before authentication', () => {
    const api = { get: vi.fn() };
    useAuth.mockReturnValue({ api, isAuthenticated: false });

    renderHook(() => useClientConfig());

    expect(api.get).not.toHaveBeenCalled();
    expect(globalThis.__SQUIRE_COLLAB_HARDENING__).toBeUndefined();
  });
});
