/**
 * ByokContext.assistantUnavailable: derived from the server's assistantAvailable
 * flag on GET/PUT /api/settings/byok. Saving a BYOK setup in Settings flips it
 * with no reload, because the PUT response replaces the shared settings.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockApi = { get: vi.fn(), put: vi.fn() };
vi.mock('../AuthContext', () => ({ useAuth: () => ({ api: mockApi }) }));

const { ByokProvider, useByok } = await import('../ByokContext');

const wrapper = ({ children }) => <ByokProvider>{children}</ByokProvider>;

describe('ByokContext assistantUnavailable', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.put.mockReset();
  });

  it('is false while loading, then true when the server says no key is usable', async () => {
    let resolveGet;
    mockApi.get.mockReturnValue(new Promise((r) => { resolveGet = r; }));
    const { result } = renderHook(() => useByok(), { wrapper });
    expect(result.current.assistantUnavailable).toBe(false); // never flashes the setup state

    await act(async () => { resolveGet({ data: { enabled: false, assistantAvailable: false } }); });
    expect(result.current.assistantUnavailable).toBe(true);
  });

  it('clears as soon as a saved BYOK setup makes the assistant available', async () => {
    mockApi.get.mockResolvedValue({ data: { enabled: false, assistantAvailable: false } });
    mockApi.put.mockResolvedValue({ data: { enabled: true, modelKey: 'claude-sonnet', assistantAvailable: true } });
    const { result } = renderHook(() => useByok(), { wrapper });
    await waitFor(() => expect(result.current.assistantUnavailable).toBe(true));

    await act(async () => { await result.current.saveSettings({ enabled: true }); });
    expect(result.current.assistantUnavailable).toBe(false);
  });

  it('treats a failed fetch or an older server (no flag) as available', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useByok(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.assistantUnavailable).toBe(false);

    mockApi.get.mockResolvedValueOnce({ data: { enabled: false } });
    const second = renderHook(() => useByok(), { wrapper });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.assistantUnavailable).toBe(false);
  });
});
