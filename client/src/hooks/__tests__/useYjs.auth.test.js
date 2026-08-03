/**
 * useYjs Auth Error Detection Tests
 *
 * Tests the authentication logic in useYjs:
 * - WebSocket close code detection (4401, 4403 are auth failures)
 * - Token expiry handling
 * - Generic connection failures let y-websocket retry (not treated as auth errors)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useYjs, clearYjsInstanceCache } from '../useYjs';
import { resetYjsSingletons, createControllableMockProvider } from '../../test/utils';

// Mock Yjs providers
vi.mock('y-websocket');
vi.mock('y-indexeddb');

// Test constants
const TEST_DOC_GUID = 'test-doc-12345678-1234-4123-8123-123456789abc';
// Create a parseable JWT token (isTokenExpired needs to parse the exp claim)
const _h = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
const _p = btoa(JSON.stringify({ userId: 'test', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/=/g, '');
const TEST_ACCESS_TOKEN = `${_h}.${_p}.sig`;

describe('useYjs auth error detection', () => {
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

  describe('Explicit auth close codes', () => {
    it('sets authError on close code 4401', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(4401, 'Unauthorized');
      });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('sets authError on close code 4403', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(4403, 'Forbidden');
      });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('stops reconnection attempts after auth error', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());
      mockProvider.connect.mockClear();

      act(() => {
        mockProvider._emitConnectionClose(4401, 'Unauthorized');
      });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // shouldConnect should be set to false to stop y-websocket retries
      expect(mockProvider.shouldConnect).toBe(false);
    });

    it('recovers when new token is provided after auth error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(4401, 'Unauthorized');
      });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Provide a new token
      const newP = btoa(JSON.stringify({ userId: 'test', exp: Math.floor(Date.now() / 1000) + 7200 })).replace(/=/g, '');
      rerender({ token: `${_h}.${newP}.sig` });

      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });
    });
  });

  describe('Generic close codes (network issues)', () => {
    it('does NOT set authError on close code 1006 (abnormal closure)', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1006);
      });

      await new Promise(r => setTimeout(r, 100));
      expect(result.current.authError).toBe(false);
    });

    it('does NOT set authError on close code 1008 (policy violation)', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1008, 'Policy Violation');
      });

      await new Promise(r => setTimeout(r, 100));
      expect(result.current.authError).toBe(false);
    });

    it('does NOT set authError on close code 1000 (normal closure)', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1000, 'Normal closure');
      });

      await new Promise(r => setTimeout(r, 100));
      expect(result.current.authError).toBe(false);
    });

    it('does NOT set authError on close code 1001 (going away)', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1001, 'Going Away');
      });

      await new Promise(r => setTimeout(r, 100));
      expect(result.current.authError).toBe(false);
    });

    it('increments reconnectCount on disconnect', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.reconnectCount).toBe(0);

      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(1);
      });
    });

    it('resets reconnectCount on successful connection', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate a few disconnects
      act(() => {
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.reconnectCount).toBe(2));

      // Then successful connection
      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(0);
      });
    });
  });

  describe('Token state changes', () => {
    it('sets authError when token is null', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, null));

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });
    });

    it('sets authError when token becomes null', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('clears authError when token is restored', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: null } }
      );

      await waitFor(() => expect(result.current.authError).toBe(true));

      rerender({ token: TEST_ACCESS_TOKEN });

      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });
    });

    it('creates provider but does not connect without token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, null));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.ydoc).toBeInstanceOf(Y.Doc);
      expect(result.current.provider).toBeDefined();
      expect(result.current.authError).toBe(true);
      expect(result.current.connectionState).toBe('disconnected');
    });
  });

  describe('forceReconnect', () => {
    it('provides forceReconnect function', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(typeof result.current.forceReconnect).toBe('function');
    });

    it('calls disconnect then connect on forceReconnect', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());
      await waitFor(() => expect(mockProvider.connect).toHaveBeenCalled());
      // The mount-time connect must not be what satisfies this test — that is
      // exactly how the dead-Retry regression stayed green.
      mockProvider.connect.mockClear();

      act(() => {
        result.current.forceReconnect();
      });

      expect(mockProvider.disconnect).toHaveBeenCalled();
      // Real y-websocket semantics (mirrored by the mock): disconnect() has
      // just cleared shouldConnect, so a continuation gated on that flag can
      // never fire. The reconnect must happen anyway.
      expect(mockProvider.shouldConnect).toBe(false);

      await waitFor(() => {
        expect(mockProvider.connect).toHaveBeenCalled();
      }, { timeout: 300 });
      expect(mockProvider.shouldConnect).toBe(true);
    });

    it('never connects a provider whose hook was cleaned up during the retry window', async () => {
      const { result, unmount } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());
      await waitFor(() => expect(mockProvider.connect).toHaveBeenCalled());
      mockProvider.connect.mockClear();

      act(() => {
        result.current.forceReconnect();
      });
      // The doc closes inside the 100ms gate window: the continuation must see
      // the nulled providerRef and leave the destroyed provider alone — a
      // revived socket here would have no listeners and no owner.
      unmount();

      await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
      expect(mockProvider.connect).not.toHaveBeenCalled();
      expect(mockProvider.destroy).toHaveBeenCalled();
    });

    it('clears authError on forceReconnect', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Set auth error
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Force reconnect should clear it
      act(() => {
        result.current.forceReconnect();
      });

      expect(result.current.authError).toBe(false);
    });

    it('does nothing without valid token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, null));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Clear any disconnect calls from the token effect
      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      act(() => {
        result.current.forceReconnect();
      });

      // forceReconnect should do nothing without valid token
      expect(mockProvider.connect).not.toHaveBeenCalled();
    });
  });

  describe('connection state transitions', () => {
    it('starts in connecting state', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.connectionState).toBe('connecting');
    });

    it('transitions to connected on status event', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.connected).toBe(true);
      });
    });

    it('clears authError on successful connection', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Set auth error
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Successful connection should clear it
      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });
    });
  });
});
