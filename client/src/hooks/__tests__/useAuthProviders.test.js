/**
 * Feature 059 (T048): useAuthProviders shares one request per page load and
 * falls back to the team-mode Google response on any failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useAuthProviders, { GOOGLE_FALLBACK } from '../useAuthProviders';
import { stubProviders, LOCAL_PROVIDERS } from '../../test/providers';

describe('useAuthProviders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts loading, then is ready with the server body', async () => {
    stubProviders(LOCAL_PROVIDERS);
    const { result } = renderHook(() => useAuthProviders());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.info).toEqual(LOCAL_PROVIDERS);
  });

  it('two components share one request', async () => {
    const fetchMock = stubProviders(LOCAL_PROVIDERS);
    const a = renderHook(() => useAuthProviders());
    const b = renderHook(() => useAuthProviders());
    await waitFor(() => expect(a.result.current.status).toBe('ready'));
    await waitFor(() => expect(b.result.current.status).toBe('ready'));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/providers'))).toHaveLength(1);
  });

  it('a network failure gives status error and the Google fallback', async () => {
    stubProviders('fail');
    const { result } = renderHook(() => useAuthProviders());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.info).toEqual(GOOGLE_FALLBACK);
  });

  it('an unexpected body (or a non-200) also falls back', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ name: 'not providers' }) })));
    const { result } = renderHook(() => useAuthProviders());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.info.mode).toBe('team');
  });
});
