/**
 * useYjs Bug Detection and Edge Case Tests
 *
 * Tests for edge cases and previously fixed bugs in useYjs.
 * The simplified architecture:
 * - Only explicit auth close codes (4401, 4403) set authError
 * - Generic connection failures let y-websocket retry naturally
 * - No MAX_FAILURES threshold for generic errors
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useYjs, clearYjsInstanceCache } from '../useYjs';
import { resetYjsSingletons, createControllableMockProvider } from '../../test/utils';

vi.mock('y-websocket');
vi.mock('y-indexeddb');

const TEST_DOC_GUID = 'bug-test-doc-guid';
// Create a parseable JWT token (isTokenExpired needs to parse the exp claim)
const _h = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
const _p = btoa(JSON.stringify({ userId: 'test', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/=/g, '');
const TEST_ACCESS_TOKEN = `${_h}.${_p}.sig`;
const makeToken = (extra = 0) => {
  const p2 = btoa(JSON.stringify({ userId: 'test', exp: Math.floor(Date.now() / 1000) + 3600 + extra })).replace(/=/g, '');
  return `${_h}.${p2}.sig`;
};

describe('useYjs Bug Detection', () => {
  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('FIXED: forceReconnect is debounced', () => {
    it('rapid forceReconnect calls are debounced to single cycle', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      // Rapidly call forceReconnect 3 times
      act(() => {
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // Only 1 disconnect and 1 connect should occur
      expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
      expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Generic connection failures do NOT set authError', () => {
    it('does NOT set authError for ECONNREFUSED', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate multiple connection close events with generic codes
      for (let i = 0; i < 5; i++) {
        act(() => {
          mockProvider._emitConnectionClose(1006);
        });
      }

      await new Promise(r => setTimeout(r, 100));

      // authError should NOT be set for generic errors
      expect(result.current.authError).toBe(false);
    });

    it('allows y-websocket to retry naturally on generic errors', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Generic close code should not stop y-websocket retries
      act(() => {
        mockProvider._emitConnectionClose(1006);
      });

      // shouldConnect should NOT be set to false
      expect(mockProvider.shouldConnect).not.toBe(false);
    });
  });

  describe('Token state handling', () => {
    it('sets authError when token becomes null', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });
    });

    it('clears authError when token is restored', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Set authError via explicit auth code
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      rerender({ token: null });
      await waitFor(() => expect(result.current.authError).toBe(true));

      // Restore token
      mockProvider.connect.mockClear();
      rerender({ token: makeToken(1) });

      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });

      expect(mockProvider.connect).toHaveBeenCalled();
    });
  });

  describe('Connection state after token refresh', () => {
    it('connectionState updates correctly when provider reconnects', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => expect(result.current.connectionState).toBe('connected'));

      // Disconnect
      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.connectionState).toBe('disconnected'));

      // Token refresh
      rerender({ token: makeToken(2) });

      await new Promise(r => setTimeout(r, 100));

      // Reconnect
      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
      });
    });
  });

  describe('Provider reuse', () => {
    it('reuses existing provider when token changes', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: 'token-1' } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      const firstProvider = result.current.provider;

      rerender({ token: makeToken(3) });

      await new Promise(r => setTimeout(r, 50));

      // Same provider is reused (ydoc is cached by docGuid)
      expect(result.current.provider).toBe(firstProvider);
    });
  });

  describe('forceReconnect validates token', () => {
    it('does not attempt reconnection without token', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      rerender({ token: null });
      await waitFor(() => expect(result.current.authError).toBe(true));

      mockProvider.connect.mockClear();

      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      expect(mockProvider.connect).not.toHaveBeenCalled();
    });
  });

  describe('reconnectCount tracking', () => {
    it('increments on disconnect status', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.reconnectCount).toBe(0);

      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(1);
      });

      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(2);
      });
    });

    it('resets on successful connection', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.reconnectCount).toBe(2));

      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(0);
      });
    });
  });
});

describe('Sleep/Wake Scenarios', () => {
  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();
    vi.useRealTimers();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('Extended disconnection', () => {
    it('handles reconnection after long disconnect', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Connection was established
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => expect(result.current.connected).toBe(true));

      // Long disconnect (laptop sleep)
      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.connectionState).toBe('disconnected'));

      // Token refresh happens
      rerender({ token: makeToken(4) });

      // Reconnect
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.synced).toBe(true);
      });
    });

    it('auto-recovers when token is restored after auth failure', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Auth error
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      rerender({ token: null });
      await waitFor(() => expect(result.current.authError).toBe(true));

      // Token refresh
      mockProvider.connect.mockClear();
      rerender({ token: makeToken(4) });

      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });

      expect(mockProvider.connect).toHaveBeenCalled();
    });
  });
});
